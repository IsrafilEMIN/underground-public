import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HELD_DIR, HOLD_MS, KEPT_FILE, MIN_AGE_MS, sweep } from "../../host/gh-broker/sweep.ts";
import type { KeptFile, Probe, SweepOptions, SweepReport } from "../../host/gh-broker/sweep.ts";
import { tempDir } from "../temp.ts";

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: "/dev/null" };
const LATER = (): number => Date.now() + 2 * MIN_AGE_MS;
const NOBODY: Probe = () => Promise.resolve({ ok: true, cwds: ["/"] });

let root: string;
let work: string;
let saved: Record<string, string | undefined>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" }).trim();
}

function branch(name: string): string {
  return git(work, "for-each-ref", "--format=%(objectname)", `refs/heads/${name}`);
}

async function commit(cwd: string, file: string, text = `${file}\n`): Promise<string> {
  await writeFile(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

async function sessionTree(name: string, file = `${name.replace("/", "-")}.txt`): Promise<string> {
  const tree = join(root, "wt", name.replace("/", "-"));
  git(work, "worktree", "add", "--quiet", "-b", name, tree, "main");
  await commit(tree, file);
  return tree;
}

function merge(name: string): void {
  git(work, "merge", "--quiet", "--no-ff", "-m", `merge ${name}`, name);
  git(work, "update-ref", "refs/remotes/origin/main", "main");
}

function run(options: Partial<SweepOptions> = {}): Promise<SweepReport> {
  return sweep({ cwd: work, base: "main", now: LATER, probe: NOBODY, ...options });
}

async function keptFile(): Promise<KeptFile> {
  return JSON.parse(await readFile(join(work, ".git", KEPT_FILE), "utf8"));
}

beforeEach(async () => {
  saved = Object.fromEntries(Object.keys(GIT_ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, GIT_ENV);
  root = await tempDir(join(tmpdir(), "ug-sweep-"));
  work = join(root, "clone");
  await mkdir(work);
  git(work, "init", "--quiet", "-b", "main");
  await commit(work, ".gitignore", ".env\nnode_modules/\n");
  git(work, "update-ref", "refs/remotes/origin/main", "main");
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

test("a merged, clean, unused session worktree goes with its branch, and the kept list is empty", async () => {
  const tree = await sessionTree("wt/a");
  merge("wt/a");

  const report = await run();
  assert.equal(existsSync(tree), false);
  assert.equal(branch("wt/a"), "");
  assert.deepEqual(report.kept, []);
  assert.deepEqual((await keptFile()).kept, []);
});

test("a worktree with an untracked file stays and is listed as unsaved", async () => {
  const tree = await sessionTree("wt/a");
  merge("wt/a");
  await writeFile(join(tree, "draft.txt"), "draft\n");

  const report = await run();
  assert.equal(existsSync(join(tree, "draft.txt")), true);
  assert.deepEqual(report.kept, [{ branch: "wt/a", worktree: tree, reason: "unsaved files", detail: "1 file: draft.txt", parked: false }]);
  assert.deepEqual((await keptFile()).kept, report.kept);
});

test("a merged worktree with ignored files goes, and its ignored files wait in the held folder under their own paths", async () => {
  const tree = await sessionTree("wt/a");
  merge("wt/a");
  await writeFile(join(tree, ".env"), "TOKEN=x\n");
  await mkdir(join(tree, "node_modules", "x"), { recursive: true });
  await writeFile(join(tree, "node_modules", "x", "i.js"), "\n");
  const now = LATER();

  const report = await run({ now: () => now });
  const held = join(work, ".git", HELD_DIR, `${now}-${encodeURIComponent("wt/a")}`);
  assert.equal(existsSync(tree), false);
  assert.equal(branch("wt/a"), "");
  assert.deepEqual(report.kept, []);
  assert.equal(await readFile(join(held, ".env"), "utf8"), "TOKEN=x\n");
  assert.equal(existsSync(join(held, "node_modules", "x", "i.js")), true);
});

test("a worktree whose commits are not in main keeps its ignored files in place", async () => {
  const tree = await sessionTree("wt/a");
  await writeFile(join(tree, ".env"), "TOKEN=x\n");

  const report = await run();
  assert.deepEqual(report.kept.map((k) => [k.branch, k.reason]), [["wt/a", "not in main"]]);
  assert.equal(existsSync(join(tree, ".env")), true);
  assert.equal(existsSync(join(work, ".git", HELD_DIR)), false);
});

test("held files are deleted once they are 14 days old, and not before", async () => {
  const now = LATER();
  const held = join(work, ".git", HELD_DIR);
  const old = join(held, `${now - HOLD_MS}-wt%2Fold`);
  const young = join(held, `${now - HOLD_MS + 1}-wt%2Fyoung`);
  await mkdir(old, { recursive: true });
  await mkdir(young, { recursive: true });

  await run({ now: () => now });
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(young), true);
});

test("a clean worktree with commits that are not in main stays and is listed", async () => {
  const tree = await sessionTree("wt/a");

  const report = await run();
  assert.equal(existsSync(tree), true);
  assert.deepEqual(report.kept.map((k) => [k.branch, k.reason]), [["wt/a", "not in main"]]);
});

test("a worktree made in the last 10 minutes stays and is not listed, so a starting session keeps its new worktree", async () => {
  git(work, "worktree", "add", "--quiet", "-b", "wt/new", join(root, "wt", "new"), "main");

  const report = await run({ now: Date.now });
  assert.equal(existsSync(join(root, "wt", "new")), true);
  assert.equal(branch("wt/new"), git(work, "rev-parse", "main"));
  assert.deepEqual(report.kept, []);
});

test("a worktree a session runs in stays and is not listed, and a failed probe keeps every worktree", async () => {
  const tree = await sessionTree("wt/a");
  merge("wt/a");

  const busy = await run({ probe: () => Promise.resolve({ ok: true, cwds: [join(tree, "sub")] }) });
  assert.equal(existsSync(tree), true);
  assert.deepEqual(busy.kept, []);

  const blind = await run({ probe: () => Promise.resolve({ ok: false, reason: "lsof is missing" }) });
  assert.equal(existsSync(tree), true);
  assert.deepEqual(blind.kept, []);
  assert.ok(blind.lines.some((line) => line.includes("every worktree stays: lsof is missing")), blind.lines.join("\n"));
});

test("a branch whose worktree folder is gone loses the stale entry, then goes if merged and stays listed if not", async () => {
  const merged = await sessionTree("wt/a");
  merge("wt/a");
  await rm(merged, { recursive: true, force: true });
  const open = await sessionTree("wt/b");
  await rm(open, { recursive: true, force: true });

  const report = await run();
  assert.equal(branch("wt/a"), "");
  assert.notEqual(branch("wt/b"), "");
  assert.equal(git(work, "worktree", "list", "--porcelain").includes(open), false);
  assert.deepEqual(report.kept.map((k) => [k.branch, k.worktree, k.reason]), [["wt/b", undefined, "not in main"]]);
});

test("a parked branch is still listed, marked parked", async () => {
  await sessionTree("wt/a");
  git(work, "config", "branch.wt/a.ugParked", "true");

  const report = await run();
  assert.deepEqual(report.kept.map((k) => [k.branch, k.parked]), [["wt/a", true]]);
});

test("a branch outside agent/ and wt/ and the branch the clone has checked out are left alone", async () => {
  git(work, "-c", "core.logAllRefUpdates=false", "branch", "feature");

  const report = await run();
  assert.notEqual(branch("feature"), "");
  assert.notEqual(branch("main"), "");
  assert.deepEqual(report.kept, []);
});

test("a sweep with no origin copy of the default branch refuses and deletes nothing", async () => {
  await sessionTree("wt/a");
  merge("wt/a");
  git(work, "update-ref", "-d", "refs/remotes/origin/main");

  await assert.rejects(run(), /the clone has no refs\/remotes\/origin\/main; run gh-broker sync first/);
  assert.notEqual(branch("wt/a"), "");
});
