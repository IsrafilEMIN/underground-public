import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const SRC = join(import.meta.dirname, "../..");
const RENDER = join(SRC, "host/sandbox/render-settings");
const NODE = "/opt/homebrew/bin/node";
const skip = process.platform !== "darwin" || !existsSync(NODE) ? "needs macOS and /opt/homebrew/bin/node" : false;
const GATEWAY = "100.64.0.1:4000";
const ENGINE = "100.64.0.2:8081";
const IFCONFIG = "lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\n\tinet 127.0.0.1 netmask 0xff000000\nutun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280\n\tinet 100.64.0.1 --> 100.64.0.1 netmask 0xffffffff\n";

type Settings = {
  filesystem: { allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
  network: { allowedDomains: string[]; allowUnixSockets: string[] };
};
type Fixture = { home: string; repo: string; omp: string; stateRoot: string; sessionsRoot: string; args: (name: string, binding: string) => string[] };
type Result = { status: number | null; stdout: string; stderr: string };

async function put(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode });
}

async function makeRole(home: string, name: string, binding: string): Promise<void> {
  await put(join(home, ".agents/roles", binding, "network-allowlist"), "@GATEWAY@\n@ENGINE@\n");
  await mkdir(join(home, ".ug/omp/underground/state"), { recursive: true });
  if (binding !== "author") await mkdir(join(home, ".ug/git", name), { recursive: true });
}

async function makeFixture(): Promise<Fixture> {
  const home = await tempDir(join(tmpdir(), "ugr-"));
  for (const file of ["admin.ts", "client.ts", "protocol.ts", "gateway.ts", "owner-files.ts"]) {
    await put(join(home, ".agents/broker", file), await readFile(join(SRC, "host/broker", file), "utf8"));
  }
  await put(join(home, ".agents/sandbox/render-settings.ts"), await readFile(join(SRC, "host/sandbox/render-settings.ts"), "utf8"));
  await put(join(home, ".agents/sandbox/srt-settings.template.json"), await readFile(join(SRC, "host/sandbox/srt-settings.template.json"), "utf8"));
  for (const file of ["policy.yml", "models.yml", "hooks/pre/concise-reply.ts", "hooks/pre/role-rules.ts"]) {
    await put(join(home, ".agents/roles", file), await readFile(join(SRC, "host/roles", file), "utf8"));
  }
  await put(join(home, ".config/underground-broker/addresses"), `gateway=${GATEWAY}\nengine=${ENGINE}\n`, 0o600);
  await put(join(home, ".config/underground-broker/roles"), "author author\ncode-review code-review\nsec2 security-review\n", 0o600);
  await put(join(home, "stub-bin/ifconfig"), `#!/bin/sh\nprintf '%s' '${IFCONFIG}'\n`, 0o755);
  for (const name of ["author", "code-review"]) await makeRole(home, name, name);
  await mkdir(join(home, ".ug/omp/agent/hooks/pre"), { recursive: true });
  const setup = spawnSync(NODE, [join(home, ".agents/broker/admin.ts"), "gateway-setup"], { env: { HOME: home }, encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);
  const repo = join(home, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const repoHash = createHash("sha256").update(repo).digest("hex").slice(0, 8);
  const omp = join(home, ".ug/omp");
  const stateRoot = join(omp, "underground/state");
  const sessionsRoot = join(omp, "agent/sessions");
  const args = (name: string, binding: string): string[] => [
    name,
    binding,
    repo,
    repoHash,
    join(stateRoot, "s1"),
    join(sessionsRoot, "ug-repo"),
    join(stateRoot, "s1/predict.sock"),
  ];
  return { home, repo, omp, stateRoot, sessionsRoot, args };
}

function render(home: string, args: string[], env: Record<string, string> = {}): Result {
  const run = spawnSync("/bin/bash", [RENDER, ...args], { env: { HOME: home, PATH: `${join(home, "stub-bin")}:/usr/bin:/bin`, ...env }, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

async function rendered(home: string, args: string[], env: Record<string, string> = {}): Promise<{ file: string; settings: Settings; stderr: string }> {
  const run = render(home, args, env);
  assert.equal(run.status, 0, run.stderr);
  const file = run.stdout.trim().split("\n").at(-1) ?? "";
  const settings: Settings = JSON.parse(await readFile(file, "utf8"));
  return { file, settings, stderr: run.stderr };
}

async function settingsFiles(home: string): Promise<string[]> {
  const dir = join(home, ".agents/sandbox/run");
  return existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".json")) : [];
}

async function refused(home: string, args: string[], status: number | "any", pattern: RegExp, what: string, env: Record<string, string> = {}): Promise<void> {
  const before = await settingsFiles(home);
  const run = render(home, args, env);
  if (status === "any") assert.notEqual(run.status, 0, what);
  else assert.equal(run.status, status, `${what}: ${run.stderr}`);
  assert.match(run.stderr, pattern, what);
  assert.equal(run.stdout, "", what);
  assert.deepEqual(await settingsFiles(home), before, `${what}: a settings file was written`);
}

async function editTemplate(home: string, edit: (t: Settings & Record<string, unknown>) => void): Promise<void> {
  const path = join(home, ".agents/sandbox/srt-settings.template.json");
  const template = JSON.parse(await readFile(path, "utf8"));
  edit(template);
  await writeFile(path, JSON.stringify(template));
}

const covers = (grants: string[], path: string): boolean =>
  grants.some((g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}(?:/.*)?$`).test(path));

const writable = (settings: Settings, path: string): boolean => covers(settings.filesystem.allowWrite, path) && !covers(settings.filesystem.denyWrite, path);

test("render-settings grants every role the one state folder and the one session folder of the repo, and no broker socket for a repo with no origin", { skip }, async () => {
  const { home, stateRoot, sessionsRoot, args } = await makeFixture();
  for (const [name, binding] of [["author", "author"], ["code-review", "code-review"]] as const) {
    const state = join(stateRoot, "s1");
    const sessions = join(sessionsRoot, "ug-repo");
    const predict = join(state, "predict.sock");
    const { settings } = await rendered(home, args(name, binding));
    assert.ok((await stat(state)).isDirectory(), `${name}: state folder made`);
    assert.ok((await stat(sessions)).isDirectory(), `${name}: session folder made`);
    assert.ok(settings.filesystem.allowRead.includes(state), `${name}: state not readable`);
    assert.ok(settings.filesystem.allowWrite.includes(state), `${name}: state not writable`);
    assert.deepEqual(settings.network.allowUnixSockets, [state, predict], name);
  }
});

test("render-settings refuses a wrong argument count, an invalid role name, binding role, or repo hash with exit 64, and an empty session folder, with no settings", { skip }, async () => {
  const { home, args } = await makeFixture();
  await makeRole(home, "../escape", "author");
  const ok = args("author", "author");
  await refused(home, ok.slice(0, 6), 64, /^usage:/, "6 arguments");
  await refused(home, [...ok, "extra"], 64, /^usage:/, "8 arguments");
  for (const name of ["../escape", "Author", "a".repeat(33), "-author"]) {
    await refused(home, [name, ...ok.slice(1)], 64, /^usage:/, name);
  }
  for (const binding of ["admin", "Author", "", "author "]) {
    await refused(home, ["author", binding, ...ok.slice(2)], 64, /^usage:/, `binding ${JSON.stringify(binding)}`);
  }
  for (const hash of ["", "0000000", "ABCDEF12", "../../x"]) {
    await refused(home, [...ok.slice(0, 3), hash, ...ok.slice(4)], 64, /^usage:/, `hash ${JSON.stringify(hash)}`);
  }
  const noSession = [...ok];
  noSession[5] = "";
  await refused(home, noSession, 1, /session folder is empty/, "empty session folder");
  await rendered(home, ok);
});

test("render-settings refuses a missing repo folder, template, omp root, allowlist, or reviewer store folder, and an omp root or store folder that is a symlink", { skip }, async () => {
  const { home, omp, args } = await makeFixture();
  const missingRepo = args("author", "author");
  missingRepo[2] = join(home, "gone");
  await refused(home, missingRepo, 1, /repo folder not found/, "repo missing");
  await rename(omp, join(home, "omp-real"));
  await refused(home, args("author", "author"), 1, /omp root is not a folder|cannot write .*\.ug\/omp\//, "omp root missing");
  await symlink(join(home, "omp-real"), omp);
  await refused(home, args("author", "author"), 1, /omp root is not a folder/, "omp root symlink");
  await rm(omp);
  await rename(join(home, "omp-real"), omp);
  await mkdir(join(omp, "underground/state"), { recursive: true });
  await refused(home, args("sec2", "security-review"), 1, /no network allowlist for role security-review/, "allowlist missing");
  await put(join(home, ".agents/roles/security-review/network-allowlist"), "@GATEWAY@\n");
  await refused(home, args("sec2", "security-review"), 1, /reviewer store folder is not a folder/, "store folder missing");
  await symlink(join(home, ".ug/git/code-review"), join(home, ".ug/git/sec2"));
  await refused(home, args("sec2", "security-review"), 1, /reviewer store folder is not a folder/, "store folder symlink");
  const template = join(home, ".agents/sandbox/srt-settings.template.json");
  const text = await readFile(template, "utf8");
  await rm(template);
  await refused(home, args("author", "author"), 1, /template not found/, "template missing");
  await writeFile(template, text);
  await rendered(home, args("author", "author"));
});

test("render-settings stops with the addresses refusal of the broker admin, and with an ifconfig failure, before it writes settings", { skip }, async () => {
  const { home, args } = await makeFixture();
  const addresses = join(home, ".config/underground-broker/addresses");
  await writeFile(addresses, "gateway=100.64.0.1\nengine=100.64.0.2:8081\n");
  const bad = render(home, args("author", "author"));
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /broker admin: .*addresses: gateway=100\.64\.0\.1 is not <ip>:<port>/);
  assert.doesNotMatch(bad.stderr, /on no interface/);
  assert.deepEqual(await settingsFiles(home), []);
  await writeFile(addresses, `gateway=${GATEWAY}\nengine=${ENGINE}\n`);
  await put(join(home, "stub-bin/ifconfig"), `#!/bin/sh\nprintf '%s' '${IFCONFIG}'\nexit 1\n`, 0o755);
  await refused(home, args("author", "author"), "any", /ifconfig failed/, "ifconfig fails");
});

test("render-settings refuses a repo folder whose .git is missing, a file, or a symlink", { skip }, async () => {
  const { home, repo, args } = await makeFixture();
  await rm(join(repo, ".git"), { recursive: true });
  for (const [name, binding] of [["author", "author"], ["code-review", "code-review"]] as const) {
    await refused(home, args(name, binding), "any", /repo folder has no \.git folder/, `${name}: no .git`);
  }
  await writeFile(join(repo, ".git"), "gitdir: /elsewhere\n");
  await refused(home, args("author", "author"), "any", /repo folder has no \.git folder/, ".git file");
  await rm(join(repo, ".git"));
  await mkdir(join(home, "real-git"));
  await symlink(join(home, "real-git"), join(repo, ".git"));
  await refused(home, args("author", "author"), "any", /repo folder has no \.git folder/, ".git symlink");
});

test("render-settings refuses an author session when a git path it would grant is a symlink", { skip }, async () => {
  const { home, repo, args } = await makeFixture();
  await mkdir(join(home, "elsewhere"));
  for (const p of ["objects", "refs", "logs", "packed-refs", "packed-refs.lock", "packed-refs.new", "worktrees"]) {
    const path = join(repo, ".git", p);
    await rm(path, { recursive: true, force: true });
    await symlink(join(home, "elsewhere"), path);
    await refused(home, args("author", "author"), "any", new RegExp(`git path is a symlink: .*/\\.git/${p.replaceAll(".", "\\.")}$`, "m"), p);
    await rm(path);
  }
  await rendered(home, args("author", "author"));
});

test("render-settings grants a state, session, or worktree folder only when it is a real folder directly in its root", { skip }, async () => {
  const { home, stateRoot, sessionsRoot, args } = await makeFixture();
  const state = stateRoot;
  const sessions = sessionsRoot;
  await mkdir(join(state, "other"));
  await symlink(join(state, "other"), join(state, "s1"));
  await refused(home, args("author", "author"), "any", /state folder is a symlink/, "state symlink");
  await rm(join(state, "s1"));
  for (const where of [join(state, "a/b"), join(home, "elsewhere/s1")]) {
    const a = args("author", "author");
    a[4] = where;
    await refused(home, a, "any", /state folder is not directly in /, where);
  }
  for (const where of [join(sessions, "a/b"), join(home, "elsewhere/ug-repo")]) {
    const a = args("author", "author");
    a[5] = where;
    await refused(home, a, "any", /session folder is not directly in /, where);
  }
  await mkdir(sessions, { recursive: true });
  await mkdir(join(sessions, "other"));
  await symlink(join(sessions, "other"), join(sessions, "ug-repo"));
  await refused(home, args("author", "author"), "any", /session folder is a symlink/, "session symlink");
  await rm(join(sessions, "ug-repo"));

  const slash = args("author", "author");
  slash[4] = `${join(state, "s1")}//`;
  const { settings } = await rendered(home, slash);
  assert.ok(settings.filesystem.allowWrite.includes(join(state, "s1")), "trailing slash");
  const wt = settings.filesystem.allowRead.find((p) => p.startsWith(join(home, ".omp/wt") + "/"));
  assert.ok(wt !== undefined, JSON.stringify(settings.filesystem.allowRead));
  await rm(wt, { recursive: true });
  await mkdir(join(home, ".omp/wt/other"));
  await symlink(join(home, ".omp/wt/other"), wt);
  await refused(home, args("author", "author"), "any", /worktree folder is a symlink/, "worktree symlink");
});

test("render-settings refuses a template with a placeholder it does not know", { skip }, async () => {
  const { home, args } = await makeFixture();
  await editTemplate(home, (t) => t.filesystem.allowRead.push("@HOME@/x/@NOPE@"));
  await refused(home, args("author", "author"), "any", /unknown placeholder @NOPE@/, "unknown placeholder");
});

test("render-settings adds the real folder of each skill link under an approved root, and skips every other link", { skip }, async () => {
  const { home, args } = await makeFixture();
  const root = join(home, "Developer/Projects/arkan/skills");
  const skills = join(home, ".agents/skills");
  await mkdir(join(root, "good"), { recursive: true });
  await mkdir(join(home, "elsewhere/skill"), { recursive: true });
  await mkdir(join(home, "Developer/Projects/arkan/skills-evil/x"), { recursive: true });
  await writeFile(join(root, "notes.md"), "x");
  await mkdir(skills, { recursive: true });
  await mkdir(join(skills, "plain"));
  const base = await rendered(home, args("code-review", "code-review"));
  await symlink(join(root, "good"), join(skills, "good"));
  await symlink(root, join(skills, "root"));
  await symlink(join(root, "notes.md"), join(skills, "file"));
  await symlink(join(home, "nowhere"), join(skills, "gone"));
  await symlink(join(home, "elsewhere/skill"), join(skills, "out"));
  await symlink(join(home, "Developer/Projects/arkan/skills-evil/x"), join(skills, "twin"));
  await symlink(join(home, "elsewhere/skill"), join(root, "esc"));
  await symlink(join(root, "esc"), join(skills, "esc"));
  const { settings, stderr } = await rendered(home, args("code-review", "code-review"));
  const allowRead = settings.filesystem.allowRead;
  assert.deepEqual(allowRead.slice(0, base.settings.filesystem.allowRead.length), base.settings.filesystem.allowRead);
  assert.deepEqual(allowRead.slice(base.settings.filesystem.allowRead.length).sort(), [root, join(root, "good")].sort());
  for (const name of ["file", "gone"]) assert.match(stderr, new RegExp(`skill link has no folder target, skipped: .*/\\.agents/skills/${name}\\n`), name);
  for (const name of ["out", "twin", "esc"]) assert.match(stderr, new RegExp(`skill link target is not under an approved root, skipped: .*/\\.agents/skills/${name} -> `), name);
});

test("render-settings accepts a *.domain wildcard on the network allowlist", { skip }, async () => {
  const { home, args } = await makeFixture();
  await writeFile(join(home, ".agents/roles/author/network-allowlist"), "@GATEWAY@\n*.example.com\n");
  const { settings } = await rendered(home, args("author", "author"));
  assert.deepEqual(settings.network.allowedDomains, [GATEWAY, "*.example.com"]);
});

test("render-settings refuses a template that grants writes to the .git folder of the repo", { skip }, async () => {
  const { home, args } = await makeFixture();
  for (const grant of ["@HOME@/repo/.git", "@HOME@/repo/.git/", "@HOME@/repo/./.git"]) {
    await editTemplate(home, (t) => {
      t.filesystem.allowWrite = ["@ROLE@", grant];
    });
    await refused(home, args("author", "author"), "any", /allowWrite grants the \.git folder .*\/repo\/\.git/, grant);
  }
  await editTemplate(home, (t) => {
    t.filesystem.allowWrite = ["@ROLE@", "@HOME@/repo/.git/objects"];
  });
  await rendered(home, args("author", "author"));
});

test("render-settings refuses a template that gives a reviewer role a grant on the repo folder, and allows it for the author", { skip }, async () => {
  const { home, args } = await makeFixture();
  for (const [list, grant] of [["allowRead", "@HOME@/repo"], ["allowRead", "@HOME@"], ["allowWrite", "@HOME@/repo/"]] as const) {
    await editTemplate(home, (t) => {
      t.filesystem[list].push(grant);
    });
    await refused(home, args("code-review", "code-review"), "any", /a reviewer role gets a grant on the repo folder .*\/repo: /, `${list} ${grant}`);
    await rendered(home, args("author", "author"));
    await editTemplate(home, (t) => {
      t.filesystem[list] = t.filesystem[list].filter((p) => p !== grant);
    });
  }
  await rendered(home, args("code-review", "code-review"));
});

test("render-settings refuses a template that gives a reviewer role a grant inside the repo folder", { skip }, async () => {
  const { home, args } = await makeFixture();
  await editTemplate(home, (t) => {
    t.filesystem.allowRead.push("@HOME@/repo/src");
  });
  await refused(home, args("code-review", "code-review"), "any", /a reviewer role gets a grant on the repo folder/, "grant inside the repo");
});

test("render-settings roots each relative denyWrite entry at the repo, and also at the worktree folder for the author", { skip }, async () => {
  const { home, repo, args } = await makeFixture();
  const author = (await rendered(home, args("author", "author"))).settings;
  const wt = author.filesystem.allowRead.find((p) => p.startsWith(join(home, ".omp/wt") + "/"));
  assert.ok(wt !== undefined);
  const reviewer = (await rendered(home, args("code-review", "code-review"))).settings;
  for (const [name, settings, roots] of [["author", author, [repo, wt]], ["code-review", reviewer, [repo]]] as const) {
    const deny = settings.filesystem.denyWrite;
    assert.deepEqual(deny.filter((p) => !p.startsWith("/")), [], `${name}: relative entries left`);
    for (const rel of ["**/.envrc", "**/.git/modules/**/hooks", "**/.vscode", "**/.mcp.json"]) {
      for (const root of roots) assert.ok(deny.includes(`${root}/${rel}`), `${name}: ${root}/${rel}`);
    }
    assert.ok(deny.includes(join(home, ".omp/wt/**/.omp")), `${name}: absolute entry kept`);
    if (name === "code-review") assert.equal(deny.some((p) => p.startsWith(join(home, ".omp/wt") + "/") && p.endsWith(".envrc")), false);
  }
});

test("render-settings denies writes to each owner path of the omp root", { skip }, async () => {
  const { home, omp, args } = await makeFixture();
  for (const [name, binding] of [["author", "author"], ["code-review", "code-review"]] as const) {
    const { settings } = await rendered(home, args(name, binding));
    const agent = join(omp, "agent");
    const owned = [
      "SYSTEM_TEMPLATE.md",
      "PERSONALITY.md",
      "WATCHDOG.md",
      "prefs.yml",
      "models.yaml",
      "models.container.yml",
      ".mcp.json",
      "secrets.yml",
      "lsp.json",
      "managed-skills/x/SKILL.md",
      "tools/x.ts",
      "themes/x.json",
      "prompts/x.md",
    ].map((f) => join(agent, f));
    owned.push(join(omp, "marketplaces.json"), join(omp, "browser-relay/x.js"));
    for (const path of owned) assert.equal(writable(settings, path), false, `${name} writes ${path}`);
    assert.equal(writable(settings, join(agent, "config.yml")), true, `${name} cannot write config.yml`);
  }
});

test("render-settings keeps its run folder private, removes settings older than a day, and writes each settings file new with mode 600", { skip }, async () => {
  const { home, args } = await makeFixture();
  const run = join(home, ".agents/sandbox/run");
  await mkdir(run, { recursive: true, mode: 0o755 });
  await chmod(run, 0o755);
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  for (const name of ["stale.json", "keep.txt"]) {
    await writeFile(join(run, name), "{}");
    await utimes(join(run, name), old, old);
  }
  await writeFile(join(run, "fresh.json"), "{}");
  const { file } = await rendered(home, args("author", "author"));
  assert.equal((await stat(run)).mode & 0o777, 0o700);
  assert.equal(dirname(file), run);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(run)).filter((f) => f !== file.slice(run.length + 1)).sort(), ["fresh.json", "keep.txt"]);

  const preload = join(home, "fixed-random.cjs");
  await writeFile(preload, 'require("node:crypto").randomBytes = (n) => Buffer.alloc(n);\n');
  const fixed = join(run, `${"0".repeat(24)}.json`);
  await writeFile(join(home, "victim"), "keep");
  await symlink(join(home, "victim"), fixed);
  const clash = render(home, args("author", "author"), { NODE_OPTIONS: `--require ${preload}` });
  assert.notEqual(clash.status, 0, clash.stdout);
  assert.match(clash.stderr, /EEXIST/);
  assert.equal(await readFile(join(home, "victim"), "utf8"), "keep");
  await rm(fixed);
  const made = render(home, args("author", "author"), { NODE_OPTIONS: `--require ${preload}` });
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stdout.trim().split("\n").at(-1), fixed);
});

const SRT_PIN = /^srt=(.*)$/m.exec(existsSync(join(SRC, "VERSIONS")) ? (await readFile(join(SRC, "VERSIONS"), "utf8")) : "")?.[1] ?? "";
const SRT_CLI = join(homedir(), ".agents/srt", SRT_PIN, "node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js");
// On the owner's mac install.sh puts the pinned srt in place before its test gate, so this test runs there and fails
// if srt is missing. It skips only inside an agent sandbox, where macOS refuses a nested sandbox profile.
const nested = skip ? null : spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8" });
const srtSkip = skip || (nested !== null && nested.status !== 0 && nested.stderr.includes("sandbox_apply: Operation not permitted") ? "macOS refuses a nested sandbox profile inside this sandbox (sandbox_apply: Operation not permitted)" : false);

test("under the rendered settings, the real srt lets an author write its worktree and refuses a write to an owner file", { skip: srtSkip }, async () => {
  const { home, omp, args } = await makeFixture();
  const { file, settings } = await rendered(home, args("author", "author"));
  const wt = settings.filesystem.allowRead.find((p) => p.startsWith(join(home, ".omp/wt") + "/"));
  assert.ok(wt !== undefined);
  const write = (path: string) =>
    spawnSync(NODE, [SRT_CLI, "--settings", file, "--", "/bin/sh", "-c", 'printf x > "$1"', "_", path], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  const allowed = join(wt, "allowed.txt");
  const ok = write(allowed);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(await readFile(allowed, "utf8"), "x");
  const owner = join(omp, "agent/AGENTS.md");
  await put(owner, "rules");
  const denied = write(owner);
  assert.notEqual(denied.status, 0);
  assert.equal(await readFile(owner, "utf8"), "rules");
});
