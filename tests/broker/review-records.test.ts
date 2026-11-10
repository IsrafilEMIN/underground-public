import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { Reply, ReviewRecord } from "../../host/gh-broker/protocol.ts";
import { appendReviewRecord, readReviewRecords, reviewRecordsPath } from "../../host/gh-broker/review-records.ts";
import { defaultConfig } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import { fakeTokens, githubRemote } from "./fake-app.ts";
import { handleAs } from "./session.ts";
import type { Session } from "./session.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const BRANCH = "agent/x";
const AUTHOR: Session = { role: "author" };
const CODE: Session = { role: "code-review" };
const SECURITY: Session = { role: "security-review" };
const RISK: Session = { role: "risk-review" };
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

function request(session: Session, input: Record<string, unknown>): Promise<Reply> {
  return handleAs(config, session, { repo: REPO, ...input }, new AbortController().signal);
}

async function pushedPr(file: string): Promise<string> {
  const head = await commit(file);
  const pushed = await request(AUTHOR, { verb: "push", branch: BRANCH, sha: head, bundle_b64: bundleB64() });
  assert.equal(pushed.exit, 0, JSON.stringify(pushed));
  const pr = {
    number: 7,
    state: "OPEN",
    headRefName: BRANCH,
    baseRefName: "main",
    isCrossRepository: false,
    headRefOid: head,
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    changedFiles: 1,
  };
  await writeFile(join(config.home, "pr.json"), JSON.stringify(pr));
  await writeFile(join(config.home, "gh-files.json"), JSON.stringify([[{ filename: file }]]));
  return head;
}

function review(session: Session, sha: string, verdict: string, reason = ""): Promise<Reply> {
  return request(session, { verb: "review", number: 7, sha, verdict, reason });
}

async function passAll(head: string): Promise<void> {
  for (const session of [CODE, SECURITY, RISK]) {
    const reply = await review(session, head, "pass");
    assert.equal(reply.exit, 0, JSON.stringify(reply));
  }
}

function merge(): Promise<Reply> {
  return request(AUTHOR, { verb: "merge", number: 7 });
}

function merged(): Promise<string> {
  return readFile(join(config.home, "merged"), "utf8").catch(() => "");
}

async function prLines(pr = 7): Promise<unknown[]> {
  const text = await readFile(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr }), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line): unknown => JSON.parse(line));
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-b11-"));
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

test("gh-broker review appends one line to the file of its PR, with the reviewer role it names", async () => {
  const head = await pushedPr("a.txt");
  const first = await review(CODE, head, "pass");
  assert.equal(first.exit, 0, JSON.stringify(first));
  assert.ok("stdout" in first);
  const firstRecord = JSON.parse(first.stdout);
  assert.ok(Number.isFinite(Date.parse(firstRecord.at)));
  assert.deepEqual(await prLines(), [
    { repo: REPO, pr: 7, role: "code-review", head, verdict: "pass", reason: "", at: firstRecord.at },
  ]);

  const second = await review(SECURITY, head, "block", "token in log");
  assert.equal(second.exit, 0, JSON.stringify(second));
  assert.ok("stdout" in second);
  const secondRecord = JSON.parse(second.stdout);
  assert.deepEqual(await prLines(), [
    { repo: REPO, pr: 7, role: "code-review", head, verdict: "pass", reason: "", at: firstRecord.at },
    { repo: REPO, pr: 7, role: "security-review", head, verdict: "block", reason: "token in log", at: secondRecord.at },
  ]);
});

test("a review that names no reviewer role is refused, and writes no record", async () => {
  const head = await pushedPr("a.txt");
  const reply = await review(AUTHOR, head, "pass");
  assert.deepEqual(reply, { exit: 2, refused: "role must be code-review, security-review, risk-review" });
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "records", records: [] });
});

test("pr-status shows every record of the PR with role, verdict, and reason", async () => {
  const head = await pushedPr("a.txt");
  await review(CODE, head, "pass");
  await review(SECURITY, head, "block", "token in log");

  const reply = await request(AUTHOR, { verb: "pr-status", number: 7 });
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.ok("stdout" in reply);
  const status = JSON.parse(reply.stdout);
  assert.equal(status.headRefOid, head);
  assert.deepEqual(status.reviewRecords, await prLines());
  assert.deepEqual(
    status.reviewRecords.map((r: ReviewRecord) => [r.role, r.verdict, r.reason]),
    [
      ["code-review", "pass", ""],
      ["security-review", "block", "token in log"],
    ],
  );

  const asReviewer = await request(CODE, { verb: "pr-status", number: 7 });
  assert.equal(asReviewer.exit, 0, JSON.stringify(asReviewer));
});

test("pr-status of a PR with no records shows an empty list, and a damaged file refuses", async () => {
  await pushedPr("a.txt");
  const empty = await request(AUTHOR, { verb: "pr-status", number: 7 });
  assert.ok("stdout" in empty, JSON.stringify(empty));
  assert.deepEqual(JSON.parse(empty.stdout).reviewRecords, []);

  await mkdir(join(config.reviewsDir, REPO), { recursive: true });
  await writeFile(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }), "not json\n");
  assert.deepEqual(await request(AUTHOR, { verb: "pr-status", number: 7 }), { exit: 2, refused: "cannot read the review records of PR 7" });
});

test("the gate reads only the file of its PR: a damaged file of another PR does not stop it", async () => {
  const head = await pushedPr("a.txt");
  await mkdir(join(config.reviewsDir, REPO), { recursive: true });
  await writeFile(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 8 }), "not json\n");
  await passAll(head);
  const reply = await merge();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 8 }), { kind: "unreadable" });
});

test("a record in the file of another PR makes that file unreadable", async () => {
  const head = "a".repeat(40);
  const other = { repo: REPO, pr: 8, role: "code-review", head, verdict: "pass", reason: "", at: "2026-10-01T00:00:00.000Z" };
  await mkdir(join(config.reviewsDir, REPO), { recursive: true });
  await writeFile(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }), `${JSON.stringify(other)}\n`);
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "unreadable" });
});

test("a last line with no newline that does not parse is a write that never finished, so the reader skips it and keeps the rest", async () => {
  const head = "a".repeat(40);
  const record = { repo: REPO, pr: 7, role: "code-review", head, verdict: "pass", reason: "", at: "2026-10-01T00:00:00.000Z" };
  await mkdir(join(config.reviewsDir, REPO), { recursive: true });
  await writeFile(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }), `${JSON.stringify(record)}\n${JSON.stringify(record).slice(0, 30)}`);
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "records", records: [record] });
});

test("a complete last record with no newline still counts, so a block cannot vanish", async () => {
  const head = "a".repeat(40);
  const pass = { repo: REPO, pr: 7, role: "code-review", head, verdict: "pass", reason: "", at: "2026-10-01T00:00:00.000Z" };
  const block = { ...pass, verdict: "block", reason: "no", at: "2026-10-02T00:00:00.000Z" };
  await mkdir(join(config.reviewsDir, REPO), { recursive: true });
  await writeFile(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }), `${JSON.stringify(pass)}\n${JSON.stringify(block)}`);
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "records", records: [pass, block] });
});

test("a complete last line with no newline that is not a valid record makes the file unreadable, like any other line", async () => {
  const head = "a".repeat(40);
  const pass = { repo: REPO, pr: 7, role: "code-review", head, verdict: "pass", reason: "", at: "2026-10-01T00:00:00.000Z" };
  await mkdir(join(config.reviewsDir, REPO), { recursive: true });
  await writeFile(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }), `${JSON.stringify(pass)}\n${JSON.stringify({ ...pass, role: null, verdict: "block" })}`);
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "unreadable" });
});

test("a record with no role, or a role that cannot review, makes the file unreadable", async () => {
  const head = "a".repeat(40);
  const at = "2026-11-01T00:00:00.000Z";
  for (const line of [
    { repo: REPO, pr: 7, role: null, head, verdict: "pass", reason: "", at },
    { repo: REPO, pr: 7, head, verdict: "pass", reason: "", at },
    { repo: REPO, pr: 7, role: "author", head, verdict: "pass", reason: "", at },
  ]) {
    await mkdir(join(config.reviewsDir, REPO), { recursive: true });
    await writeFile(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }), `${JSON.stringify(line)}\n`);
    assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "unreadable" }, JSON.stringify(line));
  }
});

test("records of a merged PR stay in its file", async () => {
  const head = await pushedPr("a.txt");
  await passAll(head);
  const before = await prLines();

  const reply = await merge();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.equal(await merged(), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
  assert.deepEqual(await prLines(), before);
  assert.equal(before.length, 3);
});

function record(pr: number, reason: string): ReviewRecord {
  return { repo: REPO, pr, role: "code-review", head: "a".repeat(40), verdict: "block", reason, at: "2026-10-01T00:00:00.000Z" };
}

const BIG = 1536 * 1024;

test("a review file that exists but cannot be read is unreadable, not empty, and pr-status refuses", async () => {
  await pushedPr("a.txt");
  await mkdir(join(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }), "x"), { recursive: true });
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "unreadable" });
  assert.deepEqual(await request(AUTHOR, { verb: "pr-status", number: 7 }), { exit: 2, refused: "cannot read the review records of PR 7" });
});

test("a review file is readable only by its owner, in a folder only its owner can enter", async () => {
  await appendReviewRecord(config.reviewsDir, record(7, "bug"));
  assert.equal((await stat(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }))).mode & 0o777, 0o600);
  assert.equal((await stat(join(config.reviewsDir, REPO))).mode & 0o777, 0o700);
});

test("appends that run at once land whole, one per line, in the order they were asked", async () => {
  const records = ["a", "b", "c", "d", "e", "f"].map((letter) => record(7, letter.repeat(BIG)));
  await Promise.all(records.map((one) => appendReviewRecord(config.reviewsDir, one)));
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "records", records });
});
