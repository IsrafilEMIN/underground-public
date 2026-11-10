import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const SRC = join(import.meta.dirname, "../..");
const JOB = join(SRC, "host/bin/ug-backup");
const versions = await readFile(join(SRC, "VERSIONS"), "utf8");
const RESTIC_PIN = /^restic=(.+)$/m.exec(versions)?.[1] ?? "";

const FAKE_RESTIC = `#!/bin/sh
line='RESTIC:'; for a in "$@"; do line="$line [$a]"; done; printf '%s\\n' "$line" >>"$HOME/calls"
case " $* " in *" --stdin-from-command "*) while [ "$1" != -- ]; do shift; done; shift; "$@" >"$HOME/stdin" || exit 1 ;; esac
exit 0
`;

const FAKE_SUDO = `#!/bin/sh
printf 'SUDO: %s\\n' "$*" >>"$HOME/calls"
[ "$1" = -n ] && shift
exec "$@"
`;

const FAKE_HELPER = `#!/bin/sh
printf 'tar-bytes\\n'
`;

const FAKE_SSH = `#!/bin/sh
printf 'SSH: %s\\n' "$*" >>"$HOME/calls"
[ -e "$HOME/awake" ]
`;
const FAKE_WAKE = `#!/bin/sh
echo WAKE >>"$HOME/calls"
touch "$HOME/awake"
`;
const FAKE_SLEEP = `#!/bin/sh
echo "SLEEP $*" >>"$HOME/calls"
`;

async function exe(path: string, text: string) {
  await writeFile(path, text);
  await chmod(path, 0o755);
}

async function fakeHome({ password = true, helper = true } = {}) {
  const home = await tempDir(join(tmpdir(), "ug-backup-"));
  const bin = join(home, "fakebin");
  const data = join(home, ".local/share/underground");
  await mkdir(join(data, "restic", RESTIC_PIN), { recursive: true });
  await mkdir(join(data, "backup"), { recursive: true });
  await mkdir(bin);
  await exe(join(data, "restic", RESTIC_PIN, "restic"), FAKE_RESTIC);
  await exe(join(bin, "ssh"), FAKE_SSH);
  await exe(join(bin, "sudo"), FAKE_SUDO);
  await exe(join(home, "wake-target"), FAKE_WAKE);
  await exe(join(home, "sleep-target"), FAKE_SLEEP);
  if (helper) await exe(join(home, "agent-home-tar"), FAKE_HELPER);
  if (password) await writeFile(join(data, "backup/password"), "pw\n");
  await writeFile(
    join(data, "backup/config"),
    `repo=sftp:owner@backup-host:backups/agent-home\nwake=${join(home, "wake-target")}\nsleep=${join(home, "sleep-target")} now\n`,
  );
  await writeFile(join(home, "awake"), "");
  return home;
}

function run(home: string) {
  return spawnSync("bash", [JOB], {
    env: {
      HOME: home,
      PATH: `${join(home, "fakebin")}:/usr/bin:/bin`,
      UG_AGENT_HOME_TAR: join(home, "agent-home-tar"),
      UG_BACKUP_WAIT_TRIES: "3",
      UG_BACKUP_WAIT_SECONDS: "0",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function calls(home: string): Promise<string[]> {
  return existsSync(join(home, "calls")) ? (await readFile(join(home, "calls"), "utf8")).split("\n").filter(Boolean) : [];
}

test("ug-backup streams the agent home through the sudo helper into restic and records the time", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  const all = await calls(home);
  const helper = join(home, "agent-home-tar");
  assert.ok(
    all.includes(
      `RESTIC: [-r] [sftp:owner@backup-host:backups/agent-home] [backup] [--quiet] [--tag] [ug-agent] [--stdin-filename] [ug-agent-home.tar] [--stdin-from-command] [--] [sudo] [-n] [${helper}]`,
    ),
  );
  assert.ok(all.includes(`SUDO: -n ${helper}`));
  assert.equal(await readFile(join(home, "stdin"), "utf8"), "tar-bytes\n");
  assert.match(await readFile(join(home, ".local/share/underground/backup/last"), "utf8"), /^\d+\n$/);
});

test("ug-backup refuses to run without the agent home reader and writes no snapshot", async (t) => {
  const home = await fakeHome({ helper: false });
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the agent home reader .* is missing; run: host\/bin\/ug-setup/);
  assert.equal((await calls(home)).filter((c) => c.includes(" [backup] ")).length, 0);
  assert.equal(existsSync(join(home, ".local/share/underground/backup/last")), false);
});

test("ug-backup refuses to run without the backup password", async (t) => {
  const home = await fakeHome({ password: false });
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the backup password .* is missing/);
  assert.equal(existsSync(join(home, ".local/share/underground/backup/last")), false);
});

test("ug-backup logs restic's own error when the repo does not open, and stores no snapshot", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await exe(
    join(home, ".local/share/underground/restic", RESTIC_PIN, "restic"),
    `#!/bin/sh\nprintf 'RESTIC: %s\\n' "$*" >>"$HOME/calls"\necho "Fatal: wrong password or no key found" >&2\nexit 12\n`,
  );
  const r = run(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not open \(restic exit 12, which can mean a wrong password\): Fatal: wrong password or no key found/);
  assert.equal((await calls(home)).filter((c) => c.includes(" backup ")).length, 0);
  assert.equal(existsSync(join(home, ".local/share/underground/backup/last")), false);
});

test("ug-backup stops at a config line it does not know, and calls no restic", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, ".local/share/underground/backup/config");
  await writeFile(config, `${await readFile(config, "utf8")}colour=blue\n`);
  const r = run(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /config: unknown key colour/);
  assert.equal((await calls(home)).filter((c) => c.startsWith("RESTIC")).length, 0);
});

test("ug-backup stops when the target does not answer after the wake, puts it back to sleep, and calls no restic", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await rm(join(home, "awake"));
  await exe(join(home, "wake-target"), `#!/bin/sh\necho WAKE >>"$HOME/calls"\n`);
  const r = run(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /owner@backup-host did not answer ssh after the wake/);
  const all = await calls(home);
  assert.ok(all.includes("SLEEP now"));
  assert.equal(all.filter((c) => c.startsWith("RESTIC")).length, 0);
});
