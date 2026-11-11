import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const ROOT = join(import.meta.dirname, "../..");
const PATTERNS = join(ROOT, "host/secret-patterns");
const DRIVER = 'set -Eeuo pipefail; source "$1"; source "$2"; stage_plugins "$3" "$4" "$5" "$6" "$7"';

type Run = { status: number | null; stdout: string; stderr: string };

type Fixture = {
  home: string;
  out: string;
  base: string;
  stage: (repos: string[]) => Promise<Run>;
};

const macSkip = process.platform !== "darwin" && "needs macOS plutil";

async function fixture(t: { after: (fn: () => unknown) => void }): Promise<Fixture> {
  const base = await tempDir(join(tmpdir(), "stage-plugins-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const out = join(base, "out");
  const secrets = join(base, "secrets");
  const list = join(base, "plugin-repos");
  await mkdir(home, { recursive: true });
  await mkdir(out, { recursive: true });
  await writeFile(secrets, "");
  const stage = async (repos: string[]): Promise<Run> => {
    await writeFile(list, `${repos.join("\n")}\n`);
    return spawnSync("bash", ["-c", DRIVER, "bash", join(ROOT, "host/lib/ug.bash"), join(ROOT, "host/lib/stage.bash"), list, out, home, secrets, PATTERNS], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
    });
  };
  return { home, out, base, stage };
}

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", dir, "-c", "user.email=o@x", "-c", "user.name=o", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

async function repo(path: string, files: Record<string, string>): Promise<void> {
  await mkdir(path, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const at = join(path, rel);
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, body);
  }
  git(path, "init", "-q", "-b", "main");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "one");
}

async function arkanRepo(path: string): Promise<void> {
  await repo(path, {
    ".claude-plugin/plugin.json": '{ "name": "arkan" }',
    "skills/arkan-mode/SKILL.md": "# arkan-mode\n",
    "skills/tdd/SKILL.md": "# tdd\n",
    "agents/arkan-agent.md": "---\nname: arkan-agent\ndescription: delegate\n---\n# arkan agent\n",
    "agents/comment-sicko.md": "---\nname: comment-sicko\ndescription: comments\n---\n# sicko agent\n",
  });
}

test("[mac] stage_plugins stages each plugin repo's last commit under <out>/plugins/<name> and the ok line counts skills and agents", { skip: macSkip }, async (t) => {
  const f = await fixture(t);
  const arkan = join(f.home, "src/arkan");
  await arkanRepo(arkan);
  const r = await f.stage([`${arkan}`, ""]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(f.out, "plugins/arkan/.claude-plugin/plugin.json")));
  assert.ok(existsSync(join(f.out, "plugins/arkan/skills/arkan-mode/SKILL.md")));
  assert.ok(existsSync(join(f.out, "plugins/arkan/agents/comment-sicko.md")));
  assert.ok(r.stdout.includes(`plugin repo ${arkan}: plugin arkan: 2 skills, 2 agents`), r.stdout);
});

test("[mac] stage_plugins stages a plugin whose manifest is the root plugin.json and one without agents/ still works", { skip: macSkip }, async (t) => {
  const f = await fixture(t);
  const solo = join(f.home, "src/solo");
  await repo(solo, { "plugin.json": '{ "name": "solo" }', "skills/only/SKILL.md": "# only\n" });
  const r = await f.stage([solo]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(f.out, "plugins/solo/skills/only/SKILL.md")));
  assert.ok(!existsSync(join(f.out, "plugins/solo/agents")));
  assert.match(r.stdout, /plugin repo .*\/solo: plugin solo: 1 skills, 0 agents/);
});

test("[mac] stage_plugins refuses a plugin repo with a link and stages nothing of it", { skip: macSkip }, async (t) => {
  const f = await fixture(t);
  const bad = join(f.home, "src/bad");
  await repo(bad, { "plugin.json": '{ "name": "bad" }', "skills/one/SKILL.md": "# one\n" });
  await symlink("../../secrets", join(bad, "skills/one/link"));
  git(bad, "add", "-A");
  git(bad, "commit", "-q", "-m", "link");
  const r = await f.stage([bad]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the plugin repo .*\/bad has a link or a special file, which the agent must not get: skills\/one\/link/);
  assert.ok(!existsSync(join(f.out, "plugins/bad")));
});

test("[mac] stage_plugins stops when a plugin agent name is already in the config repo's staged agents/", { skip: macSkip }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.out, "agents"), { recursive: true });
  await writeFile(join(f.out, "agents/arkan-agent.md"), "# from the config repo\n");
  const arkan = join(f.home, "src/arkan");
  await arkanRepo(arkan);
  const r = await f.stage([arkan]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the agent arkan-agent of the plugin repo .*\/arkan is also in the config repo or an earlier plugin; rename one/);
  assert.ok(!existsSync(join(f.out, "plugins/arkan")));
});

test("[mac] stage_plugins stops when an agent file's frontmatter name differs from its file name", { skip: macSkip }, async (t) => {
  const f = await fixture(t);
  const odd = join(f.home, "src/odd");
  await repo(odd, { "plugin.json": '{ "name": "odd" }', "agents/helper.md": "---\nname: arkan-agent\ndescription: x\n---\n" });
  const r = await f.stage([odd]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the agent file helper\.md of the plugin repo .*\/odd has another name in its frontmatter/);
  assert.ok(!existsSync(join(f.out, "plugins/odd")));
});

test("[mac] stage_plugins stops when one plugin name is named twice in plugin-repos", { skip: macSkip }, async (t) => {
  const f = await fixture(t);
  const arkan = join(f.home, "src/arkan");
  await arkanRepo(arkan);
  const r = await f.stage([arkan, arkan]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the plugin arkan is named twice in plugin-repos/);
});

test("[mac] stage_plugins stops when a plugin repo has no manifest in its last commit", { skip: macSkip }, async (t) => {
  const f = await fixture(t);
  const plain = join(f.home, "src/plain");
  await repo(plain, { "README.md": "# no manifest\n", "skills/one/SKILL.md": "# one\n" });
  const r = await f.stage([plain]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the plugin repo .*\/plain has no plugin manifest at \.claude-plugin\/plugin\.json or plugin\.json in its last commit/);
  assert.ok(!existsSync(join(f.out, "plugins/plain")));
});

test("[mac] stage_plugins stops when a plugin repo path is outside the owner home", { skip: macSkip }, async (t) => {
  const f = await fixture(t);
  const out = join(f.base, "elsewhere/ark");
  await repo(out, { "plugin.json": '{ "name": "ark" }', "skills/one/SKILL.md": "# one\n" });
  const r = await f.stage([out]);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(`the plugin repo ${out} is not inside ${f.home}; setup reads plugin repos only from your home`), r.stderr);
  assert.ok(!existsSync(join(f.out, "plugins")));
});
