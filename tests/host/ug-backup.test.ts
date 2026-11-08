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
line='RESTIC:'; for a in "$@"; do line="$line [$a]"; done; printf '%s\\nPW:%s\\n' "$line" "$RESTIC_PASSWORD_FILE" >>"$HOME/calls"
case " $* " in *" backup "*) step=backup ;; *" init "*) step=init ;; *" cat config "*) step=cat ;; *) step=other ;; esac
case " $* " in *" --stdin-from-command "*) while [ "$1" != -- ]; do shift; done; shift; "$@" >"$HOME/stdin" || exit 1 ;; esac
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
  await exe(join(bin, "container"), FAKE_CONTAINER);
  await exe(join(bin, "tar"), FAKE_TAR);
  await mkdir(join(home, ".ug/host/backup"), { recursive: true });
  await withBox(home);
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
    env: { HOME: home, PATH: `${join(home, "fakebin")}:/usr/bin:/bin`, UG_BACKUP_WAIT_TRIES: "3", UG_BACKUP_WAIT_SECONDS: "0", UG_BOX_STATE: join(home, "state"), UG_BOX_LOCK_WAIT: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function calls(home: string): Promise<string[]> {
  return existsSync(join(home, "calls")) ? (await readFile(join(home, "calls"), "utf8")).split("\n").filter(Boolean) : [];
}
const backups = (all: string[]) => all.filter((c) => c.startsWith("RESTIC:") && c.includes(" [backup] "));
const lastFile = (home: string) => join(home, ".ug/host/backup/last");

test("ug-backup backs up the box home into the repo with the backup password, and records the time", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  const all = await calls(home);
  assert.equal(backups(all).length, 1, all.join("\n"));
  const [backup] = backups(all);
  assert.ok(backup.startsWith("RESTIC: [-r] [sftp:kutluk@v100-server:backups/mac-arena] [backup]"), backup);
  assert.ok(backup.includes("[--tag] [ug-box]"), backup);
  assert.ok(!all.some((c) => c.includes(".ug/home")), "the old arena folder is no longer backed up");
  assert.ok((await calls(home)).includes(`PW:${join(home, ".ug/host/backup/password")}`));
  assert.ok((await calls(home)).some((c) => c === "SSH: -o BatchMode=yes -o ConnectTimeout=10 kutluk@v100-server true"));
  const last = Number(await readFile(lastFile(home), "utf8"));
  assert.ok(Math.abs(last - Date.now() / 1000) < 60, `last is ${last}`);
});

const FAKE_CONTAINER = `#!/bin/sh
line='CONTAINER:'; for a in "$@"; do line="$line [$a]"; done; printf '%s\\n' "$line" >>"$HOME/calls"
case "$1 $2" in
  "volume list") [ ! -e "$HOME/no-volume" ] && echo ug-box-home ;;
  "list --quiet") [ -e "$HOME/box-running" ] && echo ug-box ;;
  "exec ug-box") shift 2; exec "$@" ;;
  "run --rm") while [ "$1" != ugbox:test ]; do shift; done; shift; exec "$@" ;;
esac
exit 0
`;

const FAKE_TAR = `#!/bin/sh
if [ "$1" = -x ]; then cat >"$HOME/restored"; exit 0; fi
echo TARDATA
[ ! -e "$HOME/tar-changed" ] || exit 1
[ ! -e "$HOME/tar-breaks" ] || exit 2
exit 0
`;

async function withBox(home: string, { running = false, image = true } = {}) {
  await rm(join(home, "no-volume"), { force: true });
  if (running) await writeFile(join(home, "box-running"), "");
  if (image) {
    await mkdir(join(home, ".ug/sys/box/host/lib"), { recursive: true });
    await writeFile(join(home, ".ug/sys/box/host/lib/box-image.bash"), `source "${join(SRC, "host/lib/box-image.bash")}"\nbox_image_tag() { echo ugbox:test; }\n`);
    await writeFile(join(home, ".ug/sys/box/host/lib/backup-target.bash"), `source "${join(SRC, "host/lib/backup-target.bash")}"\n`);
  } else {
    await rm(join(home, ".ug/sys/box"), { recursive: true, force: true });
  }
}

const RESTORE = join(SRC, "host/bin/ug-box-restore");
const FAKE_RESTIC_RESTORE = `#!/bin/sh
line='RESTIC:'; for a in "$@"; do line="$line [$a]"; done; printf '%s\\n' "$line" >>"$HOME/calls"
case " $* " in
  *" cat config "*) [ ! -e "$HOME/repo-closed" ] ;;
  *" snapshots "*) cat "$HOME/snapshots.json" ;;
  *" --stdin-from-command "*) [ ! -e "$HOME/prerestore-fails" ] || exit 1; while [ "$1" != -- ]; do shift; done; shift; "$@" >"$HOME/stdin" || exit 1 ;;
  *" dump "*) echo DUMPDATA; [ ! -e "$HOME/dump-fails" ] ;;
esac
`;

async function restoreHome({ volume = true } = {}) {
  const home = await fakeHome();
  await withBox(home);
  await writeFile(join(home, ".ug/sys/box/VERSIONS"), `restic=${RESTIC_PIN}\n`);
  await exe(join(home, ".ug/sys/restic", RESTIC_PIN, "restic"), FAKE_RESTIC_RESTORE);
  await writeFile(join(home, "snapshots.json"), JSON.stringify([{ id: "a".repeat(64), paths: ["/ug-box-home.tar"], tags: ["ug-box"], summary: { total_bytes_processed: 5 } }]));
  await exe(join(home, "fakebin/container"), FAKE_CONTAINER.replace('"volume list") [ ! -e "$HOME/no-volume" ] && echo ug-box-home ;;', '"volume list") [ ! -e "$HOME/no-volume" ] && echo ug-box-home ;;\n  "image list") echo docker.io/library/ugbox:test ;;'));
  if (!volume) await writeFile(join(home, "no-volume"), "");
  return home;
}

function restore(home: string, ...args: string[]) {
  return spawnSync("bash", [RESTORE, ...args], {
    env: { HOME: home, PATH: `${join(home, "fakebin")}:/usr/bin:/bin`, UG_BOX_STATE: join(home, "state"), UG_BOX_NODE: process.execPath },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("ug-box-restore saves the old home into the repo before it deletes the volume, then fills a new one from the snapshot", async (t) => {
  const home = await restoreHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = restore(home);
  assert.equal(r.status, 0, r.stderr);
  const all = await calls(home);
  const order = ["[backup] [--quiet] [--tag] [ug-box-prerestore]", "[volume] [delete] [ug-box-home]", "[volume] [create] [--opt] [size=64g] [ug-box-home]", `[dump] [${"a".repeat(64)}] [ug-box-home.tar]`].map((s) => all.findIndex((c) => c.includes(s)));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), all.join("\n"));
  assert.equal(await readFile(join(home, "stdin"), "utf8"), "TARDATA\n");
  assert.equal(await readFile(join(home, "restored"), "utf8"), "DUMPDATA\n");
  assert.ok(!existsSync(join(home, "state/ug-box/lock")));
});

test("ug-box-restore deletes nothing when the old home does not reach the repo, when the box runs, or when ug-box holds its lock", async (t) => {
  const home = await restoreHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "prerestore-fails"), "");
  let r = restore(home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nothing was deleted/);
  await rm(join(home, "prerestore-fails"));
  await writeFile(join(home, "box-running"), "");
  r = restore(home);
  assert.match(r.stderr, /the box is running/);
  await rm(join(home, "box-running"));
  await mkdir(join(home, "state/ug-box/lock"), { recursive: true });
  await writeFile(join(home, "state/ug-box/lock/pid"), String(process.pid));
  r = restore(home);
  assert.match(r.stderr, /holds its lock/);
  assert.ok(!(await calls(home)).some((c) => c.includes("[volume] [delete]")), (await calls(home)).join("\n"));
});

test("ug-box-restore clears a lock left behind by a crashed process and goes on", async (t) => {
  const home = await restoreHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "state/ug-box/lock"), { recursive: true });
  await writeFile(join(home, "state/ug-box/lock/pid"), "999999");
  const r = restore(home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(home, "state/ug-box/lock")));
});

test("ug-box-restore wakes an asleep backup target first and puts it back to sleep at the end, also when it refuses", async (t) => {
  const home = await restoreHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await rm(join(home, "awake"));
  let r = restore(home);
  assert.equal(r.status, 0, r.stderr);
  let all = await calls(home);
  assert.ok(all.indexOf("WAKE") >= 0 && all.indexOf("WAKE") < all.findIndex((c) => c.includes("[volume] [delete]")), all.join("\n"));
  assert.equal(all.at(-1), "SLEEP now", all.join("\n"));
  await writeFile(join(home, "calls"), "");
  await writeFile(join(home, "snapshots.json"), "[]");
  r = restore(home);
  assert.notEqual(r.status, 0);
  all = await calls(home);
  assert.ok(all.includes("WAKE") && all.at(-1) === "SLEEP now", all.join("\n"));
  assert.ok(!all.some((c) => c.includes("[volume]")), all.join("\n"));
});

test("ug-box-restore refuses a snapshot that holds no box home, and a repo that does not open, before any change", async (t) => {
  const home = await restoreHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "snapshots.json"), JSON.stringify([{ id: "b".repeat(64), paths: [join(home, ".ug/home")], tags: ["ug"], summary: { total_bytes_processed: 5 } }]));
  let r = restore(home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /holds ug-box-home.tar/);
  await writeFile(join(home, "snapshots.json"), JSON.stringify([{ id: "c".repeat(64), paths: ["/ug-box-home.tar"], tags: ["ug-box"], summary: { total_bytes_processed: 0 } }]));
  r = restore(home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /holds ug-box-home.tar/);
  await writeFile(join(home, "repo-closed"), "");
  r = restore(home);
  assert.match(r.stderr, /does not open/);
  assert.ok(!(await calls(home)).some((c) => c.includes("[volume]")), (await calls(home)).join("\n"));
});

test("ug-backup streams the box home out of a stopped box through the installed image", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await withBox(home);
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  const all = await calls(home);
  const reader = all.find((c) => c.startsWith("CONTAINER: [run]"));
  assert.ok(reader?.includes("[--rm] [--network] [none] [--volume] [ug-box-home:/home/agent] [ugbox:test] [sh] [-c] [tar -C /home/agent -c"), reader);
  for (const left of ["./checkouts", "./.tmp", "./.cache", "./.omp/agent/cache", "node_modules"]) {
    assert.ok(reader?.includes(`--exclude ${left} `), `${left} is not left out: ${reader}`);
  }
  const [box] = backups(all);
  assert.ok(box.includes("[--tag] [ug-box] [--stdin-filename] [ug-box-home.tar] [--stdin-from-command] [--] [container] [run]"), box);
  assert.equal(await readFile(join(home, "stdin"), "utf8"), "TARDATA\n");
  assert.ok(existsSync(lastFile(home)));
});

test("ug-backup reads a running box in place and does not mount its volume twice", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await withBox(home, { running: true });
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  const all = await calls(home);
  assert.ok(all.some((c) => c.startsWith("CONTAINER: [exec] [ug-box] [sh] [-c] [tar ")), all.join("\n"));
  assert.ok(!all.some((c) => c.startsWith("CONTAINER: [run]")), all.join("\n"));
  assert.equal(await readFile(join(home, "stdin"), "utf8"), "TARDATA\n");
});

test("ug-backup with a box home but no installed image fails, records no time, and still puts the target to sleep", async (t) => {
  const home = await fakeHome({ awake: false });
  t.after(() => rm(home, { recursive: true, force: true }));
  await withBox(home, { image: false });
  const r = run(home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no box is installed/);
  assert.ok(!existsSync(lastFile(home)));
  assert.ok((await calls(home)).some((c) => c.startsWith("SLEEP")));
});

test("ug-backup with no box home yet backs up nothing, records no time, and says why", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "no-volume"), "");
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no box home yet/);
  assert.equal(backups(await calls(home)).length, 0);
  assert.ok(!existsSync(lastFile(home)));
});

test("ug-backup without the container CLI on PATH fails and records no time, instead of a silent skip", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await rm(join(home, "fakebin/container"));
  const r = run(home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /container CLI is not on PATH/);
  assert.ok(!existsSync(lastFile(home)));
});

test("ug-backup accepts a box read where files changed under tar, and fails on any other tar error", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await withBox(home);
  await writeFile(join(home, "tar-changed"), "");
  let r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(lastFile(home)));
  await rm(lastFile(home));
  await rm(join(home, "tar-changed"));
  await writeFile(join(home, "tar-breaks"), "");
  r = run(home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /was not saved \(restic exit 1\); a failed read stores no snapshot/);
  assert.ok(!existsSync(lastFile(home)));
});

test("ug-backup takes ug-box's lock for a stopped box, releases it, and gives up when a live start holds it", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await withBox(home);
  let r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(home, "state/ug-box/lock")));
  await mkdir(join(home, "state/ug-box/lock"), { recursive: true });
  await writeFile(join(home, "state/ug-box/lock/pid"), String(process.pid));
  await writeFile(join(home, "calls"), "");
  r = run(home);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /holds its lock/);
  assert.ok(!(await calls(home)).some((c) => c.startsWith("CONTAINER: [run]")));
  await writeFile(join(home, "state/ug-box/lock/pid"), "999999");
  r = run(home);
  assert.equal(r.status, 0, r.stderr);
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
    assert.match(r.stderr, new RegExp(`was not saved \\(restic exit ${code}\\)`));
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
