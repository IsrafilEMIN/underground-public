import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Reply, ReviewRecord } from "../../host/broker/protocol.ts";
import { appendReviewRecord, movedLegacyPath, moveLegacyReviews, readReviewRecords, reviewRecordsPath } from "../../host/broker/review-records.ts";
import { defaultConfig, startServer, stopServer } from "../../host/broker/server.ts";
import type { ServerConfig } from "../../host/broker/server.ts";
import { fakeTokens, tokenRemote } from "./fake-app.ts";
import { handleAs } from "./session.ts";
import type { Session as Binding } from "./session.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const BRANCH = "agent/x";
const AUTHOR: Binding = { repo: REPO, role_name: "author", role: "author" };
const CODE: Binding = { repo: REPO, role_name: "code-review", role: "code-review" };
const SECURITY: Binding = { repo: REPO, role_name: "sec-a", role: "security-review" };
const RISK: Binding = { repo: REPO, role_name: "risk-review", role: "risk-review" };
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

function request(binding: Binding, input: Record<string, unknown>): Promise<Reply> {
  return handleAs(config, binding, { repo: REPO, ...input }, new AbortController().signal);
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

function review(binding: Binding, sha: string, verdict: string, reason = ""): Promise<Reply> {
  return request(binding, { verb: "review", number: 7, sha, verdict, reason });
}

async function passAll(head: string): Promise<void> {
  for (const binding of [CODE, SECURITY, RISK]) {
    const reply = await review(binding, head, "pass");
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

function legacy(pr: number, head: string, verdict: string, reason: string, repo = REPO): Record<string, unknown> {
  return { repo, pr, head, verdict, reason, at: "2026-10-01T00:00:00.000Z" };
}

function migrated(record: Record<string, unknown>): Record<string, unknown> {
  return { repo: record.repo, pr: record.pr, role_name: null, role: null, head: record.head, verdict: record.verdict, reason: record.reason, at: record.at };
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-b11-"));
  config = {
    ...defaultConfig(),
    socketPath: join(root, "run", "broker.sock"),
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
  await writeFile(config.ghPath, FAKE_GH, { mode: 0o755 });
  remote = join(root, "remote.git");
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", remote], { env: GIT_ENV });
  const bare = join(config.reposRoot, `${REPO}.git`);
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", bare], { env: GIT_ENV });
  git(bare, "config", `url.file://${remote}.insteadOf`, tokenRemote(REPO));
  work = join(root, "work");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
});

// Since 2026-11-03 the record's role name is the reviewer role that the request names.
test("broker review appends one line to the file of its PR, with the reviewer role it names", async () => {
  const head = await pushedPr("a.txt");
  const first = await review(CODE, head, "pass");
  assert.equal(first.exit, 0, JSON.stringify(first));
  assert.ok("stdout" in first);
  const firstRecord = JSON.parse(first.stdout);
  assert.ok(Number.isFinite(Date.parse(firstRecord.at)));
  assert.deepEqual(await prLines(), [
    { repo: REPO, pr: 7, role_name: "code-review", role: "code-review", head, verdict: "pass", reason: "", at: firstRecord.at },
  ]);

  const second = await review(SECURITY, head, "block", "token in log");
  assert.equal(second.exit, 0, JSON.stringify(second));
  assert.ok("stdout" in second);
  const secondRecord = JSON.parse(second.stdout);
  assert.deepEqual(await prLines(), [
    { repo: REPO, pr: 7, role_name: "code-review", role: "code-review", head, verdict: "pass", reason: "", at: firstRecord.at },
    { repo: REPO, pr: 7, role_name: "security-review", role: "security-review", head, verdict: "block", reason: "token in log", at: secondRecord.at },
  ]);
});

test("on first start the broker moves reviews.json into the PR files, and a second start moves nothing", async () => {
  const run = await tempDir(join(process.env.XDG_STATE_HOME ?? tmpdir(), "ugt-"));
  const started = { ...config, socketPath: join(run, "broker.sock") };
  const records = [legacy(7, "a".repeat(40), "block", "bug"), legacy(8, "a".repeat(40), "pass", "")];
  await writeFile(config.legacyReviewsFile, JSON.stringify(records));
  try {
    await stopServer(await startServer(started));
    assert.deepEqual(await prLines(7), [migrated(records[0])]);
    assert.deepEqual(await prLines(8), [migrated(records[1])]);
    await assert.rejects(readFile(config.legacyReviewsFile), { code: "ENOENT" });

    await stopServer(await startServer(started));
    assert.deepEqual(await prLines(7), [migrated(records[0])]);
    assert.deepEqual(await prLines(8), [migrated(records[1])]);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
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
    status.reviewRecords.map((r: ReviewRecord) => [r.role_name, r.role, r.verdict, r.reason]),
    [
      ["code-review", "code-review", "pass", ""],
      ["security-review", "security-review", "block", "token in log"],
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
  const other = { repo: REPO, pr: 8, role_name: "code-review", role: "code-review", head, verdict: "pass", reason: "", at: "2026-10-01T00:00:00.000Z" };
  await mkdir(join(config.reviewsDir, REPO), { recursive: true });
  await writeFile(reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 }), `${JSON.stringify(other)}\n`);
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "unreadable" });
});

test("the broker moves each record of reviews.json into the file of its PR once", async () => {
  const head = "a".repeat(40);
  const records = [
    legacy(7, head, "pass", ""),
    legacy(8, head, "block", "bug"),
    legacy(7, "b".repeat(40), "manual", "migration"),
    legacy(7, head, "pass", "", "o/other"),
  ];
  await writeFile(config.legacyReviewsFile, JSON.stringify(records, null, 2));

  assert.deepEqual(await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir), { kind: "moved", count: 4 });
  assert.deepEqual(await prLines(7), [migrated(records[0]), migrated(records[2])]);
  assert.deepEqual(await prLines(8), [migrated(records[1])]);
  const otherRepo = await readReviewRecords(config.reviewsDir, { repo: "o/other", pr: 7 });
  assert.deepEqual(otherRepo, { kind: "records", records: [migrated(records[3])] });
  await assert.rejects(readFile(config.legacyReviewsFile), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(movedLegacyPath(config.legacyReviewsFile), "utf8")), records);

  assert.deepEqual(await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir), { kind: "none" });
  assert.deepEqual(await prLines(7), [migrated(records[0]), migrated(records[2])]);
  assert.deepEqual(await prLines(8), [migrated(records[1])]);
});

test("a move that stopped before the rename moves nothing twice", async () => {
  const records = [legacy(7, "a".repeat(40), "block", "bug")];
  await writeFile(config.legacyReviewsFile, JSON.stringify(records));
  assert.deepEqual(await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir), { kind: "moved", count: 1 });
  await writeFile(config.legacyReviewsFile, JSON.stringify(records));
  assert.deepEqual(await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir), { kind: "moved", count: 0 });
  assert.deepEqual(await prLines(7), [migrated(records[0])]);
});

test("a migrated block still refuses merge, even after a pass with a role on the head", async () => {
  const head = await pushedPr("a.txt");
  await writeFile(config.legacyReviewsFile, JSON.stringify([legacy(7, head, "block", "bug")]));
  await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir);
  await review(CODE, head, "pass");

  const reply = await merge();
  assert.deepEqual(reply, {
    exit: 2,
    refused: "an old record with no role name blocks it: bug",
  });
  assert.equal(await merged(), "");
});

test("a migrated manual on the head still refuses merge", async () => {
  const head = await pushedPr("a.txt");
  await writeFile(config.legacyReviewsFile, JSON.stringify([legacy(7, head, "manual", "migration")]));
  await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir);
  await review(CODE, head, "pass");

  const reply = await merge();
  assert.deepEqual(reply, {
    exit: 2,
    refused: `a hold refuses, so the owner merges this PR on GitHub: an old record with no role name asked for manual review of ${head} at 2026-10-01T00:00:00.000Z: migration`,
  });
  assert.equal(await merged(), "");
});

test("a migrated pass counts for no role", async () => {
  const head = await pushedPr("a.txt");
  await writeFile(config.legacyReviewsFile, JSON.stringify([legacy(7, head, "pass", "")]));
  await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir);

  const reply = await merge();
  assert.deepEqual(reply, { exit: 2, refused: "code-review has no verdict on it" });

  await passAll(head);
  const ok = await merge();
  assert.equal(ok.exit, 0, JSON.stringify(ok));
});

test("a reviews.json that the broker could not move refuses merge and stays in place", async () => {
  const head = await pushedPr("a.txt");
  await review(CODE, head, "pass");
  await writeFile(config.legacyReviewsFile, "not json");
  const moved = await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir);
  assert.equal(moved.kind, "failed");

  assert.deepEqual(await merge(), { exit: 2, refused: "cannot read review records" });
  assert.equal(await readFile(config.legacyReviewsFile, "utf8"), "not json");
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
  return { repo: REPO, pr, role_name: "code-review", role: "code-review", head: "a".repeat(40), verdict: "block", reason, at: "2026-10-01T00:00:00.000Z" };
}

// Node writes an append of more than 512 KiB in several writes, so two appends that run at once would interleave.
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

test("a review that arrives during the move of reviews.json lands whole, after the moved records", async () => {
  const old = legacy(7, "a".repeat(40), "block", "o".repeat(BIG));
  await writeFile(config.legacyReviewsFile, JSON.stringify([old]));
  const fresh = record(7, "n".repeat(BIG));
  const [moved] = await Promise.all([moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir), appendReviewRecord(config.reviewsDir, fresh)]);
  assert.deepEqual(moved, { kind: "moved", count: 1 });
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "records", records: [migrated(old), fresh] });
});

test("a reviews.json that cannot be read fails the move, and nothing moves", async () => {
  await mkdir(join(config.legacyReviewsFile, "x"), { recursive: true });
  assert.deepEqual(await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir), { kind: "failed", reason: `cannot read ${config.legacyReviewsFile}` });
  await assert.rejects(stat(movedLegacyPath(config.legacyReviewsFile)), { code: "ENOENT" });
  await assert.rejects(stat(config.reviewsDir), { code: "ENOENT" });
});

test("a reviews.json that holds something other than review records fails the move, stays, and moves nothing", async () => {
  const good = legacy(7, "a".repeat(40), "block", "bug");
  for (const content of [[good, { repo: REPO, pr: 7 }], [good, { ...good, verdict: "maybe" }], { 0: good }]) {
    const text = JSON.stringify(content);
    await writeFile(config.legacyReviewsFile, text);
    const moved = await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir);
    assert.equal(moved.kind, "failed", text);
    assert.ok(("reason" in moved ? moved.reason : "").startsWith(`${config.legacyReviewsFile} `), text);
    assert.equal(await readFile(config.legacyReviewsFile, "utf8"), text);
    assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "records", records: [] }, text);
  }
});

test("an empty reviews.json moves no record and is set aside like a full one", async () => {
  for (const text of ["", " \n"]) {
    await rm(movedLegacyPath(config.legacyReviewsFile), { force: true });
    await writeFile(config.legacyReviewsFile, text);
    assert.deepEqual(await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir), { kind: "moved", count: 0 }, JSON.stringify(text));
    await assert.rejects(stat(config.legacyReviewsFile), { code: "ENOENT" });
    assert.equal(await readFile(movedLegacyPath(config.legacyReviewsFile), "utf8"), text);
  }
});

test("a move into a PR file that cannot be read fails, leaves that file and reviews.json as they were", async () => {
  const text = JSON.stringify([legacy(7, "a".repeat(40), "block", "bug")]);
  await writeFile(config.legacyReviewsFile, text);
  const prFile = reviewRecordsPath(config.reviewsDir, { repo: REPO, pr: 7 });
  await mkdir(join(config.reviewsDir, REPO), { recursive: true });
  await writeFile(prFile, "not json\n");
  assert.deepEqual(await moveLegacyReviews(config.legacyReviewsFile, config.reviewsDir), { kind: "failed", reason: `cannot read ${prFile}` });
  assert.equal(await readFile(prFile, "utf8"), "not json\n");
  assert.equal(await readFile(config.legacyReviewsFile, "utf8"), text);
  await assert.rejects(stat(movedLegacyPath(config.legacyReviewsFile)), { code: "ENOENT" });
});
