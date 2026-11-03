import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { MAX_REQUEST_BYTES, REVIEWER_ROLES, isMergeReply } from "../../host/broker/protocol.ts";
import type { PushRecord, Reply } from "../../host/broker/protocol.ts";
import { readPushRecord, writePushRecord } from "../../host/broker/push-record.ts";
import { appendReviewRecord, readReviewRecords } from "../../host/broker/review-records.ts";
import { defaultConfig, serveConnection } from "../../host/broker/server.ts";
import type { ServerConfig } from "../../host/broker/server.ts";
import { FAKE_TOKEN, fakeTokens, tokenRemote } from "./fake-app.ts";
import { handleAs } from "./session.ts";
import type { Session } from "./session.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const BRANCH = "agent/x";
const CI_HEAD = "a".repeat(40);
const AUTHOR: Session = { role: "author" };
const REVIEWER: Session = { role: "code-review" };
const REAL_GIT = defaultConfig().gitPath;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const UNREADABLE_DEFAULT_BRANCHES = [
  '{"defaultBranchRef":{"name":"-main"}}',
  '{"defaultBranchRef":{"name":"a..b"}}',
  '{"defaultBranchRef":null}',
  "not json",
];

// The fake gh logs every call and answers from files in $HOME. A call whose arguments contain the
// text of $HOME/gh-fail fails the way GitHub fails: exit 4 and an HTTP error on stderr.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/gh-calls"
if [ -f "$HOME/gh-fail" ]; then
  case "$*" in *"$(cat "$HOME/gh-fail")"*) echo "fake gh: HTTP 502 on $1 $2" >&2; exit 4 ;; esac
fi
case "$1 $2" in
"repo view") cat "$HOME/repo.json" ;;
"pr view") cat "$HOME/pr.json" ;;
"pr create") printf '%s\\n' "$*" > "$HOME/created"; cat > "$HOME/created-body"; echo "https://github.com/${REPO}/pull/7" ;;
"pr merge") printf '%s\\n' "$*" >> "$HOME/merged"; echo merged ;;
"run view") printf '%s\\n' "$*" >> "$HOME/viewed"; cat "$HOME/log-$3.txt" ;;
"api --paginate")
  case "$4" in
  "repos/${REPO}/pulls/7/files") cat "$HOME/files.json" ;;
  "repos/${REPO}/deployments?"*) cat "$HOME/deployments.json" ;;
  "repos/${REPO}/actions/runs?"*) cat "$HOME/runs.json" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
  esac ;;
*) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;

// The fake git runs the real git with the token URL of GitHub pointed at a local bare repo, so no call
// reaches GitHub. A call whose arguments contain the text of $HOME/git-fail fails with exit 3.
function fakeGit(remote: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/git-calls"
if [ -f "$HOME/git-fail" ]; then
  case "$*" in *"$(cat "$HOME/git-fail")"*) echo "fake git: cannot $(cat "$HOME/git-fail")" >&2; exit 3 ;; esac
fi
exec '${REAL_GIT}' -c 'url.file://${remote}.insteadOf=${tokenRemote(REPO)}' "$@"
`;
}

let root: string;
let config: ServerConfig;
let work: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

async function commit(branch: string, file: string): Promise<string> {
  git(work, "checkout", "--quiet", "-B", branch);
  await writeFile(join(work, file), `${file}\n`);
  git(work, "add", file);
  git(work, "commit", "--quiet", "-m", file);
  return git(work, "rev-parse", "HEAD");
}

function bundleOf(branch: string): string {
  return execFileSync(REAL_GIT, ["bundle", "create", "-", `refs/heads/${branch}`], { cwd: work, env: GIT_ENV }).toString("base64");
}

function request(input: Record<string, unknown>, session: Session = AUTHOR): Promise<Reply> {
  return handleAs(config, session, { repo: REPO, ...input }, new AbortController().signal);
}

function push(branch: string, sha: string, bundleBranch: string = branch): Promise<Reply> {
  return request({ verb: "push", branch, sha, bundle_b64: bundleOf(bundleBranch) });
}

function remoteRef(branch: string): string {
  return git(remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
}

function brokerTempRefs(): string {
  return git(join(config.reposRoot, `${REPO}.git`), "for-each-ref", "--format=%(refname)", "refs/broker/");
}

function pushRecord(branch: string = BRANCH): Promise<PushRecord> {
  return readPushRecord(config.pushesDir, { repo: REPO, branch });
}

function readHome(name: string): Promise<string> {
  return readFile(join(config.home, name), "utf8").catch(() => "");
}

function writeHome(name: string, text: string): Promise<void> {
  return writeFile(join(config.home, name), text);
}

function failGh(match: string): Promise<void> {
  return writeHome("gh-fail", match);
}

function failGit(match: string): Promise<void> {
  return writeHome("git-fail", match);
}

function assertRefused(reply: Reply, reason: string): void {
  assert.equal(reply.exit, 2, JSON.stringify(reply));
  assert.ok("refused" in reply && reply.refused.includes(reason), JSON.stringify(reply));
}

// A failure of git or gh reaches the caller as that tool's exit code and error output, not as a refusal.
function assertForwarded(reply: Reply, exit: number, stderr: string): void {
  assert.ok(!("refused" in reply), JSON.stringify(reply));
  assert.equal(reply.exit, exit, JSON.stringify(reply));
  assert.ok(reply.stderr.includes(stderr), JSON.stringify(reply));
}

function assertCannotReadDefaultBranch(reply: Reply): void {
  assert.ok(!("refused" in reply), JSON.stringify(reply));
  assert.equal(reply.exit, 1, JSON.stringify(reply));
  assert.ok(reply.stderr.includes("cannot read default branch"), JSON.stringify(reply));
}

// A PR head that the broker pushed and that has a pass from all three reviewer roles and green CI.
async function pushedHead(): Promise<string> {
  const head = await commit(BRANCH, "a.txt");
  git(work, "push", "--quiet", remote, `${BRANCH}:${BRANCH}`);
  await writePushRecord(config.pushesDir, { repo: REPO, branch: BRANCH }, head);
  const at = new Date().toISOString();
  for (const role of REVIEWER_ROLES) {
    await appendReviewRecord(config.reviewsDir, { repo: REPO, pr: 7, role, head, verdict: "pass", reason: "", at });
  }
  return head;
}

async function prView(head: string, pr: Record<string, unknown> = {}, files: unknown[] = [{ filename: "a.txt" }]): Promise<void> {
  const view = {
    headRefName: BRANCH,
    baseRefName: "main",
    isCrossRepository: false,
    headRefOid: head,
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    changedFiles: files.length,
    ...pr,
  };
  await writeHome("pr.json", JSON.stringify(view));
  await writeHome("files.json", JSON.stringify([files]));
}

function merge(): Promise<Reply> {
  return request({ verb: "merge", number: 7 });
}

function run(id: number): Record<string, unknown> {
  return { id, name: `wf${id}`, event: "pull_request", head_sha: CI_HEAD, status: "completed", conclusion: "failure" };
}

async function ciGithub(pr: Record<string, unknown> = {}): Promise<void> {
  await writeHome("pr.json", JSON.stringify({ headRefName: BRANCH, isCrossRepository: false, headRefOid: CI_HEAD, ...pr }));
  await writeHome("deployments.json", JSON.stringify([[]]));
  await writeHome("runs.json", JSON.stringify([{ total_count: 2, workflow_runs: [run(11), run(12)] }]));
  await writeHome("log-11.txt", "ci\tlint\tfirst failure\n");
  await writeHome("log-12.txt", "ci\ttest\tsecond failure\n");
}

function ciLog(): Promise<Reply> {
  return request({ verb: "ci-log", number: 7 });
}

async function apiCalls(): Promise<string[]> {
  return (await readHome("gh-calls")).split("\n").filter((line) => line.startsWith("api ") || line.startsWith("run "));
}

function review(sha: string): Promise<Reply> {
  return request({ verb: "review", number: 7, sha, verdict: "pass", reason: "" }, REVIEWER);
}

async function reviewRecords(): Promise<unknown> {
  return readReviewRecords(config.reviewsDir, { repo: REPO, pr: 7 });
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-srvfail-"));
  remote = join(root, "remote.git");
  config = {
    ...defaultConfig(),
    socketPath: join(root, "run", "broker.sock"),
    reposRoot: join(root, "bare"),
    reviewsDir: join(root, "reviews"),
    legacyReviewsFile: join(root, "reviews.json"),
    pushesDir: join(root, "pushes"),
    protectedDir: join(root, "protected"),
    ghPath: join(root, "gh"),
    gitPath: join(root, "git"),
    github: fakeTokens(),
    home: join(root, "home"),
    tempRoot: join(root, "tmp"),
  };
  await mkdir(config.home);
  await writeHome("repo.json", '{"defaultBranchRef":{"name":"main"}}\n');
  await writeFile(config.ghPath, FAKE_GH, { mode: 0o755 });
  await writeFile(config.gitPath, fakeGit(remote), { mode: 0o755 });
  execFileSync(REAL_GIT, ["init", "--bare", "--quiet", remote], { env: GIT_ENV });
  work = join(root, "work");
  execFileSync(REAL_GIT, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
  await commit("main", "base.txt");
  git(work, "push", "--quiet", remote, "main:main");
});

afterEach(async () => {
  await chmod(join(config.pushesDir, REPO), 0o700).catch(() => {});
  await chmod(join(config.reviewsDir, REPO), 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

// --- the files that every request reads ---

// --- the connection: one JSON line in, one JSON reply out ---

type Served = { path: string; server: Server; inputs: unknown[] };

// The socket sits in /tmp, not in macOS's long $TMPDIR, as in flow.test.ts; an agent sandbox,
// which cannot listen there, sets XDG_STATE_HOME.
async function serve(handle: (input: unknown) => Promise<Reply>): Promise<Served> {
  const path = join(await tempDir(join(process.env.XDG_STATE_HOME ?? "/tmp", "u")), "s.sock");
  const inputs: unknown[] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) =>
    serveConnection(socket, (input) => {
      inputs.push(input);
      return handle(input);
    }),
  );
  const listening = Promise.withResolvers<void>();
  server.listen(path, () => listening.resolve());
  await listening.promise;
  return { path, server, inputs };
}

async function close(served: Served): Promise<void> {
  const closed = Promise.withResolvers<void>();
  served.server.close(() => closed.resolve());
  await closed.promise;
  await rm(dirname(served.path), { recursive: true, force: true });
}

// Sends a request and reads the reply. A broker that never answers counts as no reply after 15 s.
function exchange(path: string, send: (socket: Socket) => void | Promise<void>): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const socket = connect(path);
  const deadline = setTimeout(() => socket.destroy(), 15_000);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("error", () => {});
  socket.on("close", () => {
    clearTimeout(deadline);
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      resolve(JSON.parse(text));
    } catch {
      reject(new Error(`no JSON reply: ${JSON.stringify(text.slice(0, 200))}`));
    }
  });
  socket.on("connect", () => void send(socket));
  return promise;
}

const HANDLED: Reply = { exit: 0, stdout: "handled\n", stderr: "" };

test("a request line that is not JSON is refused and reaches no handler", { timeout: 20_000 }, async () => {
  const served = await serve(() => Promise.resolve(HANDLED));
  try {
    const reply = await exchange(served.path, (socket) => socket.end('{"verb":"sync",\n'));
    assertRefused(reply, "request is not valid JSON");
    assert.deepEqual(served.inputs, []);
  } finally {
    await close(served);
  }
});

test("a connection that sends nothing gets an empty-request refusal and reaches no handler", { timeout: 20_000 }, async () => {
  const served = await serve(() => Promise.resolve(HANDLED));
  try {
    const reply = await exchange(served.path, (socket) => socket.end());
    assertRefused(reply, "empty request");
    assert.deepEqual(served.inputs, []);
  } finally {
    await close(served);
  }
});

test("a request ended by EOF with no newline is still handled", { timeout: 20_000 }, async () => {
  const served = await serve(() => Promise.resolve(HANDLED));
  try {
    const reply = await exchange(served.path, (socket) => socket.end('{"verb":"sync","repo":"o/r"}'));
    assert.deepEqual(reply, HANDLED);
    assert.deepEqual(served.inputs, [{ verb: "sync", repo: "o/r" }]);
  } finally {
    await close(served);
  }
});

test("a handler that throws gives exit 1 with an internal error, and the token in its message is redacted", { timeout: 20_000 }, async () => {
  const served = await serve(() => Promise.reject(new Error(`git failed at ${tokenRemote(REPO)}`)));
  try {
    const reply = await exchange(served.path, (socket) => socket.end('{"verb":"sync","repo":"o/r"}\n'));
    assert.ok(!("refused" in reply), JSON.stringify(reply));
    assert.equal(reply.exit, 1, JSON.stringify(reply));
    assert.ok(reply.stderr.includes("internal error"), JSON.stringify(reply));
    assert.ok(!reply.stderr.includes(FAKE_TOKEN), JSON.stringify(reply));
  } finally {
    await close(served);
  }
});

test("a request one byte over the limit is refused before it reaches a handler", { timeout: 120_000 }, async () => {
  const served = await serve(() => Promise.resolve(HANDLED));
  try {
    // A valid JSON request of exactly MAX_REQUEST_BYTES + 1 bytes, so the byte over the limit is the last one sent.
    const head = '{"verb":"sync","repo":"o/r","pad":"';
    const tail = '"}';
    const block = Buffer.alloc(1024 * 1024, 0x78);
    const reply = await exchange(served.path, async (socket) => {
      socket.write(head);
      for (let left = MAX_REQUEST_BYTES + 1 - head.length - tail.length; left > 0 && !socket.destroyed; left -= block.length) {
        const written = Promise.withResolvers<void>();
        socket.write(block.subarray(0, Math.min(left, block.length)), () => written.resolve());
        await written.promise;
      }
      if (!socket.destroyed) socket.end(tail);
    });
    assertRefused(reply, "request too large");
    assert.deepEqual(served.inputs, []);
  } finally {
    await close(served);
  }
});

// --- the default branch and the broker's bare repo ---

test("sync with an unreadable default branch fails and fetches nothing; a readable one syncs", async () => {
  for (const answer of UNREADABLE_DEFAULT_BRANCHES) {
    await writeHome("repo.json", answer);
    const reply = await request({ verb: "sync" });
    assertCannotReadDefaultBranch(reply);
    assert.ok(!("bundle_b64" in reply), answer);
  }
  assert.equal(await readHome("git-calls"), "");

  await writeHome("repo.json", '{"defaultBranchRef":{"name":"main"}}');
  const ok = await request({ verb: "sync" });
  assert.equal(ok.exit, 0, JSON.stringify(ok));
  assert.ok("branch" in ok && ok.branch === "main", JSON.stringify(ok));
});

test("push with an unreadable default branch pushes nothing and writes no push record", async () => {
  const head = await commit(BRANCH, "a.txt");
  for (const answer of UNREADABLE_DEFAULT_BRANCHES) {
    await writeHome("repo.json", answer);
    assertCannotReadDefaultBranch(await push(BRANCH, head));
    assert.equal(remoteRef(BRANCH), "", answer);
    assert.deepEqual(await pushRecord(), { kind: "none" }, answer);
  }
});

test("pr-create with an unreadable default branch opens no PR", async () => {
  for (const answer of UNREADABLE_DEFAULT_BRANCHES) {
    await writeHome("repo.json", answer);
    assertCannotReadDefaultBranch(await request({ verb: "pr-create", head: BRANCH, title: "t", body: "" }));
    assert.equal(await readHome("created"), "", answer);
  }
});

test("merge with an unreadable default branch merges nothing", async () => {
  const head = await pushedHead();
  await prView(head);
  for (const answer of UNREADABLE_DEFAULT_BRANCHES) {
    await writeHome("repo.json", answer);
    assertCannotReadDefaultBranch(await merge());
    assert.equal(await readHome("merged"), "", answer);
    assert.equal(remoteRef(BRANCH), head, answer);
  }
});

test("sync and push fail with git's error when the broker cannot create its bare repo, and push lands nothing", async () => {
  await failGit("init --bare");
  const synced = await request({ verb: "sync" });
  assertForwarded(synced, 3, "fake git: cannot init --bare");
  assert.ok(!("bundle_b64" in synced), JSON.stringify(synced));

  const head = await commit(BRANCH, "a.txt");
  assertForwarded(await push(BRANCH, head), 3, "fake git: cannot init --bare");
  assert.equal(remoteRef(BRANCH), "");
  assert.deepEqual(await pushRecord(), { kind: "none" });
});

// --- sync ---

test("sync whose bundle cannot be made fails with git's error and returns no bundle", async () => {
  await failGit("bundle create");
  const reply = await request({ verb: "sync" });
  assertForwarded(reply, 3, "fake git: cannot bundle create");
  assert.ok(!("bundle_b64" in reply), JSON.stringify(reply));
});

test("sync --pr refuses a PR whose head commit it cannot read, and fetches nothing", async () => {
  await writeHome("pr.json", JSON.stringify({ headRefOid: "nope" }));
  assertRefused(await request({ verb: "sync", pr: 7 }, REVIEWER), "cannot read pull request head commit");
  assert.equal(await readHome("git-calls"), "");
});

test("sync --pr whose fetch from GitHub fails gives git's error and leaves no temp ref", async () => {
  const head = await commit(BRANCH, "a.txt");
  git(work, "push", "--quiet", remote, `${BRANCH}:refs/pull/7/head`);
  await writeHome("pr.json", JSON.stringify({ headRefOid: head }));
  await failGit("refs/pull/7/head");

  const reply = await request({ verb: "sync", pr: 7 }, REVIEWER);
  assertForwarded(reply, 3, "fake git: cannot refs/pull/7/head");
  assert.ok(!("bundle_b64" in reply), JSON.stringify(reply));
  assert.equal(brokerTempRefs(), "");
});

test("sync --pr whose bundle cannot be made gives git's error and leaves no temp ref", async () => {
  const head = await commit(BRANCH, "a.txt");
  git(work, "push", "--quiet", remote, `${BRANCH}:refs/pull/7/head`);
  await writeHome("pr.json", JSON.stringify({ headRefOid: head }));
  await failGit("bundle create");

  const reply = await request({ verb: "sync", pr: 7 }, REVIEWER);
  assertForwarded(reply, 3, "fake git: cannot bundle create");
  assert.ok(!("bundle_b64" in reply), JSON.stringify(reply));
  assert.equal(brokerTempRefs(), "");
});

// --- push ---

test("a push whose bundle lacks the branch fails with git's error, lands nothing, and leaves no temp ref", async () => {
  const other = await commit("agent/y", "a.txt");
  const reply = await push(BRANCH, other, "agent/y");
  assert.ok(!("refused" in reply), JSON.stringify(reply));
  assert.notEqual(reply.exit, 0, JSON.stringify(reply));
  assert.equal(remoteRef(BRANCH), "");
  assert.deepEqual(await pushRecord(), { kind: "none" });
  assert.equal(brokerTempRefs(), "");
});

test("a push that GitHub rejects gives the error and keeps the push record at the last pushed commit", async () => {
  const first = await commit(BRANCH, "a.txt");
  const one = await push(BRANCH, first);
  assert.equal(one.exit, 0, JSON.stringify(one));
  assert.deepEqual(await pushRecord(), { kind: "pushed", sha: first });

  const second = await commit(BRANCH, "b.txt");
  await rm(remote, { recursive: true, force: true });
  const two = await push(BRANCH, second);
  assert.ok(!("refused" in two), JSON.stringify(two));
  assert.notEqual(two.exit, 0, JSON.stringify(two));
  assert.deepEqual(await pushRecord(), { kind: "pushed", sha: first });
});

test("a push replaces a branch that the new commit does not descend from, and records the new commit", async () => {
  const first = await commit(BRANCH, "a.txt");
  assert.equal((await push(BRANCH, first)).exit, 0);
  git(work, "reset", "--quiet", "--hard", "main");
  const rewritten = await commit(BRANCH, "b.txt");

  const reply = await push(BRANCH, rewritten);
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.equal(remoteRef(BRANCH), rewritten);
  assert.deepEqual(await pushRecord(), { kind: "pushed", sha: rewritten });
});

test("a push leaves no temp ref in the broker's bare repo, whether it lands or is refused", async () => {
  const head = await commit(BRANCH, "a.txt");
  assert.equal((await push(BRANCH, head)).exit, 0);
  assert.equal(brokerTempRefs(), "");

  const next = await commit(BRANCH, "b.txt");
  assertRefused(await push(BRANCH, head, BRANCH), "bundle ref does not match sha");
  assert.equal(remoteRef(BRANCH), head);
  assert.notEqual(next, head);
  assert.equal(brokerTempRefs(), "");
});

// --- pr-create ---

test("pr-create opens the PR against the default branch that GitHub names", async () => {
  await writeHome("repo.json", '{"defaultBranchRef":{"name":"trunk"}}');
  const reply = await request({ verb: "pr-create", head: BRANCH, title: "t", body: "" });
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.ok((await readHome("created")).split(" ").includes("--base=trunk"), await readHome("created"));
});

test("pr-create that gh fails gives gh's exit code and error", async () => {
  await failGh("pr create");
  assertForwarded(await request({ verb: "pr-create", head: BRANCH, title: "t", body: "" }), 4, "HTTP 502");
  assert.equal(await readHome("created"), "");
});

// --- the PR view that pr-status, ci-log, review, merge and sync --pr read ---

const PR_VERBS: { name: string; input: Record<string, unknown>; session: Session }[] = [
  { name: "sync --pr", input: { verb: "sync", pr: 7 }, session: REVIEWER },
  { name: "pr-status", input: { verb: "pr-status", number: 7 }, session: AUTHOR },
  { name: "ci-log", input: { verb: "ci-log", number: 7 }, session: AUTHOR },
  { name: "review", input: { verb: "review", number: 7, sha: CI_HEAD, verdict: "pass", reason: "" }, session: REVIEWER },
  { name: "merge", input: { verb: "merge", number: 7 }, session: AUTHOR },
];

for (const verb of PR_VERBS) {
  test(`${verb.name}: a failing gh pr view gives gh's exit code and error, and nothing else happens`, async () => {
    const head = await pushedHead();
    await prView(head);
    const recordsBefore = await reviewRecords();
    await failGh("pr view");

    const reply = await request(verb.input, verb.session);
    assertForwarded(reply, 4, "HTTP 502");
    assert.equal(reply.stdout, "");
    assert.deepEqual(await apiCalls(), []);
    assert.equal(await readHome("merged"), "");
    assert.equal(await readHome("git-calls"), "");
    assert.deepEqual(await reviewRecords(), recordsBefore);
  });

  test(`${verb.name}: a PR view that is not a JSON object is refused, and nothing else happens`, async () => {
    const head = await pushedHead();
    await prView(head);
    const recordsBefore = await reviewRecords();
    for (const answer of ["not json", "[1]", "null"]) {
      await writeHome("pr.json", answer);
      assert.deepEqual(await request(verb.input, verb.session), { exit: 2, refused: "cannot read pull request" }, answer);
    }
    assert.deepEqual(await apiCalls(), []);
    assert.equal(await readHome("merged"), "");
    assert.equal(await readHome("git-calls"), "");
    assert.deepEqual(await reviewRecords(), recordsBefore);
  });
}

// --- ci-log ---

test("ci-log refuses a PR head from another repo or off agent/*, and reads no run", async () => {
  for (const pr of [{ isCrossRepository: true }, { headRefName: "feature/x" }]) {
    await ciGithub(pr);
    assertRefused(await ciLog(), "pull request head");
  }
  assert.deepEqual(await apiCalls(), []);
});

test("ci-log refuses a PR whose head commit it cannot read, and reads no run", async () => {
  await ciGithub({ headRefOid: "nope" });
  assertRefused(await ciLog(), "cannot read pull request head commit");
  assert.deepEqual(await apiCalls(), []);
});

test("ci-log whose deployments call fails gives gh's error and shows no log", async () => {
  await ciGithub();
  await failGh("/deployments?");
  assertForwarded(await ciLog(), 4, "HTTP 502");
  assert.equal(await readHome("viewed"), "");
});

test("ci-log whose deployments answer is unreadable refuses and shows no log", async () => {
  await ciGithub();
  for (const answer of ["not json", "{}"]) {
    await writeHome("deployments.json", answer);
    assertRefused(await ciLog(), "deployments");
  }
  assert.equal(await readHome("viewed"), "");
});

test("ci-log whose runs call fails gives gh's error and shows no log", async () => {
  await ciGithub();
  await failGh("/actions/runs?");
  assertForwarded(await ciLog(), 4, "HTTP 502");
  assert.equal(await readHome("viewed"), "");
});

test("ci-log whose runs answer is not JSON refuses and shows no log", async () => {
  await ciGithub();
  await writeHome("runs.json", "not json");
  assertRefused(await ciLog(), "cannot read the workflow runs");
  assert.equal(await readHome("viewed"), "");
});

test("ci-log whose runs answer holds a malformed run refuses and shows no log", async () => {
  await ciGithub();
  await writeHome("runs.json", JSON.stringify([{ workflow_runs: [run(11), { id: "x" }] }]));
  const reply = await ciLog();
  assert.equal(reply.exit, 2, JSON.stringify(reply));
  assert.ok("refused" in reply, JSON.stringify(reply));
  assert.equal(await readHome("viewed"), "");
});

test("ci-log whose log call fails gives gh's error, not a partial log", async () => {
  await ciGithub();
  await failGh("run view 12");
  const reply = await ciLog();
  assertForwarded(reply, 4, "HTTP 502");
  assert.ok(!reply.stdout.includes("first failure"), JSON.stringify(reply));
});

test("ci-log redacts a GitHub token that appears in a CI log", async () => {
  await ciGithub();
  await writeHome("log-11.txt", `ci\tlint\tremote: ${tokenRemote(REPO)}\n`);
  const reply = await ciLog();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.ok("stdout" in reply && reply.stdout.includes("ci\tlint\tremote: https://x-access-token:"), JSON.stringify(reply));
  assert.ok(!reply.stdout.includes(FAKE_TOKEN), "the token reached the author");
  assert.ok(reply.stdout.includes("second failure"), JSON.stringify(reply));
});

// --- review ---

test("review refuses a head that is not the PR head, from another repo, off agent/*, or unreadable, and writes no record", async () => {
  const head = await pushedHead();
  const before = await reviewRecords();
  const other = "b".repeat(40);
  const cases: [Record<string, unknown>, string, string][] = [
    [{}, other, `not the reviewed ${other}`],
    [{ isCrossRepository: true }, head, "pull request head is not in the same repo"],
    [{ headRefName: "feature/x" }, head, "pull request head is not an agent branch"],
    [{ headRefOid: "nope" }, head, "cannot read pull request head commit"],
  ];
  for (const [pr, sha, reason] of cases) {
    await prView(head, pr);
    assertRefused(await review(sha), reason);
  }
  assert.deepEqual(await reviewRecords(), before);

  await prView(head);
  const ok = await review(head);
  assert.equal(ok.exit, 0, JSON.stringify(ok));
  const after = await reviewRecords();
  assert.ok(isRecordsOf(after) && isRecordsOf(before) && after.records.length === before.records.length + 1, JSON.stringify(after));
});

function isRecordsOf(value: unknown): value is { kind: "records"; records: unknown[] } {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "records" && "records" in value && Array.isArray(value.records);
}

test("review whose record cannot be written is refused and leaves no record", async () => {
  const head = await commit(BRANCH, "a.txt");
  await prView(head);
  await mkdir(join(config.reviewsDir, REPO), { recursive: true });
  await chmod(join(config.reviewsDir, REPO), 0o500);

  assertRefused(await review(head), "cannot write the review record");
  await chmod(join(config.reviewsDir, REPO), 0o700);
  assert.deepEqual(await reviewRecords(), { kind: "records", records: [] });
});

// --- merge ---

test("merge refuses a PR whose base is not the default branch, and merges it once the base is", async () => {
  const head = await pushedHead();
  await prView(head, { baseRefName: "release" });
  assertRefused(await merge(), "base is not the default branch");
  assert.equal(await readHome("merged"), "");

  await prView(head);
  const ok = await merge();
  assert.equal(ok.exit, 0, JSON.stringify(ok));
  assert.equal(await readHome("merged"), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
});

test("merge refuses a PR whose head commit it cannot read", async () => {
  const head = await pushedHead();
  await prView(head, { headRefOid: "nope" });
  assertRefused(await merge(), "cannot read pull request head commit");
  assert.equal(await readHome("merged"), "");
  assert.equal(remoteRef(BRANCH), head);
});

test("merge refuses when the protected paths list cannot be read, and merges once it can", async () => {
  const head = await pushedHead();
  await prView(head);
  await mkdir(join(config.protectedDir, REPO), { recursive: true });
  assertRefused(await merge(), "cannot read the protected paths list");
  assert.equal(await readHome("merged"), "");
  assert.equal(remoteRef(BRANCH), head);

  await rm(join(config.protectedDir, REPO), { recursive: true });
  const ok = await merge();
  assert.equal(ok.exit, 0, JSON.stringify(ok));
  assert.equal(await readHome("merged"), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
});

test("merge refuses when the changed files call fails", async () => {
  const head = await pushedHead();
  await prView(head);
  await failGh("/pulls/7/files");
  assertRefused(await merge(), "changed files cannot be read");
  assert.equal(await readHome("merged"), "");
});

test("merge refuses when GitHub lists fewer changed files than the PR has", async () => {
  const head = await pushedHead();
  await prView(head, { changedFiles: 2 });
  assertRefused(await merge(), "changed files cannot be read");
  assert.equal(await readHome("merged"), "");
});

test("merge refuses when a changed file entry has no file name", async () => {
  const head = await pushedHead();
  for (const item of [{ name: "a.txt" }, { filename: 5 }, "a.txt", null]) {
    await prView(head, {}, [item]);
    assertRefused(await merge(), "changed files cannot be read");
  }
  assert.equal(await readHome("merged"), "");
});

test("merge holds a PR that renames a protected path away, and merges the same rename of an ordinary path", async () => {
  const head = await pushedHead();
  await prView(head, {}, [{ filename: "docs/ci.yml", previous_filename: ".github/workflows/ci.yml" }]);
  assertRefused(await merge(), "protected path .github/workflows/ci.yml changed");
  assert.equal(await readHome("merged"), "");

  await prView(head, {}, [{ filename: "docs/ci.yml", previous_filename: "docs/old.yml" }]);
  const ok = await merge();
  assert.equal(ok.exit, 0, JSON.stringify(ok));
});

// --- branch cleanup after a merge ---

test("a merge whose branch delete fails while the branch is still at the head exits 1, keeps the branch, and names the merge", async () => {
  const head = await pushedHead();
  await prView(head);
  await failGit("--force-with-lease");

  const reply = await merge();
  assert.equal(reply.exit, 1, JSON.stringify(reply));
  assert.ok("stderr" in reply && reply.stderr.includes(`merged, but cannot delete branch ${BRANCH}`), JSON.stringify(reply));
  assert.ok(isMergeReply(reply) && reply.merged.head === head, JSON.stringify(reply));
  assert.equal(await readHome("merged"), `pr merge 7 --repo ${REPO} --merge --match-head-commit ${head}\n`);
  assert.equal(remoteRef(BRANCH), head);
});

test("a merge whose bare repo cannot be created exits 1 with git's error and keeps the branch", async () => {
  const head = await pushedHead();
  await prView(head);
  await failGit("init --bare");

  const reply = await merge();
  assert.equal(reply.exit, 1, JSON.stringify(reply));
  assert.ok("stderr" in reply && reply.stderr.includes(`merged, but cannot delete branch ${BRANCH}: fake git: cannot init --bare`), JSON.stringify(reply));
  assert.ok(isMergeReply(reply) && reply.merged.head === head, JSON.stringify(reply));
  assert.equal(remoteRef(BRANCH), head);
});

test("a merge whose push record cannot be dropped exits 1 and says so, after it deleted the branch", async () => {
  const head = await pushedHead();
  await prView(head);
  await chmod(join(config.pushesDir, REPO), 0o500);

  const reply = await merge();
  await chmod(join(config.pushesDir, REPO), 0o700);
  assert.equal(reply.exit, 1, JSON.stringify(reply));
  assert.ok("stderr" in reply && reply.stderr.includes(`merged, but cannot drop the push record of ${BRANCH}`), JSON.stringify(reply));
  assert.ok(isMergeReply(reply) && reply.merged.head === head, JSON.stringify(reply));
  assert.equal(remoteRef(BRANCH), "");
});
