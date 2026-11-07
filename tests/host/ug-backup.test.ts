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
{ printf 'RESTIC:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; } >>"$HOME/calls"
printf 'PW:%s\\n' "$RESTIC_PASSWORD_FILE" >>"$HOME/calls"
case " $* " in *" backup "*) step=backup ;; *" init "*) step=init ;; *" cat config "*) step=cat ;; *) step=other ;; esac
code=$(cat "$HOME/exit-$step" 2>/dev/null) || code=0
exit "$code"
`;

const FAKE_SSH = `#!/bin/sh
printf 'SSH: %s\\n' "$*" >>"$HOME/calls"
[ -e "$HOME/awake" ]
`;
const FAKE_WAKE = `#!/bin/sh
echo WAKE >>"$HOME/calls"
[ ! -e "$HOME/wake-fails" ] || exit 1
[ -e "$HOME/never-wakes" ] || touch "$HOME/awake"
`;
const FAKE_SLEEP = `#!/bin/sh
echo "SLEEP $*" >>"$HOME/calls"
rm -f "$HOME/awake"
`;

async function exe(path: string, text: string) {
  await writeFile(path, text);
  await chmod(path, 0o755);
}

async function fakeHome({ awake = true, password = true, config = true } = {}) {
  const home = await tempDir(join(tmpdir(), "ug-backup-"));
  const bin = join(home, "fakebin");
  await mkdir(join(home, ".ug/sys/restic", RESTIC_PIN), { recursive: true });
  await mkdir(bin);
  await exe(join(home, ".ug/sys/restic", RESTIC_PIN, "restic"), FAKE_RESTIC);
  await exe(join(bin, "ssh"), FAKE_SSH);
  await exe(join(home, "wake-rig"), FAKE_WAKE);
  await exe(join(home, "rig-sleep"), FAKE_SLEEP);
  await mkdir(join(home, ".ug/host/backup"), { recursive: true });
  await mkdir(join(home, ".ug/home"), { recursive: true });
  if (password) await writeFile(join(home, ".ug/host/backup/password"), "pw\n");
  if (config) {
    await writeFile(
      join(home, ".ug/host/backup/config"),
      `repo=sftp:kutluk@v100-server:backups/mac-arena\nwake=${join(home, "wake-rig")}\nsleep=${join(home, "rig-sleep")} now\n`,
    );
  }
  if (awake) await writeFile(join(home, "awake"), "");
  return home;
}

function run(home: string) {
  return spawnSync("bash", [JOB], {
    env: { HOME: home, PATH: `${join(home, "fakebin")}:/usr/bin:/bin`, UG_BACKUP_WAIT_TRIES: "3", UG_BACKUP_WAIT_SECONDS: "0" },
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function calls(home: string): Promise<string[]> {
  return existsSync(join(home, "calls")) ? (await readFile(join(home, "calls"), "utf8")).split("\n").filter(Boolean) : [];
}
const backups = (all: string[]) => all.filter((c) => c.startsWith("RESTIC:") && c.includes(" [backup] "));
const lastFile = (home: string) => join(home, ".ug/host/backup/last");

test("ug-backup backs up the arena, minus what can be rebuilt, into the repo, and records the time", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  const [backup] = backups(await calls(home));
  assert.ok(backup.startsWith("RESTIC: [-r] [sftp:kutluk@v100-server:backups/mac-arena] [backup]"), backup);
  assert.ok(backup.endsWith(`[${join(home, ".ug/home")}]`), backup);
  for (const left of [join(home, ".ug/home/tmp"), join(home, ".ug/home/.omp/agent/cache"), join(home, ".ug/home/.cache"), "node_modules"]) {
    assert.ok(backup.includes(`[--exclude] [${left}]`), `${left} is not left out: ${backup}`);
  }
  assert.ok((await calls(home)).includes(`PW:${join(home, ".ug/host/backup/password")}`));
  assert.ok((await calls(home)).some((c) => c === "SSH: -o BatchMode=yes -o ConnectTimeout=10 kutluk@v100-server true"));
  const last = Number(await readFile(lastFile(home), "utf8"));
  assert.ok(Math.abs(last - Date.now() / 1000) < 60, `last is ${last}`);
});

test("ug-backup keeps every snapshot: it never forgets or prunes", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  for (let i = 0; i < 3; i++) assert.equal(run(home).status, 0);
  const all = await calls(home);
  assert.equal(backups(all).length, 3);
  assert.equal(all.filter((c) => / \[(forget|prune)\]/.test(c)).length, 0, all.join("\n"));
});

test("ug-backup leaves an awake machine awake: it neither wakes nor sleeps it", async (t) => {
  const home = await fakeHome({ awake: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(home).status, 0);
  const all = await calls(home);
  assert.ok(!all.includes("WAKE"), all.join("\n"));
  assert.ok(!all.some((c) => c.startsWith("SLEEP")), `it put an awake machine to sleep:\n${all.join("\n")}`);
});

test("ug-backup wakes a sleeping machine, backs up, and puts it back to sleep with the configured words", async (t) => {
  const home = await fakeHome({ awake: false });
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  const all = await calls(home);
  const wake = all.indexOf("WAKE");
  const backup = all.findIndex((c) => c.startsWith("RESTIC:") && c.includes(" [backup] "));
  const sleep = all.indexOf("SLEEP now");
  assert.ok(wake >= 0 && backup > wake && sleep > backup, all.join("\n"));
  assert.ok(existsSync(lastFile(home)));
});

test("ug-backup puts the machine it woke back to sleep even when the backup fails, and records nothing", async (t) => {
  for (const code of ["1", "11", "12", "130"]) {
    const home = await fakeHome({ awake: false });
    t.after(() => rm(home, { recursive: true, force: true }));
    await writeFile(lastFile(home), "1000\n");
    await writeFile(join(home, "exit-backup"), code);
    const r = run(home);
    assert.equal(r.status, 1, `exit ${code}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`failed with restic exit ${code}`));
    assert.equal(await readFile(lastFile(home), "utf8"), "1000\n", `exit ${code} was recorded as good`);
    assert.ok((await calls(home)).includes("SLEEP now"), `exit ${code}: the woken machine stayed awake`);
  }
});

test("ug-backup gives up when the machine does not wake, backs up nothing, and records nothing", async (t) => {
  const home = await fakeHome({ awake: false });
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "never-wakes"), "");
  const r = run(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not answer ssh after the wake; if the mac is away from home/);
  assert.deepEqual(backups(await calls(home)), []);
  assert.equal(existsSync(lastFile(home)), false);
});

test("ug-backup stops when the wake command fails", async (t) => {
  const home = await fakeHome({ awake: false });
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "wake-fails"), "");
  const r = run(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the wake command .* failed/);
  assert.deepEqual(backups(await calls(home)), []);
});

test("ug-backup makes the repo on its first run, and backs up nothing when it cannot", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "exit-cat"), "10");
  let r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok((await calls(home)).some((c) => c.includes(" [init]")));
  assert.equal(backups(await calls(home)).length, 1);
  const home2 = await fakeHome();
  t.after(() => rm(home2, { recursive: true, force: true }));
  await writeFile(join(home2, "exit-cat"), "10");
  await writeFile(join(home2, "exit-init"), "1");
  r = run(home2);
  assert.equal(r.status, 1);
  assert.deepEqual(backups(await calls(home2)), []);
  assert.equal(existsSync(lastFile(home2)), false);
  const home3 = await fakeHome();
  t.after(() => rm(home3, { recursive: true, force: true }));
  await writeFile(join(home3, "exit-cat"), "12");
  r = run(home3);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not open \(restic exit 12\)/);
  assert.deepEqual(backups(await calls(home3)), []);
});

test("ug-backup counts a run with some unreadable files (restic exit 3) and says so", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "exit-backup"), "3");
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /some files could not be read/);
  assert.ok(existsSync(lastFile(home)));
});

test("ug-backup runs a config command as plain words, never through a shell", async (t) => {
  const home = await fakeHome({ awake: false });
  t.after(() => rm(home, { recursive: true, force: true }));
  const pwned = join(home, "pwned");
  await writeFile(
    join(home, ".ug/host/backup/config"),
    `repo=sftp:kutluk@v100-server:backups/mac-arena\nwake=${join(home, "wake-rig")};touch ${pwned}\nsleep=${join(home, "rig-sleep")} $(touch ${pwned})\n`,
  );
  run(home);
  assert.equal(existsSync(pwned), false, "the wake line ran a second command");

  for (const trick of [`$(touch ${pwned})`, `\`touch ${pwned}\``, `; touch ${pwned}`, `&& touch ${pwned}`]) {
    await rm(join(home, "awake"), { force: true });
    await writeFile(
      join(home, ".ug/host/backup/config"),
      `repo=sftp:kutluk@v100-server:backups/mac-arena\nwake=${join(home, "wake-rig")}\nsleep=${join(home, "rig-sleep")} ${trick}\n`,
    );
    run(home);
    assert.ok((await calls(home)).some((c) => c.startsWith("SLEEP ")), `${trick}: the sleep line did not run`);
    assert.equal(existsSync(pwned), false, `the sleep line ran a second command: ${trick}`);
  }
});

test("ug-backup refuses a bad config, and calls nothing", async (t) => {
  for (const [label, text] of [
    ["no repo", `wake=/bin/true\nsleep=/bin/true\n`],
    ["a repo that is not sftp", `repo=/tmp/repo\nwake=/bin/true\nsleep=/bin/true\n`],
    ["a repo with no user", `repo=sftp:v100-server:backups\nwake=/bin/true\nsleep=/bin/true\n`],
    ["an ssh option as the host", `repo=sftp:-oProxyCommand=x@h:p\nwake=/bin/true\nsleep=/bin/true\n`],
    ["an ssh option after the @", `repo=sftp:u@-oProxyCommand=x:p\nwake=/bin/true\nsleep=/bin/true\n`],
    ["a space in the repo", `repo=sftp:u@h:p q\nwake=/bin/true\nsleep=/bin/true\n`],
    ["no wake", `repo=sftp:kutluk@v100-server:b\nsleep=/bin/true\n`],
    ["no sleep", `repo=sftp:kutluk@v100-server:b\nwake=/bin/true\n`],
    ["an unknown key", `repo=sftp:kutluk@v100-server:b\nwake=/bin/true\nsleep=/bin/true\nexclude=/\n`],
    ["a line with no =", `repo=sftp:kutluk@v100-server:b\nwake=/bin/true\nsleep=/bin/true\njunk\n`],
  ] as const) {
    const home = await fakeHome();
    t.after(() => rm(home, { recursive: true, force: true }));
    await writeFile(join(home, ".ug/host/backup/config"), text);
    const r = run(home);
    assert.equal(r.status, 1, `${label}: ${r.stderr}`);
    assert.match(r.stderr, /config/, label);
    assert.deepEqual(await calls(home), [], `${label}: it called something`);
  }
});

test("ug-backup with no password, no config, or no restic exits 1 and calls nothing", async (t) => {
  for (const [label, opts, pattern] of [
    ["no password", { password: false }, /backup password .* is missing/],
    ["no config", { config: false }, /no .*backup\/config/],
  ] as const) {
    const home = await fakeHome(opts);
    t.after(() => rm(home, { recursive: true, force: true }));
    const r = run(home);
    assert.equal(r.status, 1, label);
    assert.match(r.stderr, pattern, label);
    assert.deepEqual(await calls(home), [], label);
  }
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await rm(join(home, ".ug/sys/restic"), { recursive: true });
  const r = run(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pinned restic .* is missing/);
});
