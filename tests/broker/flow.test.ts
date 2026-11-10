import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { defaultConfig, refreshRepos, startServer, stopServer } from "../../host/gh-broker/server.ts";
import type { GhBroker, ServerConfig } from "../../host/gh-broker/server.ts";
import { fakeTokens, githubRemote } from "./fake-app.ts";
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
  pr.state = "MERGED";
  pr.mergedHead = oid;
  save();
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

type GhState = { ci: string; log?: string; prs: unknown[] };

async function ghState(): Promise<GhState> {
  return JSON.parse(await readFile(join(root, "gh-state.json"), "utf8"));
}

async function setGh(patch: Partial<GhState>): Promise<void> {
  await writeFile(join(root, "gh-state.json"), JSON.stringify({ ...(await ghState()), ...patch }));
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
  const out = await ok("author", tree, "pr-create", REPO, BRANCH, "a change", "a change");
  const number = /\/pull\/(\d+)\s*$/.exec(out)?.[1];
  assert.ok(number !== undefined, out);
  return Number(number);
}

async function mergeOnGithub(pr: number, head: string): Promise<void> {
  execFileSync(config.ghPath, ["pr", "merge", String(pr), "--repo", REPO, "--merge", "--match-head-commit", head], { env: GIT_ENV });
}

beforeEach(async () => {

  root = await tempDir(join(process.env.XDG_STATE_HOME ?? "/tmp", "u"));
  const agents = join(root, "data/gh-broker");
  config = {
    ...defaultConfig("/unused/gh"),
    socketPath: join(root, "run", "gh-broker.sock"),
    reposRoot: join(agents, "repos"),
    pushesDir: join(agents, "pushes"),
    ghPath: join(root, "gh"),
    github: fakeTokens(),
    home: join(root, "gh-home"),
    tempRoot: join(agents, "tmp"),
    statusFile: join(agents, "status"),
  };
  await mkdir(agents, { recursive: true });
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
  git(bare, "config", `url.file://${remote}.insteadOf`, githubRemote(REPO));
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

test("each reviewer imports the PR head into its session's repo with sync --pr and reads that commit", async () => {
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
  }
});

test("after red CI the author reads the failed log with ci-log, and a fixed green head shows no failed run", async () => {
  const red = await newHead("a.txt");
  const pr = await openPr();
  await setGh({ ci: "FAILURE", log: "ci\ttest\tnot ok 1 - a.txt adds one\n" });

  const log = await ok("author", tree, "ci-log", REPO, String(pr));
  assert.match(log, new RegExp(`failed pull_request runs of PR ${pr} at ${red}: ci \\(1\\)`));
  assert.ok(log.includes("not ok 1 - a.txt adds one"), log);
  assert.equal(await pushRecord(BRANCH), red);

  const green = await newHead("fix.txt");
  await setGh({ ci: "SUCCESS", log: "" });
  assert.match(await ok("author", tree, "ci-log", REPO, String(pr)), new RegExp(`no failed pull_request run on head ${green} of PR ${pr}`));
});

test("a head branch that another writer moved after the owner's merge on GitHub keeps that branch and its push record", async () => {
  const head = await newHead("a.txt");
  const pr = await openPr();
  await mergeOnGithub(pr, head);
  const other = join(root, "other");
  execFileSync(config.gitPath, ["clone", "--quiet", "--branch", BRANCH, remote, other], { env: GIT_ENV });
  await writeFile(join(other, "b.txt"), "b\n");
  git(other, "add", "b.txt");
  git(other, "commit", "--quiet", "-m", "b");
  git(other, "push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
  const moved = git(other, "rev-parse", "HEAD");

  await refreshRepos(config, new AbortController().signal);
  assert.equal(git(remote, "rev-parse", "refs/heads/main^2"), head);
  assert.equal(remoteRef(`refs/heads/${BRANCH}`), moved);
  assert.equal(await pushRecord(BRANCH), head);
  assert.equal(existsSync(tree), true);
});

test("a head branch GitHub deleted at the merge counts as cleaned up and drops the push record", async () => {
  const head = await newHead("a.txt");
  const pr = await openPr();
  await mergeOnGithub(pr, head);
  git(remote, "update-ref", "-d", `refs/heads/${BRANCH}`);

  await refreshRepos(config, new AbortController().signal);
  assert.equal(git(remote, "rev-parse", "refs/heads/main^2"), head);
  assert.equal(remoteRef(`refs/heads/${BRANCH}`), "");
  assert.equal(await pushRecord(BRANCH), undefined);
  assert.equal(existsSync(tree), true);
});

test("a revert of a PR the owner merged goes through push and pr-create like any PR and restores main's files", async () => {
  const head = await newHead("feature.txt");
  const pr = await openPr();
  await mergeOnGithub(pr, head);
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

  await mergeOnGithub(revertPr, revert);
  assert.equal(git(remote, "rev-parse", "refs/heads/main^2"), revert);
  assert.deepEqual(git(remote, "ls-tree", "--name-only", "refs/heads/main").split("\n"), ["base.txt"]);

  await refreshRepos(config, new AbortController().signal);
  assert.equal(remoteRef(`refs/heads/${revertBranch}`), "");
  assert.equal(await pushRecord(revertBranch), undefined);
  assert.equal(existsSync(revertTree), true);
});

test("a launch sync right after the owner merges on GitHub gets the merged main, not the copy from before it", async () => {
  const head = await newHead("feature.txt");
  const pr = await openPr();
  await ok("author", work, "sync", REPO, "--cached");
  await mergeOnGithub(pr, head);
  await refreshRepos(config, new AbortController().signal);
  const synced = await ok("author", work, "sync", REPO, "--cached");
  assert.equal(synced, `origin/main is now ${remoteRef("refs/heads/main")}\n`);
});
