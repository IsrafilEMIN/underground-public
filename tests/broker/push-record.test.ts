import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { REVIEWER_ROLES, isReply } from "../../host/gh-broker/protocol.ts";
import type { Reply } from "../../host/gh-broker/protocol.ts";
import { dropPushRecord, listPushRecords, pushRecordPath, readPushRecord, writePushRecord } from "../../host/gh-broker/push-record.ts";
import { appendReviewRecord, reviewRecordsPath } from "../../host/gh-broker/review-records.ts";
import { defaultConfig } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import { fakeTokens, githubRemote } from "./fake-app.ts";
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
"pr merge "*) printf '%s\\n' "$*" >> "$HOME/merged"; echo merged ;;
*) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;

const BROKER_PROCESS = `
import { handleAs } from ${JSON.stringify(new URL("./session.ts", import.meta.url).href)};
import { fakeTokens } from ${JSON.stringify(new URL("./fake-app.ts", import.meta.url).href)};
const [config, session, request] = JSON.parse(process.argv[1]);
config.github = fakeTokens();
process.stdout.write(JSON.stringify(await handleAs(config, session, request, new AbortController().signal)));
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

async function commit(file: string): Promise<string> {
  git(work, "checkout", "--quiet", "-B", BRANCH);
  await writeFile(join(work, file), `${file}\n`);
  git(work, "add", file);
  git(work, "commit", "--quiet", "-m", file);
  return git(work, "rev-parse", "HEAD");
}

function bundleB64(): string {
  return execFileSync(config.gitPath, ["bundle", "create", "-", `refs/heads/${BRANCH}`], { cwd: work, env: GIT_ENV }).toString("base64");
}

function brokerPush(sha: string): Promise<Reply> {
  const request = { verb: "push", repo: REPO, branch: BRANCH, sha, bundle_b64: bundleB64() };
  return handleAs(config, AUTHOR, request, new AbortController().signal);
}

async function openPr(head: string): Promise<void> {
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
}

async function reviewerPass(head: string): Promise<void> {
  await rm(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }), { force: true });
  const at = new Date().toISOString();
  for (const role of REVIEWER_ROLES) {
    await appendReviewRecord(config.reviewsDir, { repo: REPO, pr: 7, role, head, verdict: "pass", reason: "", at });
  }
}

function brokerMerge(): Promise<Reply> {
  return handleAs(config, AUTHOR, { verb: "merge", repo: REPO, number: 7 }, new AbortController().signal);
}

function merged(): Promise<string> {
  return readFile(join(config.home, "merged"), "utf8").catch(() => "");
}

function brokerProcess(request: Record<string, unknown>): Reply {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", BROKER_PROCESS, JSON.stringify([config, AUTHOR, request])], {
    encoding: "utf8",
  });
  const reply: unknown = JSON.parse(out);
  assert.ok(isReply(reply), out);
  return reply;
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-b4-"));
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
    statusFile: join(root, "status"),
  };
  await mkdir(config.home);
  await writeFile(config.ghPath, FAKE_GH, { mode: 0o755 });
  remote = join(root, "remote.git");
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", remote], { env: GIT_ENV });
  const bare = join(config.reposRoot, `${REPO}.git`);
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", bare], { env: GIT_ENV });
  git(bare, "config", `url.file://${remote}.insteadOf`, githubRemote(REPO));
  work = join(root, "work");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a gh-broker push records the commit for its repo and branch, and a later push replaces it", async () => {
  const first = await commit("a.txt");
  const one = await brokerPush(first);
  assert.equal(one.exit, 0, JSON.stringify(one));
  assert.equal(git(remote, "rev-parse", `refs/heads/${BRANCH}`), first);
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: BRANCH }), { kind: "pushed", sha: first });

  const second = await commit("b.txt");
  const two = await brokerPush(second);
  assert.equal(two.exit, 0, JSON.stringify(two));
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: BRANCH }), { kind: "pushed", sha: second });
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: "agent/other" }), { kind: "none" });
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: "o/other", branch: BRANCH }), { kind: "none" });
});

test("a refused push leaves the record unchanged", async () => {
  const first = await commit("a.txt");
  assert.equal((await brokerPush(first)).exit, 0);
  const other = await commit("b.txt");
  await commit("c.txt");
  const reply = await brokerPush(other);
  assert.deepEqual(reply, { exit: 2, refused: "bundle ref does not match sha" });
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: BRANCH }), { kind: "pushed", sha: first });
});

test("merge of a PR whose head is the recorded commit goes on to the rest of the gate", async () => {
  const head = await commit("a.txt");
  assert.equal((await brokerPush(head)).exit, 0);
  await openPr(head);

  const noPass = await brokerMerge();
  assert.deepEqual(noPass, { exit: 2, refused: "code-review has no verdict on it" });

  await reviewerPass(head);
  const ok = await brokerMerge();
  assert.equal(ok.exit, 0, JSON.stringify(ok));
  assert.equal(await merged(), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
});

test("merge of a PR whose head the gh-broker did not push refuses and names the reason", async () => {
  const pushed = await commit("a.txt");
  assert.equal((await brokerPush(pushed)).exit, 0);
  const foreign = await commit("foreign.txt");
  git(work, "push", "--quiet", "--force", remote, `${BRANCH}:${BRANCH}`);
  await openPr(foreign);
  await reviewerPass(foreign);

  const reply = await brokerMerge();
  assert.deepEqual(reply, {
    exit: 2,
    refused: `the gh-broker did not push it: the last gh-broker push to ${BRANCH} is ${pushed}`,
  });
  assert.equal(await merged(), "");
});

test("merge of a PR with no push record refuses and names the reason", async () => {
  const head = await commit("a.txt");
  git(work, "push", "--quiet", remote, `${BRANCH}:${BRANCH}`);
  await openPr(head);
  await reviewerPass(head);

  const reply = await brokerMerge();
  assert.deepEqual(reply, { exit: 2, refused: `the gh-broker has no push record for ${BRANCH}` });
  assert.equal(await merged(), "");
});

test("merge refuses when the push record cannot be read", async () => {
  const head = await commit("a.txt");
  await mkdir(join(config.pushesDir, REPO), { recursive: true });
  await writeFile(pushRecordPath(config.pushesDir, { repo: REPO, branch: BRANCH }), "not a sha\n");
  await openPr(head);
  await reviewerPass(head);

  const reply = await brokerMerge();
  assert.deepEqual(reply, { exit: 2, refused: `the push record of ${BRANCH} cannot be read` });
});

test("a drop removes only its own record, and only while the record holds the commit it names", async () => {
  const key = { repo: REPO, branch: BRANCH };
  const nested = { repo: REPO, branch: `${BRANCH}/nested` };
  await writePushRecord(config.pushesDir, key, "a".repeat(40));
  await writePushRecord(config.pushesDir, nested, "b".repeat(40));
  assert.equal(await dropPushRecord(config.pushesDir, key, "c".repeat(40)), false);
  assert.deepEqual(await readPushRecord(config.pushesDir, key), { kind: "pushed", sha: "a".repeat(40) });
  assert.equal(await dropPushRecord(config.pushesDir, key, "a".repeat(40)), true);
  assert.deepEqual(await readPushRecord(config.pushesDir, key), { kind: "none" });
  assert.equal(await dropPushRecord(config.pushesDir, key, "a".repeat(40)), false);
  assert.deepEqual(await readPushRecord(config.pushesDir, nested), { kind: "pushed", sha: "b".repeat(40) });
  assert.deepEqual(await listPushRecords(config.pushesDir), [{ repo: REPO, branch: `${BRANCH}/nested`, sha: "b".repeat(40) }]);
});

test("a push record that exists but cannot be read is unreadable, not absent, and merge refuses", async () => {
  const key = { repo: REPO, branch: BRANCH };
  await mkdir(join(pushRecordPath(config.pushesDir, key), "x"), { recursive: true });
  assert.deepEqual(await readPushRecord(config.pushesDir, key), { kind: "unreadable" });

  const head = await commit("a.txt");
  await openPr(head);
  await reviewerPass(head);
  assert.deepEqual(await brokerMerge(), { exit: 2, refused: `the push record of ${BRANCH} cannot be read` });
  assert.equal(await merged(), "");
});

test("a push record is a file only its owner can read, in a folder only its owner can enter", async () => {
  const key = { repo: REPO, branch: BRANCH };
  await writePushRecord(config.pushesDir, key, "a".repeat(40));
  assert.equal((await stat(pushRecordPath(config.pushesDir, key))).mode & 0o777, 0o600);
  assert.equal((await stat(join(config.pushesDir, REPO))).mode & 0o777, 0o700);
});

test("a write that fails leaves no temp file in the record folder", async () => {
  const key = { repo: REPO, branch: BRANCH };
  const blocker = join(pushRecordPath(config.pushesDir, key), "x");
  await mkdir(blocker, { recursive: true });
  await assert.rejects(writePushRecord(config.pushesDir, key, "a".repeat(40)));
  assert.deepEqual(await readdir(join(config.pushesDir, REPO)), [encodeURIComponent(BRANCH)]);
  assert.deepEqual(await readdir(pushRecordPath(config.pushesDir, key)), ["x"]);
  assert.deepEqual(await readPushRecord(config.pushesDir, key), { kind: "unreadable" });
});

test("the record survives a gh-broker restart", async () => {
  const head = await commit("a.txt");
  const pushed = brokerProcess({ verb: "push", repo: REPO, branch: BRANCH, sha: head, bundle_b64: bundleB64() });
  assert.equal(pushed.exit, 0, JSON.stringify(pushed));

  await openPr(head);
  await reviewerPass(head);
  const reply = brokerProcess({ verb: "merge", repo: REPO, number: 7 });
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.equal(await merged(), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
});
