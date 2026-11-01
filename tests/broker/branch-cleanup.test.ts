import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { cleanUpLocal } from "../../host/broker/client.ts";
import { isMergeReply, REVIEWER_ROLES } from "../../host/broker/protocol.ts";
import type { Binding, PushRecord, Reply } from "../../host/broker/protocol.ts";
import { readPushRecord } from "../../host/broker/push-record.ts";
import { appendReviewRecord, reviewRecordsPath } from "../../host/broker/review-records.ts";
import { defaultConfig, handleRequest } from "../../host/broker/server.ts";
import type { ServerConfig } from "../../host/broker/server.ts";
import type { GithubTokens } from "../../host/broker/github-app.ts";
import { FAKE_TOKEN, fakeTokens, tokenRemote } from "./fake-app.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const BRANCH = "agent/x";
const AUTHOR: Binding = { repo: REPO, role_name: "author", role: "author" };
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const FAKE_GH = `#!/bin/sh
case "$1 $2 $4" in
"repo view "*) printf '{"defaultBranchRef":{"name":"main"}}\\n' ;;
"pr view "*) cat "$HOME/pr.json" ;;
"api --paginate repos/${REPO}/pulls/7/files") cat "$HOME/gh-files.json" ;;
"pr merge "*)
  echo attempt >> "$HOME/merge-attempts"
  if [ -f "$HOME/merge-401" ]; then echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2; exit 1; fi
  printf '%s\\n' "$*" >> "$HOME/merged"; echo merged ;;
*) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;

let root: string;
let config: ServerConfig;
let work: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(config.gitPath, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
}

function remoteBranch(): string {
  return git(remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${BRANCH}`);
}

async function commit(file: string): Promise<string> {
  git(work, "checkout", "--quiet", "-B", BRANCH);
  await writeFile(join(work, file), `${file}\n`);
  git(work, "add", file);
  git(work, "commit", "--quiet", "-m", file);
  return git(work, "rev-parse", "HEAD");
}

function brokerPush(sha: string): Promise<Reply> {
  const bundle = execFileSync(config.gitPath, ["bundle", "create", "-", `refs/heads/${BRANCH}`], { cwd: work, env: GIT_ENV });
  const request = { verb: "push", repo: REPO, branch: BRANCH, sha, bundle_b64: bundle.toString("base64") };
  return handleRequest(config, AUTHOR, request, new AbortController().signal);
}

async function readyToMerge(head: string): Promise<void> {
  const pr = {
    headRefName: BRANCH,
    baseRefName: "main",
    isCrossRepository: false,
    headRefOid: head,
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    changedFiles: 1,
  };
  await writeFile(join(config.home, "pr.json"), JSON.stringify(pr));
  await writeFile(join(config.home, "gh-files.json"), JSON.stringify([[{ filename: "a.txt" }]]));
  await rm(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }), { force: true });
  const at = new Date().toISOString();
  for (const role of REVIEWER_ROLES) {
    await appendReviewRecord(config.reviewsDir, { repo: REPO, pr: 7, role_name: role, role, head, verdict: "pass", reason: "", at });
  }
}

async function pushedAndReady(): Promise<string> {
  const head = await commit("a.txt");
  const pushed = await brokerPush(head);
  assert.equal(pushed.exit, 0, JSON.stringify(pushed));
  await readyToMerge(head);
  return head;
}

function brokerMerge(): Promise<Reply> {
  return handleRequest(config, AUTHOR, { verb: "merge", repo: REPO, number: 7 }, new AbortController().signal);
}

function merged(): Promise<string> {
  return readFile(join(config.home, "merged"), "utf8").catch(() => "");
}

function record(): Promise<PushRecord> {
  return readPushRecord(config.pushesDir, { repo: REPO, branch: BRANCH });
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-b5-"));
  config = {
    ...defaultConfig(),
    runDir: join(root, "run"),
    bindingsFile: join(root, "bindings.json"),
    reposFile: join(root, "repos"),
    rolesFile: join(root, "roles"),
    reposRoot: join(root, "bare"),
    reviewsDir: join(root, "reviews"),
    legacyReviewsFile: join(root, "reviews.json"),
    pushesDir: join(root, "pushes"),
    protectedDir: join(root, "protected"),
    ghPath: join(root, "gh"),
    github: fakeTokens(),
    home: join(root, "home"),
    tempRoot: join(root, "tmp"),
  };
  await mkdir(config.home);
  await writeFile(config.reposFile, `${REPO}\n`);
  await writeFile(config.rolesFile, "author author\n");
  await writeFile(config.ghPath, FAKE_GH, { mode: 0o755 });
  remote = join(root, "remote.git");
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", remote], { env: GIT_ENV });
  const bare = join(config.reposRoot, `${REPO}.git`);
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", bare], { env: GIT_ENV });
  git(bare, "config", `url.file://${remote}.insteadOf`, tokenRemote(REPO));
  work = join(root, "work");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("after a merge the broker deletes the remote head branch and drops its push record", async () => {
  const head = await pushedAndReady();
  assert.equal(remoteBranch(), head);

  const reply = await brokerMerge();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.equal(await merged(), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
  assert.ok("stdout" in reply && reply.stdout.endsWith(`broker: deleted branch ${BRANCH}\n`), JSON.stringify(reply));
  assert.equal(remoteBranch(), "");
  assert.deepEqual(await record(), { kind: "none" });
  assert.ok(isMergeReply(reply), JSON.stringify(reply));
  assert.deepEqual(reply.merged, { branch: BRANCH, head });
});

test("a head branch that is gone already counts as cleaned up", async () => {
  await pushedAndReady();
  git(remote, "update-ref", "-d", `refs/heads/${BRANCH}`);

  const reply = await brokerMerge();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.ok("stdout" in reply && reply.stdout.endsWith(`broker: branch ${BRANCH} is gone already\n`), JSON.stringify(reply));
  assert.deepEqual(await record(), { kind: "none" });
});

test("a head branch that moved after the merged commit stays, and the merge reply says so", async () => {
  const head = await pushedAndReady();
  const moved = await commit("b.txt");
  git(work, "push", "--quiet", "--force", remote, `${BRANCH}:${BRANCH}`);

  const reply = await brokerMerge();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.equal(await merged(), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
  assert.ok(
    "stdout" in reply && reply.stdout.endsWith(`broker: kept branch ${BRANCH}: it moved from the merged commit ${head} to ${moved}\n`),
    JSON.stringify(reply),
  );
  assert.equal(remoteBranch(), moved);
  assert.deepEqual(await record(), { kind: "none" });
});

test("a merge whose branch cleanup fails says that the PR merged", async () => {
  await pushedAndReady();
  await rm(remote, { recursive: true, force: true });

  const reply = await brokerMerge();
  assert.equal(reply.exit, 1, JSON.stringify(reply));
  assert.ok("stderr" in reply && reply.stderr.includes(`broker: merged, but cannot delete branch ${BRANCH}:`), JSON.stringify(reply));
  assert.ok(isMergeReply(reply), "a merged PR names its branch and head, so the client still cleans up locally");
});

async function localWorktree(): Promise<{ tree: string; head: string }> {
  git(work, "commit", "--quiet", "--allow-empty", "-m", "base");
  const tree = join(root, "tree");
  git(work, "worktree", "add", "--quiet", "-b", BRANCH, tree);
  await writeFile(join(tree, "a.txt"), "a\n");
  git(tree, "add", "a.txt");
  git(tree, "commit", "--quiet", "-m", "a");
  git(work, "pack-refs", "--all");
  return { tree, head: git(tree, "rev-parse", "HEAD") };
}

function localBranch(): string {
  return git(work, "for-each-ref", "--format=%(objectname)", `refs/heads/${BRANCH}`);
}

// The client runs git with the process env, so the test gives it GIT_ENV and keeps what it prints to stderr.
async function clientCleanUp(head: string, cwd: string): Promise<{ exit: number; stderr: string }> {
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  const write = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += String(chunk);
    return true;
  };
  process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = GIT_ENV.GIT_CONFIG_NOSYSTEM;
  try {
    return { exit: await cleanUpLocal({ branch: BRANCH, head }, cwd), stderr };
  } finally {
    process.stderr.write = write;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("after a merge the client removes the local worktree and branch of the PR, run from inside that worktree", async () => {
  const { tree, head } = await localWorktree();

  const { exit, stderr } = await clientCleanUp(head, tree);
  assert.equal(exit, 0, stderr);
  assert.equal(existsSync(tree), false);
  assert.equal(localBranch(), "");
  assert.equal(git(work, "worktree", "list", "--porcelain").includes(tree), false);
});

test("a local worktree with uncommitted work stays, with its branch, and the client exits 1", async () => {
  const { tree, head } = await localWorktree();
  await writeFile(join(tree, "draft.txt"), "draft\n");

  const { exit, stderr } = await clientCleanUp(head, tree);
  assert.equal(exit, 1);
  assert.ok(stderr.startsWith(`broker: merged, but kept worktree ${tree} and local branch ${BRANCH}: `), stderr);
  assert.match(stderr, /contains modified or untracked files/);
  assert.equal(existsSync(join(tree, "draft.txt")), true);
  assert.equal(localBranch(), head);
});

test("a local branch with commits after the merged commit stays, with its worktree", async () => {
  const { tree, head } = await localWorktree();
  await writeFile(join(tree, "b.txt"), "b\n");
  git(tree, "add", "b.txt");
  git(tree, "commit", "--quiet", "-m", "b");
  const moved = git(tree, "rev-parse", "HEAD");

  const { exit, stderr } = await clientCleanUp(head, tree);
  assert.equal(exit, 0, stderr);
  assert.equal(existsSync(tree), true);
  assert.equal(localBranch(), moved);
});

test("a refused merge keeps the branch and the push record", async () => {
  const head = await pushedAndReady();
  await rm(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }));

  const reply = await brokerMerge();
  assert.equal(reply.exit, 2, JSON.stringify(reply));
  assert.equal(await merged(), "");
  assert.equal(remoteBranch(), head);
  assert.deepEqual(await record(), { kind: "pushed", sha: head });
});

test("a changed file whose name looks like a token still matches a protected glob and holds the merge", async () => {
  await pushedAndReady();
  await writeFile(join(config.home, "gh-files.json"), JSON.stringify([[{ filename: "ghs_x.sql" }]]));
  await mkdir(join(config.protectedDir, "o"), { recursive: true });
  await writeFile(join(config.protectedDir, REPO), "*.sql\n");

  const reply = await brokerMerge();
  assert.equal(reply.exit, 2, JSON.stringify(reply));
  assert.ok("refused" in reply && reply.refused.endsWith("protected path ghs_x.sql changed"), JSON.stringify(reply));
  assert.equal(await merged(), "");
});

function countingTokens(): { tokens: GithubTokens; drops: () => number } {
  let drops = 0;
  return {
    tokens: {
      token: () => Promise.resolve(FAKE_TOKEN),
      drop: () => {
        drops += 1;
      },
    },
    drops: () => drops,
  };
}

test("a 401 from gh pr merge is not retried", async () => {
  const head = await pushedAndReady();
  const counted = countingTokens();
  config.github = counted.tokens;
  await writeFile(join(config.home, "merge-401"), "");

  const reply = await brokerMerge();
  assert.equal(reply.exit, 1, JSON.stringify(reply));
  assert.ok("stderr" in reply && reply.stderr.includes("HTTP 401"), JSON.stringify(reply));
  assert.equal(await readFile(join(config.home, "merge-attempts"), "utf8"), "attempt\n");
  assert.equal(counted.drops(), 0);
  assert.equal(remoteBranch(), head);
});

test("a 401 from git push is not retried", async () => {
  const head = await commit("a.txt");
  const wrapper = join(root, "git");
  await writeFile(
    wrapper,
    `#!/bin/sh
for a in "$@"; do
  if [ "$a" = push ] && [ -f "$HOME/push-401" ]; then
    echo attempt >> "$HOME/push-attempts"
    echo "fatal: Authentication failed for 'https://github.com/${REPO}.git/'" >&2
    exit 128
  fi
done
exec ${config.gitPath} "$@"
`,
    { mode: 0o755 },
  );
  config.gitPath = wrapper;
  const counted = countingTokens();
  config.github = counted.tokens;
  await writeFile(join(config.home, "push-401"), "");

  const reply = await brokerPush(head);
  assert.equal(reply.exit, 128, JSON.stringify(reply));
  assert.equal(await readFile(join(config.home, "push-attempts"), "utf8"), "attempt\n");
  assert.equal(counted.drops(), 0);
  assert.equal(remoteBranch(), "");
});
