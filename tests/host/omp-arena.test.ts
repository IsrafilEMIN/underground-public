import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
const SOCKET = "/tmp/ug-test-broker/author.sock";

const LEAKY_SRT = `const i = process.argv.indexOf("--");
const r = require("child_process").spawnSync(process.argv[i + 1], process.argv.slice(i + 2), { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`;

// A fake omp: the broker registration prints a socket; a session prints what it got and stops.
const FAKE_OMP = `#!/bin/sh
if [ "\${BUN_BE_BUN:-}" = 1 ] && [ "\${2:-}" = session ]; then echo "${SOCKET}"; exit 0; fi
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

async function fakeHome() {
  const home = await tempDir(join(tmpdir(), "omp-arena-"));
  const sys = join(home, ".ug/sys");
  const srtDir = join(sys, "srt", SRT_PIN, "node_modules/@anthropic-ai/sandbox-runtime/dist");
  for (const dir of [join(sys, "omp", OMP_PIN), srtDir, join(sys, "libexec"), join(sys, "agent-bin"), join(sys, "arena"), join(home, ".ug/run"), join(home, ".config/underground-broker"), join(home, ".omp"), join(home, "fakebin"), join(home, "code")]) {
    await mkdir(dir, { recursive: true });
  }
  await exe(join(sys, "omp", OMP_PIN, "omp"), FAKE_OMP);
  await writeFile(join(srtDir, "cli.js"), LEAKY_SRT);
  await copyFile(join(SRC, "host/arena/init"), join(sys, "libexec/ug-arena-init"));
  await chmod(join(sys, "libexec/ug-arena-init"), 0o755);
  await exe(join(sys, "agent-bin/broker"), FAKE_BROKER);
  await copyFile(join(SRC, "host/arena/config.yml"), join(sys, "arena/config.yml"));
  await writeFile(join(sys, "macos-build"), `${BUILD}\n`);
  await exe(join(home, "fakebin/sw_vers"), `#!/bin/sh\ncat "$(dirname "$0")/build"\n`);
  await writeFile(join(home, "fakebin/build"), `${BUILD}\n`);
  await writeFile(join(home, ".config/underground-broker/addresses"), "gateway=192.0.2.1:4000\nengine=192.0.2.2:8081\n");
  await writeFile(join(home, ".omp/auth-gateway.token"), "test-bearer\n");
  const checkout = join(home, "code/proj");
  await mkdir(checkout);
  for (const args of [["init", "-q"], ["remote", "add", "origin", "git@github.com:Test-Owner/proj.git"]]) {
    assert.equal(spawnSync("git", ["-C", checkout, ...args]).status, 0);
  }
  return { home, checkout, arena: join(home, ".ug/home") };
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
  const { home, checkout, arena } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home, checkout, ["--model", "x"], { STRATA_API_KEY: "leak-1", GH_TOKEN: "leak-2", SSH_AUTH_SOCK: "/tmp/leak-3", AWS_SECRET_ACCESS_KEY: "leak-4", NODE_OPTIONS: "--require=/tmp/evil.js" });
  assert.equal(r.status, 0, r.stderr);
  for (const leak of ["leak-1", "leak-2", "leak-3", "leak-4", "evil.js"]) assert.ok(!r.stdout.includes(leak), `${leak} reached omp:\n${r.stdout}`);
  assert.equal(r.envOf("HOME"), arena);
  assert.equal(r.envOf("UG_BROKER_SOCKET"), SOCKET);
  assert.equal(r.envOf("OMP_WORKTREE_DIR"), join(arena, ".omp/wt/Test-Owner-proj"));
  assert.match(r.stdout, new RegExp(`^CWD=${join(arena, "work/Test-Owner/proj")}$`, "m"));
  assert.match(r.stdout, /^ARGS=--model x$/m);
  const remote = spawnSync("git", ["-C", join(arena, "work/Test-Owner/proj"), "remote", "get-url", "origin"], { encoding: "utf8" });
  assert.equal(remote.stdout.trim(), "https://github.com/Test-Owner/proj.git");
});

test("omp-arena: srt may write only the arena, read no part of the real home outside ~/.ug, and reach only two sockets", async (t) => {
  const { home, checkout, arena } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home, checkout);
  assert.equal(r.status, 0, r.stderr);
  const s = await settingsOf(home);
  assert.deepEqual(s.filesystem.allowWrite, [arena]);
  assert.deepEqual(s.filesystem.denyRead, [home]);
  for (const p of s.filesystem.allowRead) assert.ok(p.startsWith(`${home}/.ug/`), `allowRead opens ${p}`);
  assert.ok(!s.filesystem.allowRead.some((p: string) => checkout.startsWith(p) || p.startsWith(checkout)), "the checkout is readable");
  assert.deepEqual(s.network.allowUnixSockets, [SOCKET, join(arena, ".omp/run")]);
  assert.ok(s.network.allowedDomains.every((d: string) => !d.includes("@")), "a placeholder is left");
  assert.equal(s.allowAppleEvents, false);
});

test("omp-arena: a link that an agent planted in the arena does not let the start write outside it", async (t) => {
  const { home, checkout, arena } = await fakeHome();
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
  const { home, checkout } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "elsewhere"));
  await symlink(join(home, "elsewhere"), join(home, ".ug/home"));
  const r = run(home, checkout);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be a folder that you own, not a link/);
  assert.deepEqual(await readdir(join(home, "elsewhere")), []);
});

test("omp-arena refuses a start inside ~/.ug, so the host runs no git in the arena", async (t) => {
  const { home, checkout, arena } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(home, checkout).status, 0);
  const r = run(home, join(arena, "work/Test-Owner/proj"));
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /not inside/);
  assert.ok(!r.stdout.includes("CWD="), "omp started");
});

test("omp-arena refuses --role and --profile", async (t) => {
  const { home, checkout } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const args of [["--role", "code-review"], ["--role=author"], ["--profile", "work"], ["--profile=x"]]) {
    const r = run(home, checkout, args);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.stderr}`);
    assert.ok(!r.stdout.includes("CWD="), `${args.join(" ")}: omp started`);
  }
});

test("omp-arena refuses to start on a macOS build that setup did not prove", async (t) => {
  const { home, checkout } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "fakebin/build"), "OTHER2B\n");
  const r = run(home, checkout);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /setup proved the sandbox on build TEST1A/);
  assert.ok(!r.stdout.includes("CWD="), "omp started");
  await writeFile(join(home, "fakebin/build"), `${BUILD}\n`);
  await rm(join(home, ".ug/sys/macos-build"));
  assert.notEqual(run(home, checkout).status, 0, "it starts with no recorded build");
});

test("omp-arena: a failed sync leaves no half-made clone, and a repo with no GitHub origin starts with no repo", async (t) => {
  const { home, checkout, arena } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, ".ug/sys/agent-bin/fail-sync"), "");
  const failed = run(home, checkout);
  assert.equal(failed.status, 69, failed.stderr);
  assert.ok(!failed.stdout.includes("CWD="), "omp started");
  assert.deepEqual(await readdir(join(arena, "work/Test-Owner")), []);
  assert.equal(spawnSync("git", ["-C", checkout, "remote", "set-url", "origin", "https://gitlab.com/x/proj.git"]).status, 0);
  await rm(join(home, ".ug/sys/agent-bin/fail-sync"));
  const plain = run(home, checkout);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, new RegExp(`^CWD=${join(arena, "work")}$`, "m"));
  assert.equal(plain.envOf("UG_BROKER_SOCKET"), undefined);
});
