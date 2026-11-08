import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Reply } from "../../host/gh-broker/protocol.ts";
import { readReviewRecords } from "../../host/gh-broker/review-records.ts";
import { defaultConfig } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import { fakeTokens, tokenRemote } from "./fake-app.ts";
import { handleAs } from "./session.ts";
import type { Session } from "./session.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const BRANCH = "agent/x";
const AUTHOR: Session = { role: "author" };
const CODE: Session = { role: "code-review" };
const SECURITY: Session = { role: "security-review" };
const RISK: Session = { role: "risk-review" };
const REVIEWERS = [CODE, SECURITY, RISK];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const HOLD = "a hold refuses, so the owner merges this PR on GitHub";

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
let commits = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(config.gitPath, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
}

function request(session: Session, input: Record<string, unknown>): Promise<Reply> {
  return handleAs(config, session, { repo: REPO, ...input }, new AbortController().signal);
}

async function pushedHead(files: string[] = ["a.txt"], checks = "SUCCESS"): Promise<string> {
  commits += 1;
  git(work, "checkout", "--quiet", "-B", BRANCH);
  await writeFile(join(work, "a.txt"), `${commits}\n`);
  git(work, "add", "a.txt");
  git(work, "commit", "--quiet", "-m", String(commits));
  const head = git(work, "rev-parse", "HEAD");
  const bundle = execFileSync(config.gitPath, ["bundle", "create", "-", `refs/heads/${BRANCH}`], { cwd: work, env: GIT_ENV }).toString("base64");
  const pushed = await request(AUTHOR, { verb: "push", branch: BRANCH, sha: head, bundle_b64: bundle });
  assert.equal(pushed.exit, 0, JSON.stringify(pushed));
  const pr = {
    number: 7,
    state: "OPEN",
    headRefName: BRANCH,
    baseRefName: "main",
    isCrossRepository: false,
    headRefOid: head,
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: checks }],
    changedFiles: files.length,
  };
  await writeFile(join(config.home, "pr.json"), JSON.stringify(pr));
  await writeFile(join(config.home, "gh-files.json"), JSON.stringify([files.map((filename) => ({ filename }))]));
  return head;
}

async function review(session: Session, sha: string, verdict: string, reason = ""): Promise<void> {
  const reply = await request(session, { verb: "review", number: 7, sha, verdict, reason });
  assert.equal(reply.exit, 0, JSON.stringify(reply));
}

async function passAll(head: string): Promise<void> {
  for (const session of REVIEWERS) await review(session, head, "pass");
}

async function blockedHead(sessions: Session[]): Promise<string> {
  const head = await pushedHead();
  for (const session of sessions) await review(session, head, "block", `bug in ${head}`);
  return head;
}

function merge(): Promise<Reply> {
  return request(AUTHOR, { verb: "merge", number: 7 });
}

function merged(): Promise<string> {
  return readFile(join(config.home, "merged"), "utf8").catch(() => "");
}

async function assertMerges(head: string): Promise<void> {
  const reply = await merge();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.equal(await merged(), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
}

async function assertRefuses(refused: string | RegExp): Promise<void> {
  const reply = await merge();
  assert.ok("refused" in reply, JSON.stringify(reply));
  if (typeof refused === "string") assert.equal(reply.refused, refused);
  else assert.match(reply.refused, refused);
  assert.equal(await merged(), "");
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-b10-"));
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
  const remote = join(root, "remote.git");
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

test("code-review and security-review give pass or block, and risk-review gives pass or manual", async () => {
  const head = await pushedHead();
  for (const [session, verdict] of [
    [CODE, "manual"],
    [SECURITY, "manual"],
    [RISK, "block"],
  ] as const) {
    const reply = await request(session, { verb: "review", number: 7, sha: head, verdict, reason: "r" });
    assert.match("refused" in reply ? reply.refused : "", new RegExp(`${session.role} cannot give ${verdict}`));
  }
  assert.deepEqual(await readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 }), { kind: "records", records: [] });
});

test("green CI and a pass on the head from all three roles merge", async () => {
  const head = await pushedHead();
  await passAll(head);
  await assertMerges(head);
});

test("red CI refuses even with a pass from all three roles", async () => {
  const head = await pushedHead(["a.txt"], "FAILURE");
  await passAll(head);
  await assertRefuses("check ci is FAILURE");
});

test("a missing role verdict refuses and names the role", async () => {
  const head = await pushedHead();
  await assertRefuses("code-review has no verdict on it");
  await review(CODE, head, "pass");
  await assertRefuses("security-review has no verdict on it");
  await review(SECURITY, head, "pass");
  await assertRefuses("risk-review has no verdict on it");
  await review(RISK, head, "pass");
  await assertMerges(head);
});

test("a block on the head refuses and names the role, and a later pass on the same head does not clear it", async () => {
  const head = await pushedHead();
  await passAll(head);
  await review(SECURITY, head, "block", "token in log");
  await assertRefuses("security-review blocks it: token in log");
  await review(SECURITY, head, "pass");
  await assertRefuses("security-review blocks it: token in log");
});

test("after a new head an old pass does not count, and an old block does not refuse", async () => {
  const first = await pushedHead();
  await passAll(first);
  await review(CODE, first, "block", "wrong task");
  const second = await pushedHead();
  await assertRefuses("code-review has no verdict on it");
  await review(CODE, second, "pass");
  await review(SECURITY, second, "pass");
  await assertRefuses("risk-review has no verdict on it");
  await review(RISK, second, "pass");
  await assertMerges(second);
});

test("a manual on any head is a hold on every later head", async () => {
  const first = await pushedHead();
  await review(RISK, first, "manual", "touches billing");
  const second = await pushedHead();
  await passAll(second);
  const hold = new RegExp(`^${HOLD}: risk-review asked for manual review of ${first} at .*: touches billing$`);
  await assertRefuses(hold);
});

test("a changed protected path on the head is a hold", async () => {
  const head = await pushedHead(["a.txt", ".github/workflows/ci.yml"]);
  await passAll(head);
  const hold = `${HOLD}: protected path .github/workflows/ci.yml changed`;
  await assertRefuses(hold);
});

test("a block on the fourth distinct blocked head is a hold, and two roles that block one head are one attempt", async () => {
  await blockedHead([CODE]);
  await blockedHead([CODE, SECURITY]);
  await blockedHead([SECURITY]);
  const fourth = await blockedHead([SECURITY]);
  const last = await pushedHead();
  await passAll(last);
  const hold = new RegExp(`^${HOLD}: attempt 4 \\(${fourth}\\) got a block at .* from security-review: bug in ${fourth}$`);
  await assertRefuses(hold);
});

test("three blocked heads, with two roles on one, make no attempt-limit hold", async () => {
  await blockedHead([CODE]);
  await blockedHead([CODE, SECURITY]);
  await blockedHead([SECURITY]);
  const last = await pushedHead();
  await passAll(last);
  await assertMerges(last);
});

test("three heads with no block, then one blocked head, make no attempt-limit hold", async () => {
  for (let i = 0; i < 3; i += 1) await passAll(await pushedHead());
  await blockedHead([CODE]);
  const last = await pushedHead();
  await passAll(last);
  await assertMerges(last);
});
