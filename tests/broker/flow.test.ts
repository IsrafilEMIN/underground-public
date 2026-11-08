import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { defaultConfig, startServer, stopServer } from "../../host/gh-broker/server.ts";
import type { GhBroker, ServerConfig } from "../../host/gh-broker/server.ts";
import { fakeTokens, tokenRemote } from "./fake-app.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const BRANCH = "agent/x";
const BROKER_DIR = join(import.meta.dirname, "../../host/gh-broker");
const NODE = process.execPath;
const REVIEWERS = ["code-review", "security-review", "risk-review"] as const;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const execFileAsync = promisify(execFile);

type Role = "author" | (typeof REVIEWERS)[number];

let root: string;
let config: ServerConfig;
let broker: GhBroker | undefined;
let remote: string;
let work: string;
let tree: string;

function fakeGh(): string {
  return `#!${process.execPath}
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const STATE = ${JSON.stringify(join(root, "gh-state.json"))};
const REMOTE = ${JSON.stringify(remote)};
const GIT = ${JSON.stringify(config.gitPath)};
const git = (...args) => execFileSync(GIT, ["--git-dir", REMOTE, ...args], { encoding: "utf8" }).trim();
const head = (branch) => { try { return git("rev-parse", "--verify", "--quiet", "refs/heads/" + branch); } catch { return undefined; } };
const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
const save = () => fs.writeFileSync(STATE, JSON.stringify(state));
const args = process.argv.slice(2);
const flag = (name) => { const a = args.find((x) => x.startsWith("--" + name + "=")); if (a) return a.slice(name.length + 3); const i = args.indexOf("--" + name); return i < 0 ? undefined : args[i + 1]; };
const fail = (text) => { process.stderr.write(text + "\\n"); process.exit(1); };
const view = (pr) => {
  const oid = pr.state === "MERGED" ? pr.mergedHead : head(pr.headRefName);
  if (pr.state === "OPEN" && oid !== undefined) git("update-ref", "refs/pull/" + pr.number + "/head", oid);
  const files = oid === undefined ? [] : git("diff", "--name-only", "refs/heads/main..." + oid).split("\\n").filter(Boolean);
  return { number: pr.number, state: pr.state, url: pr.url, headRefName: pr.headRefName, baseRefName: "main", isCrossRepository: false, headRefOid: oid,
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", changedFiles: files.length, files,
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: state.ci }] };
};
const find = (n) => state.prs.find((pr) => pr.number === Number(n)) ?? fail("no pull requests found for " + n);
const [a, b] = args;
if (a === "repo" && b === "view") process.stdout.write(JSON.stringify({ defaultBranchRef: { name: "main" } }) + "\\n");
else if (a === "pr" && b === "create") {
  fs.readFileSync(0);
  const number = state.prs.length + 1;
  const url = "https://github.com/${REPO}/pull/" + number;
  state.prs.push({ number, url, state: "OPEN", headRefName: flag("head"), title: flag("title") });
  save();
  process.stdout.write(url + "\\n");
} else if (a === "pr" && b === "view") process.stdout.write(JSON.stringify(view(find(args[2]))) + "\\n");
else if (a === "api" && args.includes("--slurp")) {
  const path = args[args.length - 1];
  const files = path.match(/^repos\\/o\\/r\\/pulls\\/(\\d+)\\/files$/);
  const runs = path.match(/^repos\\/o\\/r\\/actions\\/runs\\?event=pull_request&head_sha=([0-9a-f]{40})&per_page=100$/);
  if (files) process.stdout.write(JSON.stringify([view(find(files[1])).files.map((filename) => ({ filename }))]) + "\\n");
  else if (/^repos\\/o\\/r\\/deployments\\?sha=[0-9a-f]{40}&per_page=100$/.test(path)) process.stdout.write("[[]]\\n");
  else if (runs) process.stdout.write(JSON.stringify([{ total_count: 1, workflow_runs: [{ id: 1, name: "ci", event: "pull_request", head_sha: runs[1], status: "completed", conclusion: state.ci.toLowerCase() }] }]) + "\\n");
  else fail("fake gh: unexpected " + args.join(" "));
} else if (a === "run" && b === "view" && args[2] === "1" && args.includes("--log-failed")) process.stdout.write(state.log ?? "");
else if (a === "pr" && b === "merge") {
  const pr = find(args[2]);
  const oid = head(pr.headRefName);
  if (pr.state !== "OPEN" || oid !== flag("match-head-commit")) fail("fake gh: head is " + oid + ", not " + flag("match-head-commit"));
  const tree = git("rev-parse", oid + "^{tree}");
  const commit = git("-c", "user.name=gh", "-c", "user.email=gh@example.com", "commit-tree", tree, "-p", "refs/heads/main", "-p", oid, "-m", "Merge pull request #" + pr.number + " from ${REPO.split("/")[0]}/" + pr.headRefName);
  git("update-ref", "refs/heads/main", commit);
  if (state.afterMerge === "delete") git("update-ref", "-d", "refs/heads/" + pr.headRefName);
  if (state.afterMerge === "move") {
    state.moved = git("-c", "user.name=w", "-c", "user.email=w@example.com", "commit-tree", tree, "-p", oid, "-m", "late");
    git("update-ref", "refs/heads/" + pr.headRefName, state.moved);
  }
  pr.state = "MERGED";
  pr.mergedHead = oid;
  save();
  fs.appendFileSync(${JSON.stringify(join(root, "merged"))}, args.join(" ") + "\\n");
  process.stdout.write("merged\\n");
} else fail("fake gh: unexpected " + args.join(" "));
`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(config.gitPath, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
}

function remoteRef(ref: string): string {
  return git(remote, "for-each-ref", "--format=%(objectname)", ref);
}

type GhState = { ci: string; log?: string; afterMerge?: "delete" | "move"; moved?: string; prs: unknown[] };

async function ghState(): Promise<GhState> {
  return JSON.parse(await readFile(join(root, "gh-state.json"), "utf8"));
}

async function setGh(patch: Partial<GhState>): Promise<void> {
  await writeFile(join(root, "gh-state.json"), JSON.stringify({ ...(await ghState()), ...patch }));
}

async function setCi(conclusion: string): Promise<void> {
  await setGh({ ci: conclusion });
}

async function pushRecord(branch: string): Promise<string | undefined> {
  const path = join(config.pushesDir, REPO, encodeURIComponent(branch));
  return existsSync(path) ? (await readFile(path, "utf8")).trim() : undefined;
}

type Run = { code: number; stdout: string; stderr: string };

async function run(file: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { cwd, env: { ...GIT_ENV, HOME: root, ...env }, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

async function brokerAs(_role: Role, cwd: string, ...args: string[]): Promise<Run> {
  return run(NODE, [join(BROKER_DIR, "client.ts"), ...args], cwd, { UG_GH_BROKER_SOCKET: config.socketPath });
}

async function ok(role: Role, cwd: string, ...args: string[]): Promise<string> {
  const result = await brokerAs(role, cwd, ...args);
  assert.equal(result.code, 0, `gh-broker ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

async function newHead(file: string): Promise<string> {
  await mkdir(dirname(join(tree, file)), { recursive: true });
  await writeFile(join(tree, file), `${file}\n`);
  git(tree, "add", file);
  git(tree, "commit", "--quiet", "-m", file);
  const head = git(tree, "rev-parse", "HEAD");
  await ok("author", tree, "push", REPO, BRANCH);
  return head;
}

async function openPr(): Promise<number> {
  const out = await ok("author", tree, "pr-create", REPO, BRANCH, "planted", "a change");
  const number = /\/pull\/(\d+)\s*$/.exec(out)?.[1];
  assert.ok(number !== undefined, out);
  return Number(number);
}

function review(role: Role, pr: number, head: string, verdict: string, reason = ""): Promise<string> {
  return ok(role, root, "review", REPO, String(pr), head, role, verdict, reason);
}

async function passAll(pr: number, head: string): Promise<void> {
  for (const role of REVIEWERS) await review(role, pr, head, "pass");
}

async function prStatus(pr: number): Promise<{ headRefOid: string; reviewRecords: { role: string; head: string; verdict: string; reason: string }[] }> {
  return JSON.parse(await ok("author", work, "pr-status", REPO, String(pr)));
}

async function assertRefusedWithoutMerge(pr: number, reason?: RegExp): Promise<void> {
  const main = remoteRef("refs/heads/main");
  const branch = remoteRef(`refs/heads/${BRANCH}`);
  const result = await brokerAs("author", tree, "merge", REPO, String(pr));
  assert.notEqual(result.code, 0, result.stdout);
  if (reason !== undefined) assert.match(result.stderr, reason);
  assert.equal(existsSync(join(root, "merged")), false);
  assert.equal(remoteRef("refs/heads/main"), main);
  assert.equal(remoteRef(`refs/heads/${BRANCH}`), branch);
  assert.equal(existsSync(tree), true);
}

beforeEach(async () => {

  root = await tempDir(join(process.env.XDG_STATE_HOME ?? "/tmp", "u"));
  const agents = join(root, "data/gh-broker");
  const owner = join(root, "data");
  config = {
    ...defaultConfig(),
    socketPath: join(root, "run", "gh-broker.sock"),
    reposRoot: join(agents, "repos"),
    reviewsDir: join(agents, "reviews"),
    pushesDir: join(agents, "pushes"),
    protectedDir: join(owner, "protected-paths"),
    ghPath: join(root, "gh"),
    github: fakeTokens(),
    home: join(root, "gh-home"),
    tempRoot: join(agents, "tmp"),
  };
  await mkdir(agents, { recursive: true });
  await mkdir(owner, { recursive: true });
  await mkdir(config.home);

  remote = join(root, "github.git");
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", "-b", "main", remote], { env: GIT_ENV });
  const seed = join(root, "seed");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", seed], { env: GIT_ENV });
  await writeFile(join(seed, "base.txt"), "base\n");
  git(seed, "add", "base.txt");
  git(seed, "commit", "--quiet", "-m", "base");
  git(seed, "push", "--quiet", remote, "main:main");
  const bare = join(config.reposRoot, `${REPO}.git`);
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", bare], { env: GIT_ENV });
  git(bare, "config", `url.file://${remote}.insteadOf`, tokenRemote(REPO));
  await writeFile(join(root, "gh-state.json"), JSON.stringify({ ci: "SUCCESS", prs: [] }));
  await writeFile(config.ghPath, fakeGh(), { mode: 0o755 });

  broker = await startServer(config);
  work = join(root, "repo");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
  git(work, "remote", "add", "origin", `https://github.com/${REPO}.git`);

  await ok("author", work, "sync", REPO);
  tree = join(root, "wt", "x");
  git(work, "worktree", "add", "--quiet", "-b", BRANCH, tree, "origin/main");
});

afterEach(async () => {
  if (broker !== undefined) await stopServer(broker);
  broker = undefined;
  await rm(root, { recursive: true, force: true });
});

async function plantedDefect(): Promise<{ pr: number; head: string }> {
  const head = await newHead("leak.txt");
  const pr = await openPr();
  await review("code-review", pr, head, "pass");
  await review("risk-review", pr, head, "pass");
  await review("security-review", pr, head, "block", "leak.txt writes the token to a world-readable file");
  return { pr, head };
}

test("a security-review block on a planted defect refuses the merge, and the author sees the block and its reason in pr-status", async () => {
  const { pr, head } = await plantedDefect();

  await assertRefusedWithoutMerge(pr);
  const status = await prStatus(pr);
  assert.equal(status.headRefOid, head);
  const block = status.reviewRecords.find((record) => record.verdict === "block");
  assert.deepEqual(
    { role: block?.role, head: block?.head, reason: block?.reason },
    { role: "security-review", head, reason: "leak.txt writes the token to a world-readable file" },
  );
  assert.deepEqual(status.reviewRecords.map((record) => record.role).sort(), [...REVIEWERS].sort());
});

test("a fixed new head with a fresh pass from all three roles and green CI merges, and the remote branch, local worktree, and local branch go", async () => {
  const { pr, head: blocked } = await plantedDefect();
  await rm(join(tree, "leak.txt"));
  git(tree, "rm", "--quiet", "--cached", "leak.txt");
  const head = await newHead("fix.txt");
  assert.notEqual(head, blocked);

  await review("code-review", pr, head, "pass");
  await review("security-review", pr, head, "pass");
  await assertRefusedWithoutMerge(pr);
  await review("risk-review", pr, head, "pass");

  const result = await brokerAs("author", tree, "merge", REPO, String(pr));
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(join(root, "merged"), "utf8"), new RegExp(`--match-head-commit ${head}\\b`));
  assert.equal(git(remote, "rev-parse", "refs/heads/main^2"), head);
  assert.equal(remoteRef(`refs/heads/${BRANCH}`), "");
  assert.equal(existsSync(tree), false);
  assert.equal(git(work, "for-each-ref", "--format=%(objectname)", `refs/heads/${BRANCH}`), "");
  assert.equal(git(work, "worktree", "list", "--porcelain").includes(tree), false);
  const records = (await prStatus(pr)).reviewRecords;
  assert.ok(records.some((record) => record.head === blocked && record.verdict === "block"));
});

test("a fourth blocked head is a hold that a later head with a pass from all three roles and green CI does not end", async () => {
  let pr = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const head = await newHead(`attempt-${attempt}.txt`);
    if (pr === 0) pr = await openPr();
    await review("code-review", pr, head, "block", `attempt ${attempt} misses the task`);
  }
  await assertRefusedWithoutMerge(pr, /owner merges this PR on GitHub/);

  const head = await newHead("attempt-5.txt");
  await passAll(pr, head);
  await assertRefusedWithoutMerge(pr, /owner merges this PR on GitHub/);
});

test("red CI refuses a head with a pass from all three roles", async () => {
  const head = await newHead("a.txt");
  const pr = await openPr();
  await passAll(pr, head);
  await setCi("FAILURE");

  await assertRefusedWithoutMerge(pr);
});

test("a PR head that another writer pushed, not the gh-broker, refuses with a pass from all three roles and green CI", async () => {
  await newHead("a.txt");
  const pr = await openPr();
  const other = join(root, "other");
  execFileSync(config.gitPath, ["clone", "--quiet", "--branch", BRANCH, remote, other], { env: GIT_ENV });
  await writeFile(join(other, "b.txt"), "b\n");
  git(other, "add", "b.txt");
  git(other, "commit", "--quiet", "-m", "b");
  git(other, "push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
  const foreign = git(other, "rev-parse", "HEAD");
  assert.equal((await prStatus(pr)).headRefOid, foreign);
  await passAll(pr, foreign);

  await assertRefusedWithoutMerge(pr);
});

async function mergeOk(pr: number, cwd = tree): Promise<string> {
  const result = await brokerAs("author", cwd, "merge", REPO, String(pr));
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

test("each reviewer imports the PR head into its session's repo with sync --pr, reviews that commit, and the author's merge lands it", async () => {
  const head = await newHead("feature.txt");
  const pr = await openPr();
  for (const role of REVIEWERS) {
    const clone = join(root, `clone-${role}`);
    execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", clone], { env: GIT_ENV });
    const synced = await brokerAs(role, clone, "sync", REPO, "--pr", String(pr));
    assert.equal(synced.code, 0, synced.stderr);
    const imported = git(clone, "rev-parse", `refs/remotes/origin/pr/${pr}`);
    assert.equal(imported, head);
    assert.equal(git(clone, "show", `${imported}:feature.txt`), "feature.txt");
    await review(role, pr, imported, "pass");
  }

  await mergeOk(pr);
  assert.equal(git(remote, "rev-parse", "refs/heads/main^2"), head);
  assert.equal(remoteRef(`refs/heads/${BRANCH}`), "");
  assert.equal(await pushRecord(BRANCH), undefined);
  const records = (await prStatus(pr)).reviewRecords;
  assert.deepEqual(records.map((record) => [record.role, record.head, record.verdict]), REVIEWERS.map((role) => [role, head, "pass"]));
});

test("after red CI the author reads the failed log with ci-log and merge refuses; a fixed head with green CI and fresh passes merges", async () => {
  const red = await newHead("a.txt");
  const pr = await openPr();
  await passAll(pr, red);
  await setGh({ ci: "FAILURE", log: "ci\ttest\tnot ok 1 - a.txt adds one\n" });

  const log = await ok("author", tree, "ci-log", REPO, String(pr));
  assert.match(log, new RegExp(`failed pull_request runs of PR ${pr} at ${red}: ci \\(1\\)`));
  assert.ok(log.includes("not ok 1 - a.txt adds one"), log);
  await assertRefusedWithoutMerge(pr, /check ci is FAILURE/);
  assert.equal(await pushRecord(BRANCH), red);

  const green = await newHead("fix.txt");
  await setGh({ ci: "SUCCESS", log: "" });
  assert.match(await ok("author", tree, "ci-log", REPO, String(pr)), new RegExp(`no failed pull_request run on head ${green} of PR ${pr}`));
  await passAll(pr, green);
  await mergeOk(pr);
  assert.equal(git(remote, "rev-parse", "refs/heads/main^2"), green);
  assert.equal(await pushRecord(BRANCH), undefined);
});

test("a risk-review manual on one head is a hold that a later head with a pass from all three roles and green CI does not end", async () => {
  const head = await newHead("pay.txt");
  const pr = await openPr();
  await review("code-review", pr, head, "pass");
  await review("security-review", pr, head, "pass");
  await review("risk-review", pr, head, "manual", "pay.txt moves money");
  const hold = new RegExp(`owner merges this PR on GitHub: risk-review asked for manual review of ${head} at .*: pay\\.txt moves money`);
  await assertRefusedWithoutMerge(pr, hold);

  const next = await newHead("pay-2.txt");
  await passAll(pr, next);
  await assertRefusedWithoutMerge(pr, hold);
  assert.equal(await pushRecord(BRANCH), next);
  const records = (await prStatus(pr)).reviewRecords;
  assert.deepEqual(records.filter((record) => record.verdict === "manual").map((record) => record.head), [head]);
});

test("a change to a path in the owner's protected paths list is a hold, with a pass from all three roles and green CI", async () => {
  await mkdir(join(config.protectedDir, "o"), { recursive: true });
  await writeFile(join(config.protectedDir, REPO), "# deploy scripts\ninfra/**\n");
  const head = await newHead("infra/deploy.sh");
  const pr = await openPr();
  await passAll(pr, head);

  await assertRefusedWithoutMerge(pr, /owner merges this PR on GitHub: protected path infra\/deploy\.sh changed/);
  assert.equal(await pushRecord(BRANCH), head);
});

test("a change under .github is a hold with no protected paths list, with a pass from all three roles and green CI", async () => {
  const head = await newHead(".github/workflows/ci.yml");
  const pr = await openPr();
  await passAll(pr, head);

  await assertRefusedWithoutMerge(pr, /owner merges this PR on GitHub: protected path \.github\/workflows\/ci\.yml changed/);
  assert.equal(await pushRecord(BRANCH), head);
});

test("a merge whose head branch moved right after it keeps that branch, says so, and still drops the push record", async () => {
  const head = await newHead("a.txt");
  const pr = await openPr();
  await passAll(pr, head);
  await setGh({ afterMerge: "move" });

  const out = await mergeOk(pr);
  const moved = (await ghState()).moved;
  assert.ok(moved !== undefined && moved !== head);
  assert.match(out, new RegExp(`kept branch ${BRANCH}: it moved from the merged commit ${head} to ${moved}`));
  assert.equal(git(remote, "rev-parse", "refs/heads/main^2"), head);
  assert.equal(remoteRef(`refs/heads/${BRANCH}`), moved);
  assert.equal(await pushRecord(BRANCH), undefined);
  assert.equal(existsSync(tree), false);
});

test("a merge whose head branch GitHub deleted already counts as cleaned up and drops the push record", async () => {
  const head = await newHead("a.txt");
  const pr = await openPr();
  await passAll(pr, head);
  await setGh({ afterMerge: "delete" });

  const out = await mergeOk(pr);
  assert.match(out, new RegExp(`branch ${BRANCH} is gone already`));
  assert.equal(git(remote, "rev-parse", "refs/heads/main^2"), head);
  assert.equal(remoteRef(`refs/heads/${BRANCH}`), "");
  assert.equal(await pushRecord(BRANCH), undefined);
  assert.equal(existsSync(tree), false);
});

test("a review of a stale head is refused and records nothing, and a re-review of the new head merges it", async () => {
  const old = await newHead("a.txt");
  const pr = await openPr();
  const head = await newHead("b.txt");

  for (const role of REVIEWERS) {
    const result = await brokerAs(role, root, "review", REPO, String(pr), old, role, "pass");
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stderr, new RegExp(`PR head is ${head}, not the reviewed ${old}`));
  }
  assert.deepEqual((await prStatus(pr)).reviewRecords, []);
  await assertRefusedWithoutMerge(pr, /has no verdict on it/);

  await passAll(pr, head);
  await mergeOk(pr);
  assert.equal(git(remote, "rev-parse", "refs/heads/main^2"), head);
  assert.deepEqual((await prStatus(pr)).reviewRecords.map((record) => record.head), [head, head, head]);
});

test("a revert of a merged PR goes through the auto path like any PR and restores main's files", async () => {
  const head = await newHead("feature.txt");
  const pr = await openPr();
  await passAll(pr, head);
  await mergeOk(pr);
  assert.deepEqual(git(remote, "ls-tree", "--name-only", "refs/heads/main").split("\n"), ["base.txt", "feature.txt"]);

  await ok("author", work, "sync", REPO);
  const revertBranch = "agent/revert";
  const revertTree = join(root, "wt", "revert");
  git(work, "worktree", "add", "--quiet", "-b", revertBranch, revertTree, "origin/main");
  git(revertTree, "revert", "--no-edit", "-m", "1", "HEAD");
  const revert = git(revertTree, "rev-parse", "HEAD");
  await ok("author", revertTree, "push", REPO, revertBranch);
  const created = await ok("author", revertTree, "pr-create", REPO, revertBranch, "Revert feature", "feature.txt broke main");
  const revertPr = Number(/\/pull\/(\d+)\s*$/.exec(created)?.[1]);
  assert.equal(revertPr, pr + 1);
  await passAll(revertPr, revert);

  await mergeOk(revertPr, revertTree);
  assert.equal(git(remote, "rev-parse", "refs/heads/main^2"), revert);
  assert.deepEqual(git(remote, "ls-tree", "--name-only", "refs/heads/main").split("\n"), ["base.txt"]);
  assert.equal(remoteRef(`refs/heads/${revertBranch}`), "");
  assert.equal(await pushRecord(revertBranch), undefined);
  assert.equal(existsSync(revertTree), false);
});

test("a launch sync right after a merge through the gh-broker gets the merged main, not the copy from before it", async () => {
  const head = await newHead("feature.txt");
  const pr = await openPr();
  await passAll(pr, head);
  await ok("author", work, "sync", REPO, "--cached");
  await mergeOk(pr);
  const synced = await ok("author", work, "sync", REPO, "--cached");
  assert.equal(synced, `origin/main is now ${remoteRef("refs/heads/main")}\n`);
});
