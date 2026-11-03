import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { tempDir } from "../temp.ts";

// The arena wrapper and its start step, run against a fake srt that does not sandbox, so only the
// wrapper's own logic is under test: what reaches omp, which settings srt gets, and what the wrapper
// refuses. The checks try to get a secret, a link, or a bad start past the wrapper.

const SRC = join(import.meta.dirname, "../..");
const WRAPPER = join(SRC, "host/bin/omp-arena");
const versions = await readFile(join(SRC, "VERSIONS"), "utf8");
const pinOf = (name: string) => new RegExp(`^${name}=(.+)$`, "m").exec(versions)?.[1] ?? "";
const OMP_PIN = pinOf("omp");
const SRT_PIN = pinOf("srt");
const BUILD = "TEST1A";
// The wrapper hands every session the one broker socket, ~/.ug/run/broker.sock, when it is there.
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listenAt(path: string): Promise<void> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push(server);
}

const LEAKY_SRT = `process.stdout.write("SRTCWD=" + process.cwd() + "\\n");
const i = process.argv.indexOf("--");
const r = require("child_process").spawnSync(process.argv[i + 1], process.argv.slice(i + 2), { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`;

// A fake omp: the broker registration prints a socket; a session prints what it got and stops.
const FAKE_OMP = `#!/bin/sh
echo "CWD=$(pwd -P)"
env | sed 's/^/ENV:/'
echo "ARGS=$*"
`;

// A fake broker: sync makes one commit on origin/main of the clone, as the real import does.
const FAKE_BROKER = `#!/bin/sh
[ "$1" = sync ] || exit 2
[ ! -e "$(dirname "$0")/fail-sync" ] || exit 1
tree=$(git hash-object -t tree /dev/null)
sha=$(git -c user.name=t -c user.email=t@t commit-tree "$tree" -m init)
git update-ref refs/remotes/origin/main "$sha"
echo "origin/main is now $sha"
`;

async function exe(path: string, text: string) {
  await writeFile(path, text);
  await chmod(path, 0o755);
}

async function fakeHome({ broker = true, config = true } = {}) {
  const home = await tempDir(join(tmpdir(), "omp-arena-"));
  const sys = join(home, ".ug/sys");
  const srtDir = join(sys, "srt", SRT_PIN, "node_modules/@anthropic-ai/sandbox-runtime/dist");
  for (const dir of [join(sys, "omp", OMP_PIN), srtDir, join(sys, "libexec"), join(sys, "agent-bin"), join(home, ".ug/run"), join(home, ".omp"), join(home, "fakebin"), join(home, "code")]) {
    await mkdir(dir, { recursive: true });
  }
  await exe(join(sys, "omp", OMP_PIN, "omp"), FAKE_OMP);
  await writeFile(join(srtDir, "cli.js"), LEAKY_SRT);
  await copyFile(join(SRC, "host/arena/init"), join(sys, "libexec/ug-arena-init"));
  await chmod(join(sys, "libexec/ug-arena-init"), 0o755);
  await exe(join(sys, "agent-bin/broker"), FAKE_BROKER);
  await writeFile(join(sys, "macos-build"), `${BUILD}\n`);
  await exe(join(home, "fakebin/sw_vers"), `#!/bin/sh\ncat "$(dirname "$0")/build"\n`);
  await writeFile(join(home, "fakebin/build"), `${BUILD}\n`);
  await mkdir(join(home, ".ug/host"), { recursive: true });
  await writeFile(join(home, ".ug/host/addresses"), "gateway=192.0.2.1:4000\nengine=192.0.2.2:8081\n");
  await mkdir(join(home, ".ug/host/auth"), { recursive: true });
  await writeFile(join(home, ".ug/host/auth/auth-gateway.token"), "test-bearer\n");
  const checkout = join(home, "code/proj");
  await mkdir(checkout);
  for (const args of [["init", "-q"], ["remote", "add", "origin", "git@github.com:Test-Owner/proj.git"]]) {
    assert.equal(spawnSync("git", ["-C", checkout, ...args]).status, 0);
  }
  const socket = join(home, ".ug/run/broker.sock");
  if (broker) await listenAt(socket);
  // The owner's config repo, in the owner's zone, named in ~/.ug/host/config-repo.
  const repo = join(home, "Developer/agent-config");
  if (config) {
    await mkdir(join(repo, "skills/fix-bug"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, "AGENTS.md"), "# owner rules\n");
    await writeFile(join(repo, "skills/fix-bug/SKILL.md"), "fix the bug\n");
    await writeFile(join(repo, "models.yml"), 'providers:\n  anthropic:\n    baseUrl: "http://@GATEWAY@"\n    apiKey: "@GATEWAY_TOKEN@"\n');
    await writeFile(join(repo, ".git/config"), "[core]\n");
    await writeFile(join(home, ".ug/host/config-repo"), `${repo}\n`);
  }
  return { home, checkout, socket, repo, arena: join(home, ".ug/home") };
}

function run(home: string, cwd: string, args: string[] = [], extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    HOME: home,
    USER: "tester",
    PATH: `${join(home, "fakebin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    UG_TEST_NODE: process.execPath,
    ...extra,
  };
  const r = spawnSync("bash", [WRAPPER, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  const envOf = (name: string) => r.stdout.split("\n").find((l) => l.startsWith(`ENV:${name}=`))?.slice(`ENV:${name}=`.length);
  return { ...r, envOf };
}

async function settingsOf(home: string) {
  const runRoot = join(home, ".ug/run");
  const [session] = (await readdir(runRoot)).filter((n) => n.startsWith("session."));
  return JSON.parse(await readFile(join(runRoot, session, "srt.json"), "utf8"));
}

test("omp-arena: no variable of the caller's shell reaches omp, and omp starts in the arena clone", async (t) => {
  const { home, checkout, arena, socket } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home, checkout, ["--model", "x"], { STRATA_API_KEY: "leak-1", GH_TOKEN: "leak-2", SSH_AUTH_SOCK: "/tmp/leak-3", AWS_SECRET_ACCESS_KEY: "leak-4", NODE_OPTIONS: "--require=/tmp/evil.js" });
  assert.equal(r.status, 0, r.stderr);
  for (const leak of ["leak-1", "leak-2", "leak-3", "leak-4", "evil.js"]) assert.ok(!r.stdout.includes(leak), `${leak} reached omp:\n${r.stdout}`);
  assert.equal(r.envOf("HOME"), arena);
  assert.equal(r.envOf("UG_BROKER_SOCKET"), socket);
  assert.equal(r.envOf("OMP_WORKTREE_DIR"), join(arena, ".omp/wt/Test-Owner-proj"));
  assert.match(r.stdout, new RegExp(`^CWD=${join(arena, "work/Test-Owner/proj")}$`, "m"));
  assert.match(r.stdout, /^ARGS=--model x$/m);
  // The stored value, not `remote get-url`: that one applies the tester's own insteadOf rules.
  const remote = spawnSync("git", ["-C", join(arena, "work/Test-Owner/proj"), "config", "--get", "remote.origin.url"], { encoding: "utf8" });
  assert.equal(remote.stdout.trim(), "https://github.com/Test-Owner/proj.git");
});

test("omp-arena: srt may write only the arena, read no part of the real home outside ~/.ug, and reach only two sockets", async (t) => {
  const { home, checkout, arena, socket } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  const s = await settingsOf(home);
  assert.deepEqual(s.filesystem.allowWrite, [arena]);
  assert.deepEqual(s.filesystem.denyRead, [home]);
  for (const p of s.filesystem.allowRead) assert.ok(p.startsWith(`${home}/.ug/`), `allowRead opens ${p}`);
  assert.ok(!s.filesystem.allowRead.some((p: string) => checkout.startsWith(p) || p.startsWith(checkout)), "the checkout is readable");
  assert.deepEqual(s.network.allowUnixSockets, [socket, join(arena, ".omp/run")]);
  assert.ok(s.network.allowedDomains.every((d: string) => !d.includes("@")), "a placeholder is left");
  assert.equal(s.allowAppleEvents, false);
  // srt anchors its built-in write denies at its own working folder, so that must be the run folder:
  // not / (the denies would cripple git in the arena) and not the arena or the checkout.
  const srtCwd = /^SRTCWD=(.*)$/m.exec(r.stdout)?.[1] ?? "";
  assert.ok(srtCwd.startsWith(`${home}/.ug/run/session.`), `srt starts in ${srtCwd}`);
});

test("omp-arena: a link that an agent planted in the arena does not let the start write outside it", async (t) => {
  const { home, checkout, arena, socket } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const victim = join(home, "victim.txt");
  await writeFile(victim, "owner data\n");
  await mkdir(join(arena, ".omp/agent"), { recursive: true });
  await symlink(victim, join(arena, ".omp/agent/models.yml"));
  const r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(victim, "utf8"), "owner data\n");
  assert.ok((await lstat(join(arena, ".omp/agent/models.yml"))).isFile(), "models.yml is still a link");
});

test("omp-arena refuses an arena that is a link, before it writes anything", async (t) => {
  const { home, checkout, socket } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "elsewhere"));
  await symlink(join(home, "elsewhere"), join(home, ".ug/home"));
  const r = run(home, checkout);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be a folder that you own, not a link/);
  assert.deepEqual(await readdir(join(home, "elsewhere")), []);
});

test("omp-arena refuses a start inside ~/.ug, so the host runs no git in the arena", async (t) => {
  const { home, checkout, arena, socket } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(home, checkout).status, 0);
  const r = run(home, join(arena, "work/Test-Owner/proj"));
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /not inside/);
  assert.doesNotMatch(r.stdout, /^CWD=/m, "omp started");
});

test("omp-arena refuses --role and --profile", async (t) => {
  const { home, checkout, socket } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const args of [["--role", "code-review"], ["--role=author"], ["--profile", "work"], ["--profile=x"]]) {
    const r = run(home, checkout, args);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /^CWD=/m, `${args.join(" ")}: omp started`);
  }
});

test("omp-arena refuses to start on a macOS build that setup did not prove", async (t) => {
  const { home, checkout, socket } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "fakebin/build"), "OTHER2B\n");
  const r = run(home, checkout);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /setup proved the sandbox on build TEST1A/);
  assert.doesNotMatch(r.stdout, /^CWD=/m, "omp started");
  await writeFile(join(home, "fakebin/build"), `${BUILD}\n`);
  await rm(join(home, ".ug/sys/macos-build"));
  assert.notEqual(run(home, checkout).status, 0, "it starts with no recorded build");
});

test("omp-arena: a clone that stopped halfway is made again, not used", async (t) => {
  const { home, checkout, arena, socket } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const clone = join(arena, "work/Test-Owner/proj");
  await mkdir(clone, { recursive: true });
  assert.equal(spawnSync("git", ["-C", clone, "init", "-q"]).status, 0);
  const r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not a whole clone; making it again/);
  assert.equal(spawnSync("git", ["-C", clone, "rev-parse", "--verify", "-q", "HEAD"]).status, 0, "the clone has no commit");
});

test("omp-arena: a failed sync leaves no half-made clone, and a repo with no GitHub origin starts with no repo", async (t) => {
  const { home, checkout, arena, socket } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, ".ug/sys/agent-bin/fail-sync"), "");
  const failed = run(home, checkout);
  assert.equal(failed.status, 69, failed.stderr);
  assert.doesNotMatch(failed.stdout, /^CWD=/m, "omp started");
  assert.deepEqual(await readdir(join(arena, "work/Test-Owner")), []);
  assert.deepEqual((await readdir(join(arena, "work"))).filter((n) => n.startsWith(".new.")), [], "a temp clone is left");
  assert.equal(spawnSync("git", ["-C", checkout, "remote", "set-url", "origin", "https://gitlab.com/x/proj.git"]).status, 0);
  await rm(join(home, ".ug/sys/agent-bin/fail-sync"));
  const plain = run(home, checkout);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, new RegExp(`^CWD=${join(arena, "work")}$`, "m"));
  assert.equal(plain.envOf("UG_BROKER_SOCKET"), socket);
});

test("omp-arena with no broker socket warns, gives omp no socket, and cannot make a new clone", async (t) => {
  const { home, checkout, arena } = await fakeHome({ broker: false });
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home, checkout);
  assert.equal(r.status, 69, r.stderr);
  assert.match(r.stderr, /the broker socket .*broker\.sock is missing/);
  assert.match(r.stderr, /has no arena clone yet, and this session has no broker to make one/);
  assert.doesNotMatch(r.stdout, /^CWD=/m);
  assert.deepEqual(await readdir(join(arena, "work")), []);
  const s = await settingsOf(home);
  assert.deepEqual(s.network.allowUnixSockets, [join(arena, ".omp/run")]);
});

test("omp-arena does not take a plain file at the socket path for the broker", async (t) => {
  const { home, checkout, socket } = await fakeHome({ broker: false });
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(socket, "not a socket\n");
  const r = run(home, checkout);
  assert.match(r.stderr, /the broker socket .*broker\.sock is missing/);
  assert.equal(r.envOf("UG_BROKER_SOCKET"), undefined);
});

// --- the config repo (docs/SPEC.md, B3) ------------------------------------------------------------

const agentFile = (arena: string, name: string) => join(arena, ".omp/agent", name);

test("omp-arena copies the config repo into the arena and fills the gateway markers of its models.yml", async (t) => {
  const { home, checkout, arena, repo } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(repo, "secrets.yml"), "not a config name\n");
  const r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(agentFile(arena, "AGENTS.md"), "utf8"), "# owner rules\n");
  assert.equal(await readFile(agentFile(arena, "skills/fix-bug/SKILL.md"), "utf8"), "fix the bug\n");
  const models = await readFile(agentFile(arena, "models.yml"), "utf8");
  assert.match(models, /baseUrl: "http:\/\/192\.0\.2\.1:4000"/);
  assert.match(models, /apiKey: "test-bearer"/);
  assert.doesNotMatch(models, /@[A-Z_]+@/);
  assert.equal(existsSync(agentFile(arena, "secrets.yml")), false, "a name off the list was copied");
  assert.equal(existsSync(agentFile(arena, ".git")), false, "the repo's .git was copied");
  assert.equal(await readFile(join(repo, "models.yml"), "utf8").then((m) => m.includes("@GATEWAY_TOKEN@")), true, "the repo itself was changed");
});

test("omp-arena: the config repo owns its names, so an agent's change lasts until the next start, and omp's own data stays", async (t) => {
  const { home, checkout, arena } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(home, checkout).status, 0);
  await writeFile(agentFile(arena, "AGENTS.md"), "# the agent's own rules\n");
  await writeFile(agentFile(arena, "RULES.md"), "planted\n");
  await mkdir(agentFile(arena, "skills/planted"), { recursive: true });
  await writeFile(agentFile(arena, "skills/planted/SKILL.md"), "planted\n");
  await mkdir(agentFile(arena, "sessions"), { recursive: true });
  await writeFile(agentFile(arena, "sessions/keep.jsonl"), "{}\n");
  await writeFile(agentFile(arena, "agent.db"), "db\n");
  const r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(agentFile(arena, "AGENTS.md"), "utf8"), "# owner rules\n");
  assert.equal(existsSync(agentFile(arena, "RULES.md")), false, "a listed name that the repo lacks stayed");
  assert.equal(existsSync(agentFile(arena, "skills/planted")), false, "a planted skill stayed");
  assert.equal(await readFile(agentFile(arena, "sessions/keep.jsonl"), "utf8"), "{}\n");
  assert.equal(await readFile(agentFile(arena, "agent.db"), "utf8"), "db\n");
});

test("omp-arena: a link that an agent planted in place of a config folder is replaced, and its target is untouched", async (t) => {
  const { home, checkout, arena } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const victim = join(home, "victim");
  await mkdir(victim);
  await writeFile(join(victim, "owner.txt"), "owner data\n");
  await mkdir(join(arena, ".omp/agent"), { recursive: true });
  await symlink(victim, agentFile(arena, "skills"));
  await symlink(join(victim, "owner.txt"), agentFile(arena, "AGENTS.md"));
  const r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(join(victim, "owner.txt"), "utf8"), "owner data\n");
  assert.deepEqual(await readdir(victim), ["owner.txt"]);
  assert.ok((await lstat(agentFile(arena, "skills"))).isDirectory(), "skills is still a link");
  assert.ok((await lstat(agentFile(arena, "AGENTS.md"))).isFile(), "AGENTS.md is still a link");
});

test("omp-arena refuses a config repo with a link, so no file from outside reaches the sandbox", async (t) => {
  for (const [name, plant] of [
    ["a link inside a skill", (repo: string, secret: string) => symlink(secret, join(repo, "skills/fix-bug/key"))],
    ["a link as a listed name", (repo: string, secret: string) => rm(join(repo, "AGENTS.md")).then(() => symlink(secret, join(repo, "AGENTS.md")))],
    ["a link to a folder", (repo: string, secret: string) => symlink(join(secret, ".."), join(repo, "skills/outside"))],
  ] as const) {
    const { home, checkout, arena, repo } = await fakeHome();
    t.after(() => rm(home, { recursive: true, force: true }));
    const secret = join(home, ".ssh/id_ed25519");
    await mkdir(join(home, ".ssh"));
    await writeFile(secret, "PRIVATE-KEY-TEXT\n");
    await plant(repo, secret);
    const r = run(home, checkout);
    assert.notEqual(r.status, 0, `${name}: it started`);
    assert.match(r.stderr, /link or a special file/, name);
    assert.doesNotMatch(r.stdout, /^CWD=/m, `${name}: omp started`);
    const copied = spawnSync("grep", ["-r", "-l", "PRIVATE-KEY-TEXT", join(home, ".ug")], { encoding: "utf8" });
    assert.equal(copied.stdout, "", `${name}: the secret was copied to ${copied.stdout}`);
    assert.equal(existsSync(join(arena, ".omp/agent/AGENTS.md")), false, `${name}: the arena got the config`);
  }
});

test("omp-arena refuses a config repo with a special file", async (t) => {
  const { home, checkout, repo } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(spawnSync("mkfifo", [join(repo, "skills/fix-bug/pipe")]).status, 0);
  const r = run(home, checkout);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /link or a special file/);
  assert.doesNotMatch(r.stdout, /^CWD=/m, "omp started");
});

test("omp-arena refuses a config repo file with a token shape or the auth broker's bearer, and names the file", async (t) => {
  for (const [label, file, text, token] of [
    ["an Anthropic key", "skills/fix-bug/SKILL.md", `use sk-ant-${"a".repeat(30)}\n`, ""],
    ["a private key", "mcp.json", "-----BEGIN OPENSSH PRIVATE KEY-----\n", ""],
    ["a GitHub token", "models.yml", `apiKey: ghp_${"b".repeat(36)}\n`, ""],
    ["the auth broker's bearer", "AGENTS.md", "token: broker-bearer-1234567890\n", "broker-bearer-1234567890\n"],
  ] as const) {
    const { home, checkout, arena, repo } = await fakeHome();
    t.after(() => rm(home, { recursive: true, force: true }));
    if (token) await writeFile(join(home, ".ug/host/auth/auth-broker.token"), token);
    await writeFile(join(repo, file), text);
    const r = run(home, checkout);
    assert.notEqual(r.status, 0, `${label}: it started`);
    assert.match(r.stderr, new RegExp(`config repo file ${join(repo, file).replace(/[.]/g, "\\.")} holds a token or a key`), label);
    assert.doesNotMatch(r.stdout, /^CWD=/m, `${label}: omp started`);
    assert.equal(existsSync(join(arena, ".omp/agent", file)), false, `${label}: the file reached the arena`);
    const [session] = (await readdir(join(home, ".ug/run"))).filter((n) => n.startsWith("session."));
    assert.equal(existsSync(join(home, ".ug/run", session, "secret-values")), false, `${label}: the bearer copy stayed in the run folder`);
  }
});

test("omp-arena refuses an unknown marker in the config repo's models.yml", async (t) => {
  const { home, checkout, repo } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(repo, "models.yml"), 'apiKey: "@ENGINE_TOKEN@"\n');
  const r = run(home, checkout);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown placeholder @ENGINE_TOKEN@/);
  assert.doesNotMatch(r.stdout, /^CWD=/m, "omp started");
});

test("omp-arena with no config repo warns, starts, and leaves the arena's config as it is", async (t) => {
  for (const [label, setup] of [
    ["no path file", (home: string) => rm(join(home, ".ug/host/config-repo"))],
    ["a path to nothing", (home: string) => writeFile(join(home, ".ug/host/config-repo"), `${join(home, "gone")}\n`)],
  ] as const) {
    const { home, checkout, arena } = await fakeHome();
    t.after(() => rm(home, { recursive: true, force: true }));
    assert.equal(run(home, checkout).status, 0);
    await writeFile(agentFile(arena, "RULES.md"), "kept\n");
    await setup(home);
    const r = run(home, checkout);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.match(r.stderr, /keeps the rules, skills, settings, and models\.yml that the arena has/, label);
    assert.match(r.stdout, /^CWD=/m, `${label}: omp did not start`);
    assert.equal(await readFile(agentFile(arena, "AGENTS.md"), "utf8"), "# owner rules\n", label);
    assert.equal(await readFile(agentFile(arena, "RULES.md"), "utf8"), "kept\n", label);
  }
});

test("omp-arena reads a config repo path that starts with ~/, and warns when the repo has no models.yml", async (t) => {
  const { home, checkout, arena, repo } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(home, checkout).status, 0);
  await writeFile(join(home, ".ug/host/config-repo"), "~/Developer/agent-config\n");
  await writeFile(join(repo, "AGENTS.md"), "# changed\n");
  await rm(join(repo, "models.yml"));
  const r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(agentFile(arena, "AGENTS.md"), "utf8"), "# changed\n");
  assert.match(r.stderr, /has no models\.yml/);
  assert.equal(existsSync(agentFile(arena, "models.yml")), false, "the old models.yml stayed");
});

test("omp-arena: another spelling of a config file that an agent planted does not outlast a start", async (t) => {
  const { home, checkout, arena } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(home, checkout).status, 0);
  const planted = ["models.yaml", "keybindings.json", "keybindings.yaml", ".mcp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml", "settings.json"];
  for (const name of planted) await writeFile(agentFile(arena, name), "planted\n");
  const r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  for (const name of planted) assert.equal(existsSync(agentFile(arena, name)), false, `${name} stayed`);
});

test("omp-arena refuses a config repo with models.yaml, whose gateway markers it would not fill", async (t) => {
  const { home, checkout, arena, repo } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(repo, "models.yaml"), 'apiKey: "@GATEWAY_TOKEN@"\n');
  const r = run(home, checkout);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /name it models\.yml/);
  assert.doesNotMatch(r.stdout, /^CWD=/m, "omp started");
  assert.equal(existsSync(agentFile(arena, "models.yaml")), false);
});

// --- the arena backup's freshness (docs/SPEC.md, B10) -------------------------------------------------

test("omp-arena warns when the arena backup never ran or is over an hour old, and is quiet when it is fresh", async (t) => {
  const { home, checkout } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const backup = join(home, ".ug/host/backup");
  await mkdir(backup, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  let r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /the local arena backup has never run/);
  await writeFile(join(backup, "last-local"), `${now - 2 * 3600}\n`);
  r = run(home, checkout);
  assert.match(r.stderr, /the last local arena backup is 1[12][0-9] minutes old/);
  await writeFile(join(backup, "last-local"), "garbage\n");
  r = run(home, checkout);
  assert.match(r.stderr, /the local arena backup has never run/, "a garbled time counts as fresh");
  await writeFile(join(backup, "last-local"), `${now - 60}\n`);
  r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /arena backup/);
  assert.match(r.stdout, /^CWD=/m, "omp did not start");
});

test("omp-arena checks the remote backup too, once the owner names a remote repo", async (t) => {
  const { home, checkout } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const backup = join(home, ".ug/host/backup");
  await mkdir(backup, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  await writeFile(join(backup, "last-local"), `${now}\n`);
  await writeFile(join(backup, "remote"), "sftp:owner@v100-server:backups/mac-arena\n");
  let r = run(home, checkout);
  assert.match(r.stderr, /the remote arena backup has never run/);
  assert.doesNotMatch(r.stderr, /local arena backup/);
  await writeFile(join(backup, "last-remote"), `${now - 7200}\n`);
  r = run(home, checkout);
  assert.match(r.stderr, /the last remote arena backup is \d+ minutes old/);
});
