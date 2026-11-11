import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { tempDir } from "../temp.ts";
import { render } from "./render.ts";

const ROOT = join(import.meta.dirname, "../..");
const AGENT = join(ROOT, "host/bin/ug-agent");
const SETUP = join(ROOT, "host/bin/ug-agent-setup");
const SESSION = join(ROOT, "host/agent/agent-session");

async function owner(t: { after: (fn: () => unknown) => void }) {
  const home = await tempDir(join(tmpdir(), "ug-agent-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await chmod(home, 0o700);
  const agentSsh = join(home, ".local/share/underground/agent-ssh");
  await mkdir(agentSsh, { recursive: true });
  await writeFile(join(agentSsh, "id_ed25519"), "key\n");
  await writeFile(join(agentSsh, "known_hosts"), "[127.0.0.1]:2222 ssh-ed25519 AAAA\n");
  const repo = join(home, "code/app");
  await mkdir(repo, { recursive: true });
  spawnSync("git", ["init", "-q", repo]);
  spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/app.git"]);
  const bin = join(home, "stubs");
  await mkdir(bin);
  await stub(bin, "nc", "exit 0");
  return { home, repo, bin };
}

async function stub(bin: string, name: string, body: string) {
  await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(bin, name), 0o755);
}

function runAgent(o: { home: string; repo: string; bin: string }, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [AGENT, ...args], {
    cwd: o.repo,
    env: { HOME: o.home, PATH: `${o.bin}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
  });
}

test("ug-agent refuses an argument outside the allowed characters, and runs nothing", async (t) => {
  const o = await owner(t);
  await stub(o.bin, "launchctl", "exit 1");
  await stub(o.bin, "ssh", `echo ran > ${join(o.home, "ssh-ran")}`);
  const r = runAgent(o, ["a b"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refused argument/);
  await assert.rejects(readFile(join(o.home, "ssh-ran")));
});

test("ug-agent refuses when the owner home is not mode 700", async (t) => {
  const o = await owner(t);
  await stub(o.bin, "launchctl", "exit 1");
  await stub(o.bin, "ssh", "exit 0");
  await chmod(o.home, 0o755);
  const r = runAgent(o, ["ls"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not mode 700/);
});

test("ug-agent says the agent sshd does not answer, and runs no ssh, when nothing listens on port 2222", async (t) => {
  const o = await owner(t);
  await stub(o.bin, "launchctl", "exit 1");
  await stub(o.bin, "nc", "exit 1");
  await stub(o.bin, "ssh", `echo ran > ${join(o.home, "ssh-ran")}`);
  const r = runAgent(o, ["ls"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /agent sshd on 127\.0\.0\.1:2222 does not answer/);
  await assert.rejects(readFile(join(o.home, "ssh-ran")));
});

test("ug-agent passes the watch's problems to ssh in UG_WARNINGS, and the stale-watch line when the watch has not run for 15 minutes", async (t) => {
  const o = await owner(t);
  await stub(o.bin, "launchctl", "exit 1");
  const log = join(o.home, "ssh-warnings");
  await stub(o.bin, "ssh", `printf '%s' "$UG_WARNINGS" > ${log}`);
  const watch = join(o.home, ".local/share/underground/watch");
  await mkdir(watch);
  const stale = `the watch has not checked the services in the last 15 minutes; see ${watch}/watch.log`;
  const launch = async () => {
    const r = runAgent(o, ["ls"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    return readFile(log, "utf8");
  };
  assert.equal(await launch(), stale);
  const now = Math.floor(Date.now() / 1000);
  await writeFile(join(watch, "status"), `at=${now - 16 * 60}\n`);
  assert.equal(await launch(), stale);
  await writeFile(join(watch, "status"), `at=${now}\nbackup: no good backup in the last 36 hours\nagent sshd: no answer on port 2222\n`);
  assert.equal(await launch(), "backup: no good backup in the last 36 hours\nagent sshd: no answer on port 2222");
  await writeFile(join(watch, "status"), `at=${now}\n`);
  assert.equal(await launch(), "");
});

const noSshd = !existsSync("/usr/sbin/sshd") && "needs /usr/sbin/sshd";

async function remoteLoginOwner(t: { after: (fn: () => unknown) => void }, dropIn: string) {
  const o = await owner(t);
  const key = join(o.home, ".local/share/underground/agent-ssh/id_ed25519");
  await rm(key);
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const included = join(o.home, "010-test.conf");
  await writeFile(included, dropIn);
  const config = join(o.home, "sshd_config");
  await writeFile(config, `Include ${included}\nPasswordAuthentication no\n`);
  await stub(o.bin, "launchctl", "exit 0");
  await stub(o.bin, "ssh", `echo ran > ${join(o.home, "ssh-ran")}`);
  return { ...o, config };
}

test("ug-agent refuses while Remote Login runs and the system sshd does not deny ugagent", { skip: noSshd }, async (t) => {
  const o = await remoteLoginOwner(t, "DenyUsers alice\n");
  const r = runAgent(o, ["ls"], { UG_SSHD_CONFIG: o.config });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /does not deny ugagent/);
  await assert.rejects(readFile(join(o.home, "ssh-ran")));
});

test("ug-agent starts while Remote Login runs and an included file denies ugagent", { skip: noSshd }, async (t) => {
  const o = await remoteLoginOwner(t, "DenyUsers alice\nDenyUsers ugagent\n");
  const r = runAgent(o, ["ls"], { UG_SSHD_CONFIG: o.config });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(join(o.home, "ssh-ran"), "utf8"), "ran\n");
});

test("ug-agent logs in as ugagent on port 2222 with the owner key, and sends UG_REPO from the cwd", async (t) => {
  const o = await owner(t);
  await stub(o.bin, "launchctl", "exit 1");
  const log = join(o.home, "ssh-argv");
  await stub(o.bin, "ssh", `printf '%s\\n' "$@" > ${log}; echo "UG_REPO=$UG_REPO" >> ${log}`);
  const r = runAgent(o, ["omp", "-p", "hi"]);
  assert.equal(r.status, 0, r.stderr);
  const argv = (await readFile(log, "utf8")).trim().split("\n");
  assert.ok(argv.includes("ugagent@127.0.0.1"), argv.join(" "));
  assert.deepEqual(argv.slice(argv.indexOf("-p"), argv.indexOf("-p") + 2), ["-p", "2222"]);
  assert.ok(argv.includes(`${o.home}/.local/share/underground/agent-ssh/id_ed25519`), argv.join(" "));
  assert.ok(argv.includes("StrictHostKeyChecking=yes"));
  assert.ok(argv.includes("SendEnv=UG_REPO"));
  assert.ok(argv.includes("SendEnv=UG_WARNINGS"));
  assert.ok(argv.includes("UG_REPO=owner/app"), argv.join(" "));
  assert.deepEqual(argv.slice(-4, -1), ["omp", "-p", "hi"]);
});

test("ug-agent passes the session's arguments after --, so ssh never reads one as its own option", async (t) => {
  const o = await owner(t);
  await stub(o.bin, "launchctl", "exit 1");
  const log = join(o.home, "ssh-argv");
  await stub(o.bin, "ssh", `printf '%s\\n' "$@" > ${log}`);
  const r = runAgent(o, ["-oProxyCommand=x", "--resume"]);
  assert.equal(r.status, 0, r.stderr);
  const argv = (await readFile(log, "utf8")).trim().split("\n");
  const dest = argv.indexOf("ugagent@127.0.0.1");
  assert.deepEqual(argv.slice(dest), ["ugagent@127.0.0.1", "--", "-oProxyCommand=x", "--resume"]);
});

test("agent-session refuses a command word outside the allowed characters, before the sandbox", () => {
  const r = spawnSync("bash", [SESSION], {
    env: { SSH_ORIGINAL_COMMAND: "omp $(id)", PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  });
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /refused/);
});

test("ug-agent-setup refuses to run without root", async (t) => {
  if (process.getuid?.() === 0) return t.skip("runs as root here");
  const r = spawnSync("bash", [SETUP], { env: { PATH: "/usr/bin:/bin", SUDO_USER: "owner" }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /run it as root/);
});

test("agent-home-tar leaves every config name out of the stream, so the gateway bearer never reaches the owner or a snapshot", async (t) => {
  const dir = await tempDir(join(tmpdir(), "ug-tar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  await mkdir(join(home, ".omp/agent/sessions"), { recursive: true });
  await mkdir(join(home, ".omp/agent/skills/x"), { recursive: true });
  await writeFile(join(home, ".omp/agent/models.yml"), "apiKey: bearer-value\n");
  await writeFile(join(home, ".omp/agent/skills/x/SKILL.md"), "x\n");
  await writeFile(join(home, ".omp/agent/sessions/s.jsonl"), "{}\n");
  await mkdir(join(dir, "code"));
  await copyFile(join(ROOT, "host/agent/config-names"), join(dir, "code/config-names"));
  const tar = await render(dir, "host/agent/agent-home-tar", { root: dir, agent_home: home });
  const stream = spawnSync("sh", [tar], { encoding: "buffer" });
  assert.equal(stream.status, 0, stream.stderr.toString());
  assert.doesNotMatch(stream.stdout.toString("latin1"), /bearer-value/);
  const list = spawnSync("tar", ["-t"], { input: stream.stdout, encoding: "utf8" }).stdout;
  assert.match(list, /\.omp\/agent\/sessions\/s\.jsonl/);
  assert.doesNotMatch(list, /models\.yml|skills/);
});

test(
  "[mac] agent-start refuses a session when the omp binary is missing its hash file or does not match it, when the config copy fails, or when the sync fails, and starts a matching one",
  { skip: process.platform !== "darwin" && "needs macOS getconf DARWIN_USER_TEMP_DIR" },
  async (t) => {
    const dir = await tempDir(join(tmpdir(), "ug-start-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "root");
    const code = join(root, "code");
    const bin = join(root, "omp/1.0/omp");
    await mkdir(join(root, "omp/1.0"), { recursive: true });
    await mkdir(join(code, "bin"), { recursive: true });
    await writeFile(bin, '#!/bin/sh\necho "OMP_RAN $*"\n');
    await chmod(bin, 0o755);
    await symlink(bin, join(code, "bin/omp"));
    await writeFile(join(code, "config-names"), "");
    const start = await render(dir, "host/agent/agent-start", { root, agent_home: join(dir, "agent-home") });
    const run = (env: Record<string, string> = {}) =>
      spawnSync("bash", [start, "-p", "hi"], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
    await writeFile(join(code, "bin/gh-broker"), "#!/bin/sh\nexit 1\n");
    await chmod(join(code, "bin/gh-broker"), 0o755);
    const inRepo = { UG_REPO: "owner/repo" };

    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no .*omp\.sha256/);
    assert.doesNotMatch(missing.stdout, /OMP_RAN/);

    await writeFile(`${bin}.sha256`, `${createHash("sha256").update(await readFile(bin)).digest("hex")}\n`);
    const good = run();
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout.trim(), "OMP_RAN -p hi");

    await writeFile(bin, '#!/bin/sh\necho "OMP_RAN changed $*"\n');
    const changed = run();
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /does not match its pinned SHA-256/);
    assert.doesNotMatch(changed.stdout, /OMP_RAN/);

    const brokenBoth = run(inRepo);
    assert.equal(brokenBoth.status, 1);
    assert.match(brokenBoth.stderr, /does not match its pinned SHA-256/);
    assert.doesNotMatch(brokenBoth.stderr, /gh-broker sync/);
    assert.doesNotMatch(brokenBoth.stdout, /OMP_RAN/);

    await writeFile(join(code, "bin/gh-broker"), "#!/bin/sh\necho garbage\n");
    const brokenQuiet = run(inRepo);
    assert.equal(brokenQuiet.status, 1);
    assert.match(brokenQuiet.stderr, /does not match its pinned SHA-256/);
    assert.doesNotMatch(brokenQuiet.stderr, /gh-broker sync/);
    await writeFile(join(code, "bin/gh-broker"), "#!/bin/sh\nexit 1\n");

    await writeFile(`${bin}.sha256`, `${createHash("sha256").update(await readFile(bin)).digest("hex")}\n`);
    const syncFailed = run(inRepo);
    assert.equal(syncFailed.status, 69);
    assert.match(syncFailed.stderr, /gh-broker sync owner\/repo failed: is the gh-broker app installed/);
    assert.doesNotMatch(syncFailed.stdout, /OMP_RAN/);

    await writeFile(join(code, "bin/gh-broker"), "#!/bin/sh\nexit 69\n");
    const brokerDown = run(inRepo);
    assert.equal(brokerDown.status, 69);
    assert.match(brokerDown.stderr, /gh-broker sync owner\/repo failed: the gh-broker does not answer/);
    assert.doesNotMatch(brokerDown.stdout, /OMP_RAN/);

    await mkdir(join(root, "config"));
    await writeFile(join(root, "config/models.yml"), "x\n");
    await chmod(join(root, "config/models.yml"), 0o000);
    await writeFile(join(code, "config-names"), "models.yml\n");
    const copyFailed = run();
    assert.equal(copyFailed.status, 1);
    assert.match(copyFailed.stderr, /config copy failed/);
    assert.doesNotMatch(copyFailed.stdout, /OMP_RAN/);
  },
);

function gitIn(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

async function agentClone(home: string, repo: string, commit = true): Promise<string> {
  const dir = join(home, "work", repo);
  await mkdir(dir, { recursive: true });
  gitIn(dir, "init", "-q");
  if (commit) gitIn(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one");
  await writeFile(join(dir, ".git/ug-launched"), "");
  return dir;
}

async function holdLock(t: { after: (fn: () => unknown) => void }, dir: string, seconds: number) {
  const holder = spawn("/usr/bin/lockf", ["-k", ".git/ug-sync.lock", "sleep", String(seconds)], { cwd: dir, stdio: "ignore" });
  t.after(() => holder.kill());
  await sleep(300);
}

test(
  "[mac] agent-refresh syncs each clone launched in the last 7 days with git hooks off, skips a clone a launch holds, stops a sync that hangs, and exits 1 only when a sync failed",
  { skip: process.platform !== "darwin" && "needs macOS lockf and getconf DARWIN_USER_TEMP_DIR" },
  async (t) => {
    const dir = await tempDir(join(tmpdir(), "ug-refresh-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "root");
    const home = join(dir, "agent-home");
    const calls = join(dir, "calls");
    await mkdir(join(root, "code/bin"), { recursive: true });
    await stub(
      join(root, "code/bin"),
      "gh-broker",
      [
        'here=$(pwd -P); echo "$here $*" >>"$CALLS"',
        'case $here in */slow) exec sleep 30 ;; */broken) exit 1 ;; esac',
        "git update-ref refs/remotes/origin/main HEAD && echo 'origin/main is now x'",
      ].join("\n"),
    );
    const app = await agentClone(home, "owner/app");
    const busy = await agentClone(home, "owner/busy");
    const slow = await agentClone(home, "owner/slow");
    const broken = await agentClone(home, "owner/broken");
    const old = await agentClone(home, "owner/old");
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(old, ".git/ug-launched"), weekAgo, weekAgo);
    await rm(join(await agentClone(home, "owner/never"), ".git/ug-launched"));
    await writeFile(join(app, ".git/hooks/reference-transaction"), "#!/bin/sh\ntouch HOOK_RAN\n");
    await chmod(join(app, ".git/hooks/reference-transaction"), 0o755);
    gitIn(app, "update-ref", "refs/probe", "HEAD");
    assert.ok(existsSync(join(app, "HOOK_RAN")), "the planted hook runs for a plain git command");
    await rm(join(app, "HOOK_RAN"));
    const rendered = await render(dir, "host/agent/agent-refresh", { root, agent_home: home }, join(dir, "agent-refresh.template"));
    const script = join(dir, "agent-refresh");
    await writeFile(script, (await readFile(rendered, "utf8")).replace("limit=20", "limit=1"));
    await holdLock(t, busy, 10);

    const started = Date.now();
    const r = spawnSync("bash", [script], { env: { PATH: "/usr/bin:/bin", CALLS: calls }, encoding: "utf8" });
    assert.equal(r.status, 1, "launchd keeps the exit code, so the watch sees the failed syncs");
    assert.ok(Date.now() - started < 8000, "a hung sync is stopped, not waited for");

    assert.equal(gitIn(app, "rev-parse", "refs/remotes/origin/main"), gitIn(app, "rev-parse", "HEAD"));
    assert.ok(!existsSync(join(app, "HOOK_RAN")), "the planted hook must not run in the background refresh");
    const called = await readFile(calls, "utf8");
    assert.match(called, /\/owner\/app sync owner\/app --cached/);
    assert.doesNotMatch(called, /\/owner\/(busy|old|never) /);
    const log = await readFile(join(home, "logs/agent-refresh.log"), "utf8");
    assert.match(log, /sync owner\/slow took over 1 s, stopped/);
    assert.match(log, /sync owner\/broken failed with exit 1/);
    assert.doesNotMatch(log, /owner\/(app|busy)|Terminated/);

    await rm(join(slow, ".git/ug-launched"));
    await rm(join(broken, ".git/ug-launched"));
    const clean = spawnSync("bash", [script], { env: { PATH: "/usr/bin:/bin", CALLS: calls }, encoding: "utf8" });
    assert.equal(clean.status, 0, "a held clone is not a failure");
  },
);

test(
  "[mac] setup fixes a wrong owner group or mode of the omp binary, leaves a right one untouched so macOS does not check the binary again, and fails when it cannot fix it",
  { skip: process.platform !== "darwin" && "needs BSD stat" },
  async (t) => {
    const dir = await tempDir(join(tmpdir(), "ug-mode-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "omp");
    await writeFile(file, "x");
    await chmod(file, 0o644);
    const id = (flag: string) => spawnSync("id", [flag], { encoding: "utf8" }).stdout.trim();
    const want = `${id("-un")}:${id("-gn")}`;
    const ensure = (owner: string) =>
      spawnSync("bash", ["-c", `source ${join(ROOT, "host/lib/ug.bash")}; ug_ensure_owner_mode "$1" "$2" 0550`, "_", file, owner], { encoding: "utf8" });

    assert.equal(ensure(want).status, 0);
    assert.equal((statSync(file).mode & 0o7777).toString(8), "550");
    const fixed = statSync(file).ctimeMs;
    await sleep(1100);
    assert.equal(ensure(want).status, 0);
    assert.equal(statSync(file).ctimeMs, fixed, "a right owner and mode must not be set again");

    const other = id("-Gn").split(" ").find((g) => g !== id("-gn"));
    if (other !== undefined) {
      spawnSync("chgrp", [other, file]);
      assert.equal(ensure(want).status, 0);
      assert.equal(spawnSync("stat", ["-f", "%Sg", file], { encoding: "utf8" }).stdout.trim(), id("-gn"));
    }

    if (process.getuid?.() !== 0) assert.notEqual(ensure("root:wheel").status, 0);

    const bin = join(dir, "stubs");
    await mkdir(bin);
    await stub(bin, "stat", `case $2 in *%Mp*) echo "${want} 4550" ;; *) echo "${want} 550" ;; esac`);
    await stub(bin, "chmod", `echo "$*" >>${join(dir, "chmod-calls")}`);
    const setuid = spawnSync("bash", ["-c", `source ${join(ROOT, "host/lib/ug.bash")}; ug_ensure_owner_mode "$1" "$2" 0550`, "_", file, want], {
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin` },
      encoding: "utf8",
    });
    assert.equal(await readFile(join(dir, "chmod-calls"), "utf8"), `0550 ${file}\n`, "a setuid bit is a wrong mode and gets cleared");
    assert.notEqual(setuid.status, 0, "a mode that still differs after the fix fails");
  },
);

test(
  "[mac] agent-start starts from the clone's main when the background refresh holds the clone, and refuses a clone with no commit yet",
  { skip: process.platform !== "darwin" && "needs macOS lockf and getconf DARWIN_USER_TEMP_DIR" },
  async (t) => {
    const dir = await tempDir(join(tmpdir(), "ug-busy-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "root");
    const code = join(root, "code");
    const home = join(dir, "agent-home");
    const bin = join(root, "omp/1.0/omp");
    await mkdir(join(root, "omp/1.0"), { recursive: true });
    await mkdir(join(code, "bin"), { recursive: true });
    await writeFile(bin, '#!/bin/sh\necho "OMP_RAN $*"\n');
    await chmod(bin, 0o755);
    await writeFile(`${bin}.sha256`, `${createHash("sha256").update(await readFile(bin)).digest("hex")}\n`);
    await symlink(bin, join(code, "bin/omp"));
    await writeFile(join(code, "config-names"), "");
    await stub(join(code, "bin"), "gh-broker", "echo SYNC_CALLED\nexit 1");
    const start = await render(dir, "host/agent/agent-start", { root, agent_home: home });
    const run = (repo: string) =>
      spawnSync("bash", [start, "-p", "hi"], { env: { PATH: "/usr/bin:/bin", UG_REPO: repo }, encoding: "utf8" });

    await holdLock(t, await agentClone(home, "owner/repo"), 10);
    const stale = run("owner/repo");
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(stale.stdout.trim(), "OMP_RAN -p hi");
    assert.match(stale.stderr, /background refresh holds the clone of owner\/repo; this session starts from the main that the clone has/);
    assert.doesNotMatch(stale.stdout + stale.stderr, /SYNC_CALLED/);

    await holdLock(t, await agentClone(home, "owner/fresh", false), 10);
    const fresh = run("owner/fresh");
    assert.equal(fresh.status, 1);
    assert.match(fresh.stderr, /busy with its first sync/);
    assert.doesNotMatch(fresh.stdout, /OMP_RAN/);
  },
);

test(
  "[mac] agent-start syncs and checks out the clone with git hooks off, and starts omp with hooks on",
  { skip: process.platform !== "darwin" && "needs macOS lockf and getconf DARWIN_USER_TEMP_DIR" },
  async (t) => {
    const dir = await tempDir(join(tmpdir(), "ug-hooks-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "root");
    const code = join(root, "code");
    const home = join(dir, "agent-home");
    const bin = join(root, "omp/1.0/omp");
    await mkdir(join(root, "omp/1.0"), { recursive: true });
    await mkdir(join(code, "bin"), { recursive: true });
    await writeFile(bin, '#!/bin/sh\necho "OMP_RAN hooks=${GIT_CONFIG_COUNT:-on}"\n');
    await chmod(bin, 0o755);
    await writeFile(`${bin}.sha256`, `${createHash("sha256").update(await readFile(bin)).digest("hex")}\n`);
    await symlink(bin, join(code, "bin/omp"));
    await writeFile(join(code, "config-names"), "");
    await stub(
      join(code, "bin"),
      "gh-broker",
      'case $1 in sync) git update-ref refs/remotes/origin/main HEAD && echo "origin/main is now x" ;; esac',
    );
    const clone = await agentClone(home, "owner/repo");
    for (const hook of ["post-checkout", "reference-transaction"]) {
      await writeFile(join(clone, ".git/hooks", hook), `#!/bin/sh\necho ${hook} >>HOOK_RAN\n`);
      await chmod(join(clone, ".git/hooks", hook), 0o755);
    }
    gitIn(clone, "update-ref", "refs/probe", "HEAD");
    assert.ok(existsSync(join(clone, "HOOK_RAN")), "the planted hook runs for a plain git command");
    await rm(join(clone, "HOOK_RAN"));
    const start = await render(dir, "host/agent/agent-start", { root, agent_home: home });

    const r = spawnSync("bash", [start], { env: { PATH: "/usr/bin:/bin", UG_REPO: "owner/repo" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "OMP_RAN hooks=on");
    assert.equal(gitIn(clone, "rev-parse", "HEAD"), gitIn(clone, "rev-parse", "refs/remotes/origin/main"));
    assert.ok(!existsSync(join(clone, "HOOK_RAN")), "a planted hook must not run at session start");
  },
);

test(
  "[mac] agent-start passes one --plugin-dir per staged plugin to omp before the user args, and removes stale plugin state from the agent home",
  { skip: process.platform !== "darwin" && "needs macOS getconf DARWIN_USER_TEMP_DIR" },
  async (t) => {
    const dir = await tempDir(join(tmpdir(), "ug-plugins-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "root");
    const code = join(root, "code");
    const home = join(dir, "agent-home");
    const bin = join(root, "omp/1.0/omp");
    await mkdir(join(root, "omp/1.0"), { recursive: true });
    await mkdir(join(code, "bin"), { recursive: true });
    await writeFile(bin, '#!/bin/sh\necho "OMP_RAN $*"\n');
    await chmod(bin, 0o755);
    await writeFile(`${bin}.sha256`, `${createHash("sha256").update(await readFile(bin)).digest("hex")}\n`);
    await symlink(bin, join(code, "bin/omp"));
    await writeFile(join(code, "config-names"), "");
    const start = await render(dir, "host/agent/agent-start", { root, agent_home: home });
    const run = () => spawnSync("bash", [start, "-p", "hi"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });

    const bare = run();
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(bare.stdout.trim(), "OMP_RAN -p hi");

    await mkdir(join(root, "config/plugins/arkan/skills/arkan-mode"), { recursive: true });
    await mkdir(join(root, "config/plugins/other"), { recursive: true });
    await mkdir(join(home, ".omp/plugins"), { recursive: true });
    await writeFile(join(home, ".omp/plugins/x"), "stale\n");
    await writeFile(join(home, ".omp/marketplaces.json"), "stale\n");
    const staged = run();
    assert.equal(staged.status, 0, staged.stderr);
    assert.equal(staged.stdout.trim(), `OMP_RAN --plugin-dir ${join(root, "config/plugins/arkan")} --plugin-dir ${join(root, "config/plugins/other")} -p hi`);
    assert.ok(!existsSync(join(home, ".omp/plugins/x")), "a stale plugin install must not survive into a session");
    assert.ok(!existsSync(join(home, ".omp/plugins")), "the stale plugins folder is gone too");
    assert.ok(!existsSync(join(home, ".omp/marketplaces.json")), "a leftover marketplace list must not survive into a session");
  },
);

test("the agent sshd config holds the contract lines", async (t) => {
  const dir = await tempDir(join(tmpdir(), "ug-sshd-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const conf = await readFile(await render(dir, "host/agent/sshd_config", { root: "/r", agent_user: "agentx", agent_sshd_port: "2345" }), "utf8");
  for (const line of [
    "ListenAddress 127.0.0.1:2345",
    "HostKey /r/ssh_host_ed25519_key",
    "AllowUsers agentx",
    "AuthorizedKeysFile /r/code/authorized_keys/%u",
    "ForceCommand /r/code/agent-session",
    "PermitRootLogin no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "AuthenticationMethods publickey",
    "PermitTTY yes",
    "AllowTcpForwarding no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitUserEnvironment no",
    "AcceptEnv UG_REPO UG_WARNINGS",
  ]) {
    assert.ok(conf.split("\n").includes(line), `missing: ${line}`);
  }
});

test("the agent sshd LaunchDaemon runs its own sshd config and is kept alive", async () => {
  const plist = await readFile(join(ROOT, "host/agent/com.underground.agent-sshd.plist"), "utf8");
  assert.match(plist, /<string>com.underground.agent-sshd<\/string>/);
  assert.match(plist, /<string>\/usr\/sbin\/sshd<\/string>\s*<string>-D<\/string>\s*<string>-f<\/string>\s*<string>@ROOT@\/code\/sshd_config<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

const insideSandbox =
  process.platform === "darwin" && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status !== 0;

const pinSkip = (process.platform !== "darwin" && "needs macOS sandbox-exec") || (insideSandbox && "already inside a sandbox, which macOS will not nest");

test(
  "[mac] the pin profile loads under sandbox-exec and runs a plain command",
  { skip: pinSkip },
  async (t) => {
    const dir = await tempDir(join(tmpdir(), "ug-pin-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const r = spawnSync("/usr/bin/sandbox-exec", ["-f", await render(dir, "host/agent/pin.sb"), "/bin/echo", "ok"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "ok\n");
  },
);

function underPin(pin: string, command: string[]) {
  return spawnSync("/usr/bin/sandbox-exec", ["-f", pin, ...command], { encoding: "utf8", input: "", timeout: 10_000 });
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  await once(server.close(), "close");
  return address.port;
}

test("[mac] the pin refuses a write outside the agent home and the temp folders, and allows one inside the home", { skip: pinSkip }, async (t) => {
  const dir = await tempDir(join(tmpdir(), "ug-pin-"));
  const outside = await realpath(await mkdtemp("/tmp/ug-pin-out-"));
  const home = await realpath(await mkdtemp("/tmp/ug-pin-home-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pin = await render(dir, "host/agent/pin.sb", { agent_home: home });
  const write = (path: string) => underPin(pin, ["/bin/sh", "-c", 'echo x > "$1"', "_", path]);

  const inside = write(join(home, "file"));
  assert.equal(inside.status, 0, inside.stderr);
  assert.equal(await readFile(join(home, "file"), "utf8"), "x\n");

  const refused = write(join(outside, "file"));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Operation not permitted/);
  assert.equal(existsSync(join(outside, "file")), false, "the pin let a write outside the agent home through");
});

test("[mac] the pin refuses a listener on the auth broker's port and allows one on another port", { skip: pinSkip }, async (t) => {
  const dir = await tempDir(join(tmpdir(), "ug-pin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = await freePort();
  let other = await freePort();
  while (other === port) other = await freePort();
  const pin = await render(dir, "host/agent/pin.sb", { auth_broker_port: String(port) });
  const listen =
    'const s = require("node:net").createServer(); s.on("error", (e) => { console.log(e.code); process.exit(1); }); s.listen(Number(process.argv.at(-1)), "127.0.0.1", () => { console.log("bound"); s.close(); });';
  const bind = (p: number) => underPin(pin, [process.execPath, "-e", listen, String(p)]);

  const refused = bind(port);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stdout, "EPERM\n");

  const allowed = bind(other);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "bound\n");
});

test("[mac] the pin refuses to run launchctl, at, batch, and crontab", { skip: pinSkip }, async (t) => {
  const dir = await tempDir(join(tmpdir(), "ug-pin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pin = await render(dir, "host/agent/pin.sb", { agent_home: dir });
  for (const command of [["/bin/launchctl", "version"], ["/usr/bin/at", "-l"], ["/usr/bin/batch", "-l"], ["/usr/bin/crontab", "-l"]]) {
    const r = underPin(pin, ["/bin/sh", "-c", '"$@"', "_", ...command]);
    assert.equal(r.status, 126, `${command[0]}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Operation not permitted/);
  }
});
