import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { tempDir } from "../temp.ts";

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

test("every group that ug-agent-setup gives a file is a macOS group or one that the script makes first", async () => {
  const text = await readFile(SETUP, "utf8");
  const made = new Set([...text.matchAll(/^make_group (\S+)/gm)].map((m) => m[1]));
  const used = [...text.matchAll(/chown(?: -[Rh])? [^:\s]+:([A-Za-z_][\w-]*)/g), ...text.matchAll(/ -g ([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const group of used) assert.ok(group === "wheel" || group === "staff" || made.has(group), `group ${group} is neither a macOS group nor made by make_group`);
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
  await copyFile(join(ROOT, "host/agent/config-names"), join(dir, "config-names"));
  const text = (await readFile(join(ROOT, "host/agent/agent-home-tar"), "utf8"))
    .replace("names=/Library/Underground/config-names", `names=${join(dir, "config-names")}`)
    .replace("home=/Users/ugagent", `home=${home}`);
  await writeFile(join(dir, "agent-home-tar"), text);
  const stream = spawnSync("sh", [join(dir, "agent-home-tar")], { encoding: "buffer" });
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
    const bin = join(root, "omp/1.0/omp");
    await mkdir(join(root, "omp/1.0"), { recursive: true });
    await mkdir(join(root, "bin"));
    await writeFile(bin, '#!/bin/sh\necho "OMP_RAN $*"\n');
    await chmod(bin, 0o755);
    await symlink(bin, join(root, "bin/omp"));
    await writeFile(join(root, "config-names"), "");
    const text = (await readFile(join(ROOT, "host/agent/agent-start"), "utf8"))
      .replace("root=/Library/Underground", `root=${root}`)
      .replace("export HOME=/Users/ugagent", `export HOME=${join(dir, "agent-home")}`);
    const start = join(dir, "agent-start");
    await writeFile(start, text);
    const run = (env: Record<string, string> = {}) =>
      spawnSync("bash", [start, "-p", "hi"], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
    await writeFile(join(root, "bin/gh-broker"), "#!/bin/sh\nexit 1\n");
    await chmod(join(root, "bin/gh-broker"), 0o755);
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

    await writeFile(join(root, "bin/gh-broker"), "#!/bin/sh\necho garbage\n");
    const brokenQuiet = run(inRepo);
    assert.equal(brokenQuiet.status, 1);
    assert.match(brokenQuiet.stderr, /does not match its pinned SHA-256/);
    assert.doesNotMatch(brokenQuiet.stderr, /gh-broker sync/);
    await writeFile(join(root, "bin/gh-broker"), "#!/bin/sh\nexit 1\n");

    await writeFile(`${bin}.sha256`, `${createHash("sha256").update(await readFile(bin)).digest("hex")}\n`);
    const syncFailed = run(inRepo);
    assert.equal(syncFailed.status, 69);
    assert.match(syncFailed.stderr, /gh-broker sync owner\/repo failed: is the gh-broker app installed/);
    assert.doesNotMatch(syncFailed.stdout, /OMP_RAN/);

    await writeFile(join(root, "bin/gh-broker"), "#!/bin/sh\nexit 69\n");
    const brokerDown = run(inRepo);
    assert.equal(brokerDown.status, 69);
    assert.match(brokerDown.stderr, /gh-broker sync owner\/repo failed: the gh-broker does not answer/);
    assert.doesNotMatch(brokerDown.stdout, /OMP_RAN/);

    await mkdir(join(root, "config"));
    await writeFile(join(root, "config/models.yml"), "x\n");
    await chmod(join(root, "config/models.yml"), 0o000);
    await writeFile(join(root, "config-names"), "models.yml\n");
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
  return dir;
}

async function holdLock(t: { after: (fn: () => unknown) => void }, dir: string, seconds: number) {
  const holder = spawn("/usr/bin/lockf", ["-k", ".git/ug-sync.lock", "sleep", String(seconds)], { cwd: dir, stdio: "ignore" });
  t.after(() => holder.kill());
  await sleep(300);
}

test(
  "[mac] agent-refresh syncs each agent clone with git hooks off, skips a clone a launch holds, and stops a sync that hangs",
  { skip: process.platform !== "darwin" && "needs macOS lockf and getconf DARWIN_USER_TEMP_DIR" },
  async (t) => {
    const dir = await tempDir(join(tmpdir(), "ug-refresh-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "root");
    const home = join(dir, "agent-home");
    const calls = join(dir, "calls");
    await mkdir(join(root, "bin"), { recursive: true });
    await stub(
      join(root, "bin"),
      "gh-broker",
      [
        'here=$(pwd -P); echo "$here $*" >>"$CALLS"',
        'case $here in */slow) exec sleep 30 ;; */broken) exit 1 ;; esac',
        "git update-ref refs/remotes/origin/main HEAD && echo 'origin/main is now x'",
      ].join("\n"),
    );
    const app = await agentClone(home, "owner/app");
    const busy = await agentClone(home, "owner/busy");
    await agentClone(home, "owner/slow");
    await agentClone(home, "owner/broken");
    await writeFile(join(app, ".git/hooks/reference-transaction"), "#!/bin/sh\ntouch HOOK_RAN\n");
    await chmod(join(app, ".git/hooks/reference-transaction"), 0o755);
    gitIn(app, "update-ref", "refs/probe", "HEAD");
    assert.ok(existsSync(join(app, "HOOK_RAN")), "the planted hook runs for a plain git command");
    await rm(join(app, "HOOK_RAN"));
    const text = (await readFile(join(ROOT, "host/agent/agent-refresh"), "utf8"))
      .replace("root=/Library/Underground", `root=${root}`)
      .replace("export HOME=/Users/ugagent", `export HOME=${home}`)
      .replace("limit=20", "limit=1");
    const script = join(dir, "agent-refresh");
    await writeFile(script, text);
    await holdLock(t, busy, 10);

    const started = Date.now();
    const r = spawnSync("bash", [script], { env: { PATH: "/usr/bin:/bin", CALLS: calls }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Date.now() - started < 8000, "a hung sync is stopped, not waited for");

    assert.equal(gitIn(app, "rev-parse", "refs/remotes/origin/main"), gitIn(app, "rev-parse", "HEAD"));
    assert.ok(!existsSync(join(app, "HOOK_RAN")), "the planted hook must not run in the background refresh");
    const called = await readFile(calls, "utf8");
    assert.match(called, /\/owner\/app sync owner\/app --cached/);
    assert.doesNotMatch(called, /\/owner\/busy /);
    const log = await readFile(join(home, "logs/agent-refresh.log"), "utf8");
    assert.match(log, /sync owner\/slow took over 1 s, stopped/);
    assert.match(log, /sync owner\/broken failed with exit 1/);
    assert.doesNotMatch(log, /owner\/(app|busy)/);
  },
);

test(
  "[mac] agent-start starts from the clone's main when the background refresh holds the clone, and refuses a clone with no commit yet",
  { skip: process.platform !== "darwin" && "needs macOS lockf and getconf DARWIN_USER_TEMP_DIR" },
  async (t) => {
    const dir = await tempDir(join(tmpdir(), "ug-busy-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "root");
    const home = join(dir, "agent-home");
    const bin = join(root, "omp/1.0/omp");
    await mkdir(join(root, "omp/1.0"), { recursive: true });
    await mkdir(join(root, "bin"));
    await writeFile(bin, '#!/bin/sh\necho "OMP_RAN $*"\n');
    await chmod(bin, 0o755);
    await writeFile(`${bin}.sha256`, `${createHash("sha256").update(await readFile(bin)).digest("hex")}\n`);
    await symlink(bin, join(root, "bin/omp"));
    await writeFile(join(root, "config-names"), "");
    await stub(join(root, "bin"), "gh-broker", "echo SYNC_CALLED\nexit 1");
    const text = (await readFile(join(ROOT, "host/agent/agent-start"), "utf8"))
      .replace("root=/Library/Underground", `root=${root}`)
      .replace("export HOME=/Users/ugagent", `export HOME=${home}`);
    const start = join(dir, "agent-start");
    await writeFile(start, text);
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

test("the agent sshd config holds the contract lines", async () => {
  const conf = await readFile(join(ROOT, "host/agent/sshd_config"), "utf8");
  for (const line of [
    "ListenAddress 127.0.0.1:2222",
    "HostKey /Library/Underground/ssh_host_ed25519_key",
    "AllowUsers ugagent",
    "PermitRootLogin no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "AuthenticationMethods publickey",
    "AuthorizedKeysFile /Library/Underground/authorized_keys/%u",
    "ForceCommand /Library/Underground/agent-session",
    "PermitTTY yes",
    "AllowTcpForwarding no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitUserEnvironment no",
    "AcceptEnv UG_REPO",
  ]) {
    assert.ok(conf.split("\n").includes(line), `missing: ${line}`);
  }
});

test("the agent sshd LaunchDaemon runs its own sshd config and is kept alive", async () => {
  const plist = await readFile(join(ROOT, "host/agent/com.underground.agent-sshd.plist"), "utf8");
  assert.match(plist, /<string>com.underground.agent-sshd<\/string>/);
  assert.match(plist, /<string>\/usr\/sbin\/sshd<\/string>\s*<string>-D<\/string>\s*<string>-f<\/string>\s*<string>\/Library\/Underground\/sshd_config<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("the pin profile names the agent home and denies the launchd-style exec routes", async () => {
  const pin = await readFile(join(ROOT, "host/agent/pin.sb"), "utf8");
  assert.match(pin, /\/Users\/ugagent/);
  assert.doesNotMatch(pin, /ugtest/);
  assert.ok(
    pin.split("\n").includes('(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/at") (literal "/usr/bin/crontab") (literal "/usr/bin/batch"))'),
    "the pin does not deny launchctl, at, crontab and batch",
  );
});

const insideSandbox =
  process.platform === "darwin" && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status !== 0;

test(
  "[mac] the pin profile loads under sandbox-exec and runs a plain command",
  { skip: (process.platform !== "darwin" && "needs macOS sandbox-exec") || (insideSandbox && "already inside a sandbox, which macOS will not nest") },
  () => {
    const r = spawnSync("/usr/bin/sandbox-exec", ["-f", join(ROOT, "host/agent/pin.sb"), "/bin/echo", "ok"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "ok\n");
  },
);
