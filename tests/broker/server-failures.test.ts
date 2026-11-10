import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { MAX_REQUEST_BYTES } from "../../host/gh-broker/protocol.ts";
import type { PushRecord, Reply } from "../../host/gh-broker/protocol.ts";
import { readPushRecord } from "../../host/gh-broker/push-record.ts";
import { refreshRepos, serveConnection } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import { FAKE_TOKEN, githubRemote, tokenRemote } from "./fake-app.ts";
import { BRANCH, REAL_GIT, REPO, brokerConfig, bundleOf, commit, git, initRepo, remoteRef, request, seedMain } from "./fixture.ts";
import { tempDir } from "../temp.ts";

const CI_HEAD = "a".repeat(40);
const UNREADABLE_DEFAULT_BRANCHES = [
  '{"defaultBranchRef":{"name":"-main"}}',
  '{"defaultBranchRef":{"name":"a..b"}}',
  '{"defaultBranchRef":null}',
  "not json",
];
const UNREADABLE_REMOTE_HEADS = [
  `ref: refs/heads/-main\tHEAD\n${"a".repeat(40)}\tHEAD\n`,
  `ref: refs/heads/a..b\tHEAD\n${"a".repeat(40)}\tHEAD\n`,
  `${"a".repeat(40)}\tHEAD\n`,
  "ref: refs/heads/main\tHEAD\nnope\tHEAD\n",
  "",
];

const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/gh-calls"
if [ -f "$HOME/gh-fail" ]; then
  case "$*" in *"$(cat "$HOME/gh-fail")"*) echo "fake gh: HTTP 502 on $1 $2" >&2; exit 4 ;; esac
fi
case "$1 $2" in
"repo view") cat "$HOME/repo.json" ;;
"pr view") cat "$HOME/pr.json" ;;
"pr create") printf '%s\\n' "$*" > "$HOME/created"; cat > "$HOME/created-body"; echo "https://github.com/${REPO}/pull/7" ;;
"run view") printf '%s\\n' "$*" >> "$HOME/viewed"; cat "$HOME/log-$3.txt" ;;
"api --paginate")
  case "$4" in
  "repos/${REPO}/deployments?"*) cat "$HOME/deployments.json" ;;
  "repos/${REPO}/actions/runs?"*) cat "$HOME/runs.json" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
  esac ;;
*) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;

function fakeGit(remote: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/git-calls"
if [ -f "$HOME/git-fail" ]; then
  case "$*" in *"$(cat "$HOME/git-fail")"*) echo "fake git: cannot $(cat "$HOME/git-fail")" >&2; exit 3 ;; esac
fi
if [ -f "$HOME/ls-remote" ]; then
  case "$*" in *" ls-remote "*) cat "$HOME/ls-remote"; exit 0 ;; esac
fi
if [ -f "$HOME/ls-remote-hangs" ]; then
  case "$*" in *" ls-remote "*) exec sleep 60 ;; esac
fi
exec '${REAL_GIT}' -c 'url.file://${remote}.insteadOf=${githubRemote(REPO)}' "$@"
`;
}

let root: string;
let config: ServerConfig;
let work: string;
let remote: string;

function push(branch: string, sha: string, bundleBranch: string = branch): Promise<Reply> {
  return request(config, { verb: "push", branch, sha, bundle_b64: bundleOf(work, bundleBranch) });
}

function brokerTempRefs(): string {
  return git(join(config.reposRoot, `${REPO}.git`), "for-each-ref", "--format=%(refname)", "refs/gh-broker/");
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

async function prView(head: string, pr: Record<string, unknown> = {}): Promise<void> {
  const view = {
    headRefName: BRANCH,
    baseRefName: "main",
    isCrossRepository: false,
    headRefOid: head,
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    ...pr,
  };
  await writeHome("pr.json", JSON.stringify(view));
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
  return request(config, { verb: "ci-log", number: 7 });
}

async function apiCalls(): Promise<string[]> {
  return (await readHome("gh-calls")).split("\n").filter((line) => line.startsWith("api ") || line.startsWith("run "));
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-srvfail-"));
  config = await brokerConfig(root, FAKE_GH);
  remote = initRepo(join(root, "remote.git"), true);
  config.gitPath = join(root, "git");
  await writeHome("repo.json", '{"defaultBranchRef":{"name":"main"}}\n');
  await writeFile(config.gitPath, fakeGit(remote), { mode: 0o755 });
  work = initRepo(join(root, "work"));
  await seedMain(work, remote);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Served = { path: string; server: Server; inputs: unknown[] };

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

test("sync with an unreadable default branch from GitHub fails and fetches nothing; a readable one syncs", async () => {
  for (const answer of UNREADABLE_REMOTE_HEADS) {
    await writeHome("ls-remote", answer);
    const reply = await request(config, { verb: "sync" });
    assertCannotReadDefaultBranch(reply);
    assert.ok(!("bundle_b64" in reply), answer);
  }
  assert.doesNotMatch(await readHome("git-calls"), / fetch /);

  await rm(join(config.home, "ls-remote"));
  const ok = await request(config, { verb: "sync" });
  assert.equal(ok.exit, 0, JSON.stringify(ok));
  assert.ok("branch" in ok && ok.branch === "main", JSON.stringify(ok));
});

test("a check whose GitHub call hangs stops at its deadline, and a later sync of the repo still answers", async () => {
  config.checkTimeoutMs = 500;
  const signal = new AbortController().signal;
  assert.equal((await request(config, { verb: "sync" })).exit, 0);
  await writeHome("ls-remote-hangs", "");
  const started = Date.now();
  await refreshRepos(config, signal);
  const hung = await request(config, { verb: "sync" });
  assert.notEqual(hung.exit, 0, JSON.stringify(hung));
  assert.ok(Date.now() - started < 10_000, "neither the refresh nor the sync waits for the hung call");
  await rm(join(config.home, "ls-remote-hangs"));
  const ok = await request(config, { verb: "sync" });
  assert.equal(ok.exit, 0, JSON.stringify(ok));
});

test("each refresh tick writes its time and the repos that failed, also when no repo is due, and never throws", async () => {
  const signal = new AbortController().signal;
  const status = () => readFile(config.statusFile, "utf8");
  await refreshRepos(config, signal);
  assert.match(await status(), /^at=\d+\nfailed=\n$/);
  assert.equal((await request(config, { verb: "sync" })).exit, 0);
  await refreshRepos(config, signal);
  assert.match(await status(), /^at=\d+\nfailed=\n$/);
  await writeFile(join(root, "not-a-dir"), "");
  config.reposRoot = join(root, "not-a-dir", "bare");
  await refreshRepos(config, signal);
  assert.match(await status(), new RegExp(`^at=\\d+\\nfailed=${REPO}\\n$`));
  config.statusFile = join(root, "not-a-dir", "status");
  await refreshRepos(config, signal);
});

test("push with an unreadable default branch pushes nothing and writes no push record", async () => {
  const head = await commit(work, "a.txt", BRANCH);
  for (const answer of UNREADABLE_DEFAULT_BRANCHES) {
    await writeHome("repo.json", answer);
    assertCannotReadDefaultBranch(await push(BRANCH, head));
    assert.equal(remoteRef(remote, BRANCH), "", answer);
    assert.deepEqual(await pushRecord(), { kind: "none" }, answer);
  }
});

test("pr-create with an unreadable default branch opens no PR", async () => {
  for (const answer of UNREADABLE_DEFAULT_BRANCHES) {
    await writeHome("repo.json", answer);
    assertCannotReadDefaultBranch(await request(config, { verb: "pr-create", head: BRANCH, title: "t", body: "" }));
    assert.equal(await readHome("created"), "", answer);
  }
});

test("sync and push fail with git's error when the gh-broker cannot create its bare repo, and push lands nothing", async () => {
  await failGit("init --bare");
  const synced = await request(config, { verb: "sync" });
  assertForwarded(synced, 3, "fake git: cannot init --bare");
  assert.ok(!("bundle_b64" in synced), JSON.stringify(synced));

  const head = await commit(work, "a.txt", BRANCH);
  assertForwarded(await push(BRANCH, head), 3, "fake git: cannot init --bare");
  assert.equal(remoteRef(remote, BRANCH), "");
  assert.deepEqual(await pushRecord(), { kind: "none" });
});

test("sync whose bundle cannot be made fails with git's error and returns no bundle", async () => {
  await failGit("bundle create");
  const reply = await request(config, { verb: "sync" });
  assertForwarded(reply, 3, "fake git: cannot bundle create");
  assert.ok(!("bundle_b64" in reply), JSON.stringify(reply));
});

test("sync --pr refuses a PR whose head commit it cannot read, and fetches nothing", async () => {
  await writeHome("pr.json", JSON.stringify({ headRefOid: "nope" }));
  assertRefused(await request(config, { verb: "sync", pr: 7 }), "cannot read pull request head commit");
  assert.equal(await readHome("git-calls"), "");
});

test("sync --pr whose fetch from GitHub fails gives git's error and leaves no temp ref", async () => {
  const head = await commit(work, "a.txt", BRANCH);
  git(work, "push", "--quiet", remote, `${BRANCH}:refs/pull/7/head`);
  await writeHome("pr.json", JSON.stringify({ headRefOid: head }));
  await failGit("refs/pull/7/head");

  const reply = await request(config, { verb: "sync", pr: 7 });
  assertForwarded(reply, 3, "fake git: cannot refs/pull/7/head");
  assert.ok(!("bundle_b64" in reply), JSON.stringify(reply));
  assert.equal(brokerTempRefs(), "");
});

test("sync --pr whose bundle cannot be made gives git's error and leaves no temp ref", async () => {
  const head = await commit(work, "a.txt", BRANCH);
  git(work, "push", "--quiet", remote, `${BRANCH}:refs/pull/7/head`);
  await writeHome("pr.json", JSON.stringify({ headRefOid: head }));
  await failGit("bundle create");

  const reply = await request(config, { verb: "sync", pr: 7 });
  assertForwarded(reply, 3, "fake git: cannot bundle create");
  assert.ok(!("bundle_b64" in reply), JSON.stringify(reply));
  assert.equal(brokerTempRefs(), "");
});

test("a push whose bundle lacks the branch fails with git's error, lands nothing, and leaves no temp ref", async () => {
  const other = await commit(work, "a.txt", "agent/y");
  const reply = await push(BRANCH, other, "agent/y");
  assert.ok(!("refused" in reply), JSON.stringify(reply));
  assert.notEqual(reply.exit, 0, JSON.stringify(reply));
  assert.equal(remoteRef(remote, BRANCH), "");
  assert.deepEqual(await pushRecord(), { kind: "none" });
  assert.equal(brokerTempRefs(), "");
});

test("a push that GitHub rejects gives the error and keeps the push record at the last pushed commit", async () => {
  const first = await commit(work, "a.txt", BRANCH);
  const one = await push(BRANCH, first);
  assert.equal(one.exit, 0, JSON.stringify(one));
  assert.deepEqual(await pushRecord(), { kind: "pushed", sha: first });

  const second = await commit(work, "b.txt", BRANCH);
  await rm(remote, { recursive: true, force: true });
  const two = await push(BRANCH, second);
  assert.ok(!("refused" in two), JSON.stringify(two));
  assert.notEqual(two.exit, 0, JSON.stringify(two));
  assert.deepEqual(await pushRecord(), { kind: "pushed", sha: first });
});

test("a push replaces a branch that the new commit does not descend from, and records the new commit", async () => {
  const first = await commit(work, "a.txt", BRANCH);
  assert.equal((await push(BRANCH, first)).exit, 0);
  git(work, "reset", "--quiet", "--hard", "main");
  const rewritten = await commit(work, "b.txt", BRANCH);

  const reply = await push(BRANCH, rewritten);
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.equal(remoteRef(remote, BRANCH), rewritten);
  assert.deepEqual(await pushRecord(), { kind: "pushed", sha: rewritten });
});

test("a push leaves no temp ref in the gh-gh-broker's bare repo, whether it lands or is refused", async () => {
  const head = await commit(work, "a.txt", BRANCH);
  assert.equal((await push(BRANCH, head)).exit, 0);
  assert.equal(brokerTempRefs(), "");

  const next = await commit(work, "b.txt", BRANCH);
  assertRefused(await push(BRANCH, head, BRANCH), "bundle ref does not match sha");
  assert.equal(remoteRef(remote, BRANCH), head);
  assert.notEqual(next, head);
  assert.equal(brokerTempRefs(), "");
});

async function mergedOnGithub(): Promise<string> {
  const head = await commit(work, "a.txt", BRANCH);
  assert.equal((await push(BRANCH, head)).exit, 0);
  git(remote, "update-ref", "refs/heads/main", head);
  return head;
}

test("a refresh whose branch delete fails keeps the branch and its record, and names the repo as failed", async () => {
  const head = await mergedOnGithub();
  await failGit("--force-with-lease");

  await refreshRepos(config, new AbortController().signal);
  assert.match(await readFile(config.statusFile, "utf8"), new RegExp(`\\nfailed=${REPO}\\n$`));
  assert.equal(remoteRef(remote, BRANCH), head);
  assert.deepEqual(await pushRecord(), { kind: "pushed", sha: head });
});

test("a refresh whose bare repo cannot be created keeps the branch and its record, and names the repo as failed", async () => {
  const head = await mergedOnGithub();
  await rm(join(config.reposRoot, `${REPO}.git`), { recursive: true, force: true });
  await failGit("init --bare");

  await refreshRepos(config, new AbortController().signal);
  assert.match(await readFile(config.statusFile, "utf8"), new RegExp(`\\nfailed=${REPO}\\n$`));
  assert.equal(remoteRef(remote, BRANCH), head);
  assert.deepEqual(await pushRecord(), { kind: "pushed", sha: head });
});

test("a refresh whose push record cannot be dropped deletes the branch, keeps the record, and names the repo as failed", async () => {
  const head = await mergedOnGithub();
  await chmod(join(config.pushesDir, REPO), 0o500);
  try {
    await refreshRepos(config, new AbortController().signal);
  } finally {
    await chmod(join(config.pushesDir, REPO), 0o700);
  }
  assert.match(await readFile(config.statusFile, "utf8"), new RegExp(`\\nfailed=${REPO}\\n$`));
  assert.equal(remoteRef(remote, BRANCH), "");
  assert.deepEqual(await pushRecord(), { kind: "pushed", sha: head });
});

test("pr-create opens the PR against the default branch that GitHub names", async () => {
  await writeHome("repo.json", '{"defaultBranchRef":{"name":"trunk"}}');
  const reply = await request(config, { verb: "pr-create", head: BRANCH, title: "t", body: "" });
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.ok((await readHome("created")).split(" ").includes("--base=trunk"), await readHome("created"));
});

test("pr-create that gh fails gives gh's exit code and error", async () => {
  await failGh("pr create");
  assertForwarded(await request(config, { verb: "pr-create", head: BRANCH, title: "t", body: "" }), 4, "HTTP 502");
  assert.equal(await readHome("created"), "");
});

const PR_VERBS: { name: string; input: Record<string, unknown> }[] = [
  { name: "sync --pr", input: { verb: "sync", pr: 7 } },
  { name: "pr-status", input: { verb: "pr-status", number: 7 } },
  { name: "ci-log", input: { verb: "ci-log", number: 7 } },
];

for (const verb of PR_VERBS) {
  test(`${verb.name}: a failing gh pr view gives gh's exit code and error, and nothing else happens`, async () => {
    await prView(CI_HEAD);
    await failGh("pr view");

    const reply = await request(config, verb.input);
    assertForwarded(reply, 4, "HTTP 502");
    assert.equal(reply.stdout, "");
    assert.deepEqual(await apiCalls(), []);
    assert.equal(await readHome("git-calls"), "");
  });

  test(`${verb.name}: a PR view that is not a JSON object is refused, and nothing else happens`, async () => {
    await prView(CI_HEAD);
    for (const answer of ["not json", "[1]", "null"]) {
      await writeHome("pr.json", answer);
      assert.deepEqual(await request(config, verb.input), { exit: 2, refused: "cannot read pull request" }, answer);
    }
    assert.deepEqual(await apiCalls(), []);
    assert.equal(await readHome("git-calls"), "");
  });
}

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
