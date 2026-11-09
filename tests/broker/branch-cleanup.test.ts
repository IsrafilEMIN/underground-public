import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { REVIEWER_ROLES } from "../../host/gh-broker/protocol.ts";
import type { PushRecord, Reply } from "../../host/gh-broker/protocol.ts";
import { readPushRecord } from "../../host/gh-broker/push-record.ts";
import { appendReviewRecord, reviewRecordsPath } from "../../host/gh-broker/review-records.ts";
import { defaultConfig, refreshRepos } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import type { GithubTokens, TokenScope } from "../../host/gh-broker/github-app.ts";
import { FAKE_TOKEN, fakeTokens, tokenRemote } from "./fake-app.ts";
import { handleAs } from "./session.ts";
import type { Session } from "./session.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const BRANCH = "agent/x";
const AUTHOR: Session = { role: "author" };
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const FAKE_GH = `#!/bin/sh
case "$1 $2 $4" in
"repo view "*) printf '{"defaultBranchRef":{"name":"main"}}\\n' ;;
"pr view "*) cat "$HOME/pr.json" ;;
"api --paginate repos/${REPO}/pulls/7/files") cat "$HOME/gh-files.json" ;;
"pr merge "*)
  echo attempt >> "$HOME/merge-attempts"
  if [ -f "$HOME/merge-401" ]; then echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2; exit 1; fi
  git --git-dir="$(cat "$HOME/remote-path")" update-ref refs/heads/main "$8"
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
  return handleAs(config, AUTHOR, request, new AbortController().signal);
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
    await appendReviewRecord(config.reviewsDir, { repo: REPO, pr: 7, role, head, verdict: "pass", reason: "", at });
  }
}

async function pushed(file = "a.txt"): Promise<string> {
  const head = await commit(file);
  const reply = await brokerPush(head);
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  return head;
}

async function pushedAndReady(): Promise<string> {
  const head = await pushed();
  await readyToMerge(head);
  return head;
}

function brokerMerge(): Promise<Reply> {
  return handleAs(config, AUTHOR, { verb: "merge", repo: REPO, number: 7 }, new AbortController().signal);
}

function mergeOnGithub(head: string): void {
  git(remote, "update-ref", "refs/heads/main", head);
}

function merged(): Promise<string> {
  return readFile(join(config.home, "merged"), "utf8").catch(() => "");
}

function record(): Promise<PushRecord> {
  return readPushRecord(config.pushesDir, { repo: REPO, branch: BRANCH });
}

function scopedTokens(): { tokens: GithubTokens; scopes: TokenScope[] } {
  const scopes: TokenScope[] = [];
  return {
    tokens: {
      token: (_repo, _signal, scope = "app") => {
        scopes.push(scope);
        return Promise.resolve(FAKE_TOKEN);
      },
      drop: () => {},
    },
    scopes,
  };
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-b5-"));
  config = {
    ...defaultConfig(),
    socketPath: join(root, "run", "gh-broker.sock"),
    reposRoot: join(root, "bare"),
    reviewsDir: join(root, "reviews"),
    pushesDir: join(root, "pushes"),
    protectedDir: join(root, "protected"),
    ghPath: join(root, "gh"),
    github: fakeTokens(),
    home: join(root, "home"),
    tempRoot: join(root, "tmp"),
  };
  await mkdir(config.home);
  await writeFile(config.ghPath, FAKE_GH, { mode: 0o755 });
  remote = join(root, "remote.git");
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", "-b", "main", remote], { env: GIT_ENV });
  await writeFile(join(config.home, "remote-path"), remote);
  const bare = join(config.reposRoot, `${REPO}.git`);
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", bare], { env: GIT_ENV });
  git(bare, "config", `url.file://${remote}.insteadOf`, tokenRemote(REPO));
  work = join(root, "work");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
  git(work, "commit", "--quiet", "--allow-empty", "-m", "base");
  git(work, "push", "--quiet", remote, "main:main");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("after a merge through the gh-broker, it deletes the remote head branch and drops its push record", async () => {
  const head = await pushedAndReady();
  assert.equal(remoteBranch(), head);

  const reply = await brokerMerge();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.equal(await merged(), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
  assert.ok("stdout" in reply && reply.stdout.endsWith(`gh-broker: deleted branch ${BRANCH}\n`), JSON.stringify(reply));
  assert.equal(remoteBranch(), "");
  assert.deepEqual(await record(), { kind: "none" });
});

test("after the owner merges on GitHub, the next refresh deletes the head branch and drops its push record", async () => {
  const head = await pushed();
  mergeOnGithub(head);

  await refreshRepos(config, new AbortController().signal);
  assert.equal(remoteBranch(), "");
  assert.deepEqual(await record(), { kind: "none" });
});

test("a refresh leaves an unmerged branch and its record, and asks GitHub only with a token that can read code", async () => {
  const head = await pushed();
  const { tokens, scopes } = scopedTokens();
  config.github = tokens;

  await refreshRepos(config, new AbortController().signal);
  assert.equal(remoteBranch(), head);
  assert.deepEqual(await record(), { kind: "pushed", sha: head });
  assert.ok(scopes.length > 0 && scopes.every((scope) => scope === "contents-read"), scopes.join(","));
});

test("a repo with only a push record gets one refresh after the gh-broker starts, then keeps the 7-day launch rule", async () => {
  const head = await pushed();
  const { tokens, scopes } = scopedTokens();
  config.github = tokens;

  await refreshRepos(config, new AbortController().signal);
  assert.ok(scopes.length > 0, "the first refresh after a start checks the repo");
  scopes.length = 0;
  mergeOnGithub(head);
  await refreshRepos(config, new AbortController().signal);
  assert.deepEqual(scopes, [], "a record alone does not keep a repo in the 30 s refresh");
  assert.equal(remoteBranch(), head);
});

test("a head branch that GitHub deleted at the merge only drops the record, with no token that can write", async () => {
  const head = await pushed();
  mergeOnGithub(head);
  git(remote, "update-ref", "-d", `refs/heads/${BRANCH}`);
  const { tokens, scopes } = scopedTokens();
  config.github = tokens;

  await refreshRepos(config, new AbortController().signal);
  assert.deepEqual(await record(), { kind: "none" });
  assert.ok(scopes.every((scope) => scope === "contents-read"), scopes.join(","));
});

test("a head branch that another writer moved after the merged commit stays, and so does its record", async () => {
  const head = await pushedAndReady();
  const moved = await commit("b.txt");
  git(work, "push", "--quiet", "--force", remote, `${BRANCH}:${BRANCH}`);

  const reply = await brokerMerge();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.ok(
    "stdout" in reply && reply.stdout.endsWith(`gh-broker: kept branch ${BRANCH}: it moved from the merged commit ${head} to ${moved}\n`),
    JSON.stringify(reply),
  );
  assert.equal(remoteBranch(), moved);
  assert.deepEqual(await record(), { kind: "pushed", sha: head });
});

test("a new push after the merge keeps the branch and its new record", async () => {
  const head = await pushed();
  mergeOnGithub(head);
  const next = await pushed("b.txt");

  await refreshRepos(config, new AbortController().signal);
  assert.equal(remoteBranch(), next);
  assert.deepEqual(await record(), { kind: "pushed", sha: next });
});

test("a merge whose branch cleanup cannot run still exits 0 and says the cleanup runs again", async () => {
  const head = await pushedAndReady();
  const wrapper = join(root, "git");
  await writeFile(wrapper, `#!/bin/sh\nfor a in "$@"; do [ "$a" = ls-remote ] && { echo "fatal: unable to access" >&2; exit 128; }; done\nexec ${config.gitPath} "$@"\n`, { mode: 0o755 });
  config.gitPath = wrapper;

  const reply = await brokerMerge();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.ok("stderr" in reply && reply.stderr.includes("gh-broker: merged; the branch cleanup runs again within 30 s: fatal: unable to access"), JSON.stringify(reply));
  assert.equal(remoteBranch(), head);
  assert.deepEqual(await record(), { kind: "pushed", sha: head });
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

test("a 401 from gh pr merge is not retried, but its token is dropped so the next call gets a new one", async () => {
  const head = await pushedAndReady();
  const counted = countingTokens();
  config.github = counted.tokens;
  await writeFile(join(config.home, "merge-401"), "");

  const reply = await brokerMerge();
  assert.equal(reply.exit, 1, JSON.stringify(reply));
  assert.ok("stderr" in reply && reply.stderr.includes("HTTP 401"), JSON.stringify(reply));
  assert.equal(await readFile(join(config.home, "merge-attempts"), "utf8"), "attempt\n");
  assert.equal(counted.drops(), 1);
  assert.equal(remoteBranch(), head);
});

test("a 401 from git push is not retried, but its token is dropped so the next call gets a new one", async () => {
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
  assert.equal(counted.drops(), 1);
  assert.equal(remoteBranch(), "");
});
