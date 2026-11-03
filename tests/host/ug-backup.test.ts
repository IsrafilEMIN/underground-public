import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

// The arena backup job (docs/SPEC.md, B10), run against a fake restic that records each call and
// exits with the code a test plants. The tests try to get a failed backup recorded as a good one,
// the owner's ssh agent or a wrong key into the remote call, or the keep rule run on every pass.

const SRC = join(import.meta.dirname, "../..");
const JOB = join(SRC, "host/bin/ug-backup");
const versions = await readFile(join(SRC, "VERSIONS"), "utf8");
const RESTIC_PIN = /^restic=(.+)$/m.exec(versions)?.[1] ?? "";

const FAKE_RESTIC = `#!/bin/sh
{ printf 'ARGS:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; printf 'PW:%s\\n' "$RESTIC_PASSWORD_FILE"; printf 'SSH:%s\\n' "\${SSH_AUTH_SOCK:-}"; } >>"$HOME/restic-calls"
case " $* " in *" backup "*) step=backup ;; *" forget "*) step=forget ;; *) step=other ;; esac
code=$(cat "$HOME/exit-$step" 2>/dev/null) || code=0
exit "$code"
`;

async function fakeHome({ password = true } = {}) {
  const home = await tempDir(join(tmpdir(), "ug-backup-"));
  const dir = join(home, ".ug/sys/restic", RESTIC_PIN);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "restic"), FAKE_RESTIC);
  await chmod(join(dir, "restic"), 0o755);
  await mkdir(join(home, ".ug/host/backup/repo"), { recursive: true });
  await mkdir(join(home, ".ug/home"), { recursive: true });
  if (password) await writeFile(join(home, ".ug/host/backup/password"), "pw\n");
  return home;
}

function run(home: string) {
  const r = spawnSync("bash", [JOB], {
    env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SSH_AUTH_SOCK: "/tmp/owner-agent.sock" },
    encoding: "utf8",
    timeout: 30_000,
  });
  return r;
}

async function calls(home: string): Promise<string[]> {
  if (!existsSync(join(home, "restic-calls"))) return [];
  return (await readFile(join(home, "restic-calls"), "utf8")).split("\n").filter((l) => l.startsWith("ARGS:"));
}

const backupDir = (home: string) => join(home, ".ug/host/backup");

test("ug-backup backs up the arena and the host zone, but not the repos or rebuildable folders, and records the time", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  const [backup, forget] = await calls(home);
  assert.ok(backup.includes(`[-r] [${join(backupDir(home), "repo")}]`), backup);
  assert.ok(backup.includes(" [backup] "), backup);
  assert.ok(backup.endsWith(`[${join(home, ".ug/home")}] [${join(home, ".ug/host")}]`), backup);
  for (const left of [backupDir(home), join(home, ".ug/home/tmp"), join(home, ".ug/home/.omp/agent/cache"), "node_modules"]) {
    assert.ok(backup.includes(`[--exclude] [${left}]`), `${left} is not left out: ${backup}`);
  }
  assert.match(await readFile(join(home, "restic-calls"), "utf8"), new RegExp(`^PW:${join(backupDir(home), "password")}$`, "m"));
  assert.ok(forget.includes("[--keep-within] [1d] [--keep-daily] [30] [--keep-monthly] [12] [--prune]"), forget);
  const last = Number(await readFile(join(backupDir(home), "last-local"), "utf8"));
  assert.ok(Math.abs(last - Date.now() / 1000) < 60, `last-local is ${last}`);
});

test("ug-backup applies the keep rule once a day, not on every run", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(home).status, 0);
  assert.equal(run(home).status, 0);
  const all = await calls(home);
  assert.equal(all.filter((c) => c.includes(" [backup] ")).length, 2);
  assert.equal(all.filter((c) => c.includes(" [forget] ")).length, 1, all.join("\n"));
  await writeFile(join(backupDir(home), "prune-local"), `${Math.floor(Date.now() / 1000) - 90_000}\n`);
  assert.equal(run(home).status, 0);
  assert.equal((await calls(home)).filter((c) => c.includes(" [forget] ")).length, 2);
});

test("ug-backup records no time for a failed backup, says why, and exits 1", async (t) => {
  for (const code of ["1", "11", "12", "130"]) {
    const home = await fakeHome();
    t.after(() => rm(home, { recursive: true, force: true }));
    await writeFile(join(backupDir(home), "last-local"), "1000\n");
    await writeFile(join(home, "exit-backup"), code);
    const r = run(home);
    assert.equal(r.status, 1, `exit ${code}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`backup to local .* failed with restic exit ${code}`));
    assert.equal(await readFile(join(backupDir(home), "last-local"), "utf8"), "1000\n", `exit ${code} was recorded as good`);
    assert.equal((await calls(home)).filter((c) => c.includes(" [forget] ")).length, 0, `exit ${code}: the keep rule ran after a failed backup`);
  }
});

test("ug-backup counts a backup with some unreadable files (restic exit 3) and says so", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "exit-backup"), "3");
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /some files could not be read/);
  assert.ok(existsSync(join(backupDir(home), "last-local")));
});

test("ug-backup keeps the old prune time when the keep rule fails, so the next run tries again", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "exit-forget"), "1");
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /keep rule on local failed/);
  assert.equal(existsSync(join(backupDir(home), "prune-local")), false);
  assert.ok(existsSync(join(backupDir(home), "last-local")));
});

test("ug-backup sends the remote backup over sftp with its own key only, and turns the ssh agent off", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(backupDir(home), "remote"), "sftp:owner@v100-server:backups/mac-arena\n");
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  const remote = (await calls(home)).find((c) => c.includes("[sftp:owner@v100-server:backups/mac-arena]") && c.includes(" [backup] ")) ?? "";
  assert.ok(remote, (await calls(home)).join("\n"));
  const command = /\[sftp\.command=([^\]]*)\]/.exec(remote)?.[1] ?? "";
  assert.match(command, new RegExp(`^ssh -i ${join(backupDir(home), "ssh_key")} -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes `));
  assert.match(command, / owner@v100-server -s sftp$/);
  assert.ok(existsSync(join(backupDir(home), "last-remote")));
});

test("ug-backup skips a malformed remote line, still backs up locally, and says so", async (t) => {
  for (const line of ["owner@v100-server:backups", "sftp:v100-server", "s3:bucket/path", ""]) {
    const home = await fakeHome();
    t.after(() => rm(home, { recursive: true, force: true }));
    await writeFile(join(backupDir(home), "remote"), `${line}\n`);
    const r = run(home);
    assert.equal(r.status, 0, `${line}: ${r.stderr}`);
    assert.match(r.stderr, /must hold one line sftp:/, line);
    const all = await calls(home);
    assert.equal(all.filter((c) => c.includes(" [backup] ")).length, 1, `${line}: ${all.join("\n")}`);
    assert.equal(existsSync(join(backupDir(home), "last-remote")), false, line);
  }
});

test("ug-backup records local even when the remote fails, and exits 1 for the remote", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(backupDir(home), "remote"), "sftp:owner@v100-server:backups/mac-arena\n");
  // The fake fails only the remote call: one backup call with the sftp repo.
  const dir = join(home, ".ug/sys/restic", RESTIC_PIN);
  await writeFile(join(dir, "restic"), FAKE_RESTIC.replace('code=$(cat "$HOME/exit-$step" 2>/dev/null) || code=0', 'code=0; case " $* " in *sftp:*" backup "*) code=1 ;; esac'));
  const r = run(home);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /backup to remote .* failed/);
  assert.ok(existsSync(join(backupDir(home), "last-local")));
  assert.equal(existsSync(join(backupDir(home), "last-remote")), false);
});

test("ug-backup with no password or no restic exits 1 and calls nothing", async (t) => {
  const home = await fakeHome({ password: false });
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /backup password .* is missing/);
  assert.deepEqual(await calls(home), []);
  await writeFile(join(backupDir(home), "password"), "pw\n");
  await rm(join(home, ".ug/sys/restic"), { recursive: true });
  const r2 = run(home);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /pinned restic .* is missing/);
});
