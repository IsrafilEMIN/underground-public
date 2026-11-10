import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { PushRecord, Reply } from "../../host/gh-broker/protocol.ts";
import { readPushRecord } from "../../host/gh-broker/push-record.ts";
import { refreshRepos } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import type { GithubTokens, TokenScope } from "../../host/gh-broker/github-app.ts";
import { FAKE_TOKEN } from "./fake-app.ts";
import { tempDir } from "../temp.ts";
import { BRANCH, REPO, brokerConfig, bundleOf, commit, git, initMirror, initRepo, remoteRef, request, seedMain } from "./fixture.ts";

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
"repo view") printf '{"defaultBranchRef":{"name":"main"}}\\n' ;;
*) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;

let root: string;
let config: ServerConfig;
let work: string;
let remote: string;

function remoteBranch(): string {
  return remoteRef(remote, BRANCH);
}

function brokerPush(sha: string): Promise<Reply> {
  return request(config, { verb: "push", branch: BRANCH, sha, bundle_b64: bundleOf(work, BRANCH) });
}

async function pushed(file = "a.txt"): Promise<string> {
  const head = await commit(work, file, BRANCH);
  const reply = await brokerPush(head);
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  return head;
}

function mergeOnGithub(head: string): void {
  git(remote, "update-ref", "refs/heads/main", head);
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
      dropIfRejected: () => Promise.resolve(false),
    },
    scopes,
  };
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-b5-"));
  config = await brokerConfig(root, FAKE_GH);
  remote = initRepo(join(root, "remote.git"), true);
  initMirror(config, remote);
  work = initRepo(join(root, "work"));
  await seedMain(work, remote);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
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

test("a head branch that another writer moved after the owner's merge on GitHub stays, and so does its record", async () => {
  const head = await pushed();
  mergeOnGithub(head);
  const moved = await commit(work, "b.txt", BRANCH);
  git(work, "push", "--quiet", "--force", remote, `${BRANCH}:${BRANCH}`);

  await refreshRepos(config, new AbortController().signal);
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

function countingTokens(): { tokens: GithubTokens; drops: () => number } {
  let drops = 0;
  return {
    tokens: {
      token: () => Promise.resolve(FAKE_TOKEN),
      dropIfRejected: () => {
        drops += 1;
        return Promise.resolve(true);
      },
    },
    drops: () => drops,
  };
}

test("a 401 from git push is not retried, but its token is dropped so the next call gets a new one", async () => {
  const head = await commit(work, "a.txt", BRANCH);
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
