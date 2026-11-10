import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { REVIEWER_ROLES } from "../../host/gh-broker/protocol.ts";
import type { Reply } from "../../host/gh-broker/protocol.ts";
import { readPushRecord, writePushRecord } from "../../host/gh-broker/push-record.ts";
import { appendReviewRecord } from "../../host/gh-broker/review-records.ts";
import { defaultConfig } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import { fakeTokens, githubRemote } from "./fake-app.ts";
import { handleAs } from "./session.ts";
import type { Session } from "./session.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const OTHER_REPO = "o/other";
const BRANCH = "agent/x";
const AUTHOR: Session = { role: "author" };
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/gh-calls"
case "$1 $2 $4" in
"repo view "*) printf '{"defaultBranchRef":{"name":"%s"}}\\n' "$(cat "$HOME/default-branch")" ;;
"pr view "*) cat "$HOME/pr.json" ;;
"api --paginate repos/${REPO}/pulls/7/files") cat "$HOME/gh-files.json" ;;
"pr merge "*) printf '%s\\n' "$*" >> "$HOME/merged"; echo merged ;;
"pr create "*) printf '%s\\n' "$*" > "$HOME/created"; cat > "$HOME/created-body"; echo "https://github.com/${REPO}/pull/7" ;;
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

async function commit(branch: string, file: string): Promise<string> {
  git(work, "checkout", "--quiet", "-B", branch);
  await writeFile(join(work, file), `${file}\n`);
  git(work, "add", file);
  git(work, "commit", "--quiet", "-m", file);
  return git(work, "rev-parse", "HEAD");
}

function request(input: Record<string, unknown>, session: Session = AUTHOR): Promise<Reply> {
  return handleAs(config, session, { repo: REPO, ...input }, new AbortController().signal);
}

function push(branch: string, sha: string): Promise<Reply> {
  const bundle = execFileSync(config.gitPath, ["bundle", "create", "-", `refs/heads/${branch}`], { cwd: work, env: GIT_ENV }).toString("base64");
  return request({ verb: "push", branch, sha, bundle_b64: bundle });
}

function remoteRef(branch: string): string {
  return git(remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
}

async function readyPr(head: string, pr: Record<string, unknown> = {}): Promise<void> {
  const view = {
    headRefName: BRANCH,
    baseRefName: "main",
    isCrossRepository: false,
    headRefOid: head,
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    changedFiles: 1,
    ...pr,
  };
  await writeFile(join(config.home, "pr.json"), JSON.stringify(view));
  await writeFile(join(config.home, "gh-files.json"), JSON.stringify([[{ filename: "a.txt" }]]));
  const at = new Date().toISOString();
  for (const role of REVIEWER_ROLES) {
    await appendReviewRecord(config.reviewsDir, { repo: REPO, pr: 7, role, head, verdict: "pass", reason: "", at });
  }
}

function merge(): Promise<Reply> {
  return request({ verb: "merge", number: 7 });
}

function readHome(name: string): Promise<string> {
  return readFile(join(config.home, name), "utf8").catch(() => "");
}

function assertRefused(reply: Reply): void {
  assert.equal(reply.exit, 2, JSON.stringify(reply));
  assert.ok("refused" in reply, JSON.stringify(reply));
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-refusals-"));
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
  await writeFile(join(config.home, "default-branch"), "main");
  await writeFile(config.ghPath, FAKE_GH, { mode: 0o755 });
  remote = join(root, "remote.git");
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", remote], { env: GIT_ENV });
  const bare = join(config.reposRoot, `${REPO}.git`);
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", bare], { env: GIT_ENV });
  git(bare, "config", `url.file://${remote}.insteadOf`, githubRemote(REPO));
  work = join(root, "work");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
  const base = await commit("main", "base.txt");
  git(work, "push", "--quiet", remote, "main:main");
  assert.equal(remoteRef("main"), base);
});

afterEach(async () => {
  await chmod(join(config.pushesDir, REPO), 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

test("a push to main is refused, and main on GitHub and the push records stay unchanged", async () => {
  const base = remoteRef("main");
  const head = await commit("main", "a.txt");

  assertRefused(await push("main", head));
  assert.equal(remoteRef("main"), base);
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: "main" }), { kind: "none" });
});

test("a push to a branch that is not agent/* is refused and lands nothing on GitHub", async () => {
  const head = await commit("feature/x", "a.txt");

  assertRefused(await push("feature/x", head));
  assert.equal(remoteRef("feature/x"), "");
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: "feature/x" }), { kind: "none" });
});

test("a push to the default branch is refused even when its name is agent/*, while another agent branch pushes", async () => {
  await writeFile(join(config.home, "default-branch"), "agent/main");
  const base = git(work, "rev-parse", "main");
  git(work, "push", "--quiet", remote, "main:agent/main");
  const head = await commit("agent/main", "a.txt");

  assertRefused(await push("agent/main", head));
  assert.equal(remoteRef("agent/main"), base);
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: "agent/main" }), { kind: "none" });

  const other = await commit(BRANCH, "b.txt");
  const pushed = await push(BRANCH, other);
  assert.equal(pushed.exit, 0, JSON.stringify(pushed));
  assert.equal(remoteRef(BRANCH), other);
});

test("a push whose record cannot be written fails, and a merge of that head refuses and merges nothing", async () => {
  const first = await commit(BRANCH, "a.txt");
  const one = await push(BRANCH, first);
  assert.equal(one.exit, 0, JSON.stringify(one));
  const second = await commit(BRANCH, "b.txt");

  await chmod(join(config.pushesDir, REPO), 0o500);
  const two = await push(BRANCH, second);
  await chmod(join(config.pushesDir, REPO), 0o700);
  assert.notEqual(two.exit, 0, JSON.stringify(two));

  await readyPr(second);
  assertRefused(await merge());
  assert.equal(await readHome("merged"), "");
});

test("merge refuses a PR whose head branch is in another repo, and the same PR from this repo merges", async () => {
  const head = await commit(BRANCH, "a.txt");
  assert.equal((await push(BRANCH, head)).exit, 0);
  await readyPr(head, { isCrossRepository: true });

  assertRefused(await merge());
  assert.equal(await readHome("merged"), "");

  await readyPr(head);
  const ok = await merge();
  assert.equal(ok.exit, 0, JSON.stringify(ok));
  assert.equal(await readHome("merged"), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
});

test("merge refuses a PR whose head is not an agent/* branch, even with a push record, green CI, and three passes", async () => {
  const head = await commit("feature/x", "a.txt");
  git(work, "push", "--quiet", remote, "feature/x:feature/x");
  await writePushRecord(config.pushesDir, { repo: REPO, branch: "feature/x" }, head);
  await readyPr(head, { headRefName: "feature/x" });

  assertRefused(await merge());
  assert.equal(await readHome("merged"), "");
  assert.equal(remoteRef("feature/x"), head);
});

test("an author's pr-create opens a PR from its agent branch with its title and body", async () => {
  const head = await commit(BRANCH, "a.txt");
  assert.equal((await push(BRANCH, head)).exit, 0);

  const reply = await request({ verb: "pr-create", head: BRANCH, title: "Fix the thing", body: "Line one\nLine two\n" });
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.ok("stdout" in reply && reply.stdout.includes(`https://github.com/${REPO}/pull/7`), JSON.stringify(reply));
  const created = await readHome("created");
  assert.ok(created.startsWith("pr create "), created);
  assert.ok(created.includes(`--repo ${REPO}`), created);
  assert.ok(created.includes(`--head=${BRANCH}`), created);
  assert.ok(created.includes("--title=Fix the thing"), created);
  assert.equal(await readHome("created-body"), "Line one\nLine two\n");
});

test("a repo where the gh-broker app is not installed gets no token, so no gh call, push, merge, or record happens", async () => {
  const head = await commit(BRANCH, "a.txt");
  const bundle = execFileSync(config.gitPath, ["bundle", "create", "-", `refs/heads/${BRANCH}`], { cwd: work, env: GIT_ENV }).toString("base64");
  const signal = new AbortController().signal;
  const installed = config.github;
  config.github = {
    token: (repo, s) => (repo === REPO ? installed.token(repo, s) : Promise.reject(new Error(`the app is not installed on ${repo}`))),
    drop: (repo) => installed.drop(repo),
  };

  for (const input of [
    { verb: "sync", repo: OTHER_REPO },
    { verb: "push", repo: OTHER_REPO, branch: BRANCH, sha: head, bundle_b64: bundle },
    { verb: "pr-create", repo: OTHER_REPO, head: BRANCH, title: "t", body: "" },
    { verb: "pr-status", repo: OTHER_REPO, number: 7 },
    { verb: "merge", repo: OTHER_REPO, number: 7 },
  ]) {
    const reply = await handleAs(config, AUTHOR, input, signal);
    assert.notEqual(reply.exit, 0, `${input.verb}: ${JSON.stringify(reply)}`);
    assert.match(JSON.stringify(reply), /not installed on|cannot get a GitHub App token/, input.verb);
  }
  assert.equal(await readHome("gh-calls"), "");
  assert.equal(await readHome("merged"), "");
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: OTHER_REPO, branch: BRANCH }), { kind: "none" });
});
