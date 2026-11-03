import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { send } from "../../host/broker/client.ts";
import { tempDir } from "../temp.ts";

// The broker client as a session runs it: `client.ts` on this node, with a fake broker on a unix
// socket that records each request and answers with a canned reply, and local git repos.

const REPO = "o/r";
const BRANCH = "agent/x";
const CLIENT = join(import.meta.dirname, "../../host/broker/client.ts");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const execFileAsync = promisify(execFile);

let root: string;
let work: string;
let socket: string;
let server: Server | undefined;
let requests: unknown[];

function git(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
}

function localBranch(): string {
  return git(work, "for-each-ref", "--format=%(objectname)", `refs/heads/${BRANCH}`);
}

// A fake broker: it records the request line of each connection and answers with `reply`, as is.
async function broker(reply: string): Promise<void> {
  server = createServer({ allowHalfOpen: true }, (conn) => {
    let text = "";
    conn.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (!text.includes("\n")) return;
      requests.push(JSON.parse(text.slice(0, text.indexOf("\n"))));
      conn.end(reply);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(socket, () => listening.resolve());
  await listening.promise;
}

type Run = { code: number; stdout: string; stderr: string };

async function client(cwd: string, env: Record<string, string>, ...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLIENT, ...args], {
      cwd,
      env: { ...GIT_ENV, UG_BROKER_SOCKET: socket, GIT_CEILING_DIRECTORIES: root, ...env },
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

function brokerAt(cwd: string, ...args: string[]): Promise<Run> {
  return client(cwd, {}, ...args);
}

async function commit(cwd: string, file: string): Promise<string> {
  await writeFile(join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

function mergedReply(head: string, exit = 0): string {
  return JSON.stringify({ exit, stdout: "merged\n", stderr: exit === 0 ? "" : "broker: merged, but cannot delete branch agent/x: gone\n", merged: { branch: BRANCH, head } });
}

beforeEach(async () => {
  root = await tempDir(join(process.env.XDG_STATE_HOME ?? tmpdir(), "ug-cl-"));
  socket = join(root, "b.sock");
  requests = [];
  work = join(root, "work");
  execFileSync(REAL_GIT, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
  await commit(work, "base.txt");
});

afterEach(async () => {
  if (server !== undefined) {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    server = undefined;
  }
  await rm(root, { recursive: true, force: true });
});

const SHA = "a".repeat(40);

const USAGE_CASES: { name: string; argv: string[]; reason: string }[] = [
  { name: "no verb", argv: [], reason: "missing verb" },
  { name: "an unknown verb", argv: ["frobnicate", REPO], reason: "unknown verb: frobnicate" },
  { name: "too few arguments", argv: ["merge", REPO], reason: "wrong number of arguments" },
  { name: "too many arguments", argv: ["merge", REPO, "7", "8"], reason: "wrong number of arguments" },
  { name: "a repo that is not owner/repo", argv: ["merge", "not-a-repo", "7"], reason: "invalid <owner/repo>" },
  { name: "a push of a branch outside agent/", argv: ["push", REPO, "main"], reason: "branch must match agent/<name>" },
  { name: "a pr-create from a branch outside agent/", argv: ["pr-create", REPO, "main", "t", "b"], reason: "branch must match agent/<name>" },
  { name: "a PR number that is not a positive integer", argv: ["pr-status", REPO, "0"], reason: "invalid PR number" },
  { name: "a PR number with letters", argv: ["merge", REPO, "7a"], reason: "invalid PR number" },
  { name: "a short sha", argv: ["review", REPO, "7", "abc1234", "code-review", "pass"], reason: "sha must be a full 40-hex commit sha" },
  { name: "an unknown role", argv: ["review", REPO, "7", SHA, "author", "pass"], reason: "role must be code-review, security-review, risk-review" },
  { name: "a review with no role", argv: ["review", REPO, "7", SHA, "pass"], reason: "wrong number of arguments" },
  { name: "an unknown verdict", argv: ["review", REPO, "7", SHA, "code-review", "approve"], reason: "verdict must be pass, manual or block" },
  { name: "a verdict that the role cannot give", argv: ["review", REPO, "7", SHA, "code-review", "manual", "why"], reason: "code-review cannot give manual: use pass or block" },
  { name: "a sync flag other than --pr", argv: ["sync", REPO, "--x", "7"], reason: "want sync <owner/repo> --pr <n>" },
  { name: "an empty PR title", argv: ["pr-create", REPO, BRANCH, "", "body"], reason: "invalid title" },
  { name: "a block without a reason", argv: ["review", REPO, "7", SHA, "security-review", "block"], reason: "invalid reason" },
];

for (const { name, argv, reason } of USAGE_CASES) {
  test(`usage error, ${name}: exit 64 with the reason and the usage, and nothing reaches the broker`, async () => {
    await broker(JSON.stringify({ exit: 0, stdout: "sent\n", stderr: "" }));

    const run = await brokerAt(work, ...argv);
    assert.equal(run.code, 64, JSON.stringify(run));
    assert.ok(run.stderr.startsWith(`broker: ${reason}`), run.stderr);
    assert.match(run.stderr, /\nusage:\n/);
    assert.equal(run.stdout, "");
    assert.deepEqual(requests, []);
  });
}

test("ci-log sends the repo and PR number to the broker and prints the log it returns", async () => {
  await broker(JSON.stringify({ exit: 0, stdout: "untrusted CI log\n", stderr: "" }));

  const run = await brokerAt(work, "ci-log", REPO, "7");
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(requests, [{ verb: "ci-log", repo: REPO, number: 7 }]);
  assert.equal(run.stdout, "untrusted CI log\n");
});

test("a push of a local branch that does not exist fails with exit 1, not a usage error, and sends nothing", async () => {
  await broker(JSON.stringify({ exit: 0, stdout: "pushed\n", stderr: "" }));

  const run = await brokerAt(work, "push", REPO, "agent/missing");
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.ok(run.stderr.startsWith("broker: "), run.stderr);
  assert.doesNotMatch(run.stderr, /usage:/);
  assert.deepEqual(requests, []);
});

test("a session without a broker socket exits 69 and says the socket is not set", async () => {
  const run = await client(work, { UG_BROKER_SOCKET: "" }, "pr-status", REPO, "7");
  assert.equal(run.code, 69, JSON.stringify(run));
  assert.match(run.stderr, /no broker socket \(UG_BROKER_SOCKET is not set/);
  assert.equal(run.stdout, "");
});

test("a broker that is down exits 69 and says it cannot reach the broker", async () => {
  await broker(JSON.stringify({ exit: 0, stdout: "", stderr: "" }));
  const closed = Promise.withResolvers<void>();
  server?.close(() => closed.resolve());
  await closed.promise;
  server = undefined;

  const run = await brokerAt(work, "pr-status", REPO, "7");
  assert.equal(run.code, 69, JSON.stringify(run));
  assert.ok(run.stderr.startsWith("broker: cannot reach broker: "), run.stderr);
  assert.equal(run.stdout, "");
});

test("a reply with a non-zero exit that is not a refusal passes its output through and exits with its code", async () => {
  await broker(JSON.stringify({ exit: 3, stdout: "partial\n", stderr: "gh failed\n" }));

  const run = await brokerAt(work, "pr-status", REPO, "7");
  assert.equal(run.code, 3, JSON.stringify(run));
  assert.equal(run.stdout, "partial\n");
  assert.equal(run.stderr, "gh failed\n");
});

test("a sync reply without a bundle exits 1 as malformed and imports nothing", async () => {
  await broker(JSON.stringify({ exit: 0, stdout: "", stderr: "" }));

  const run = await brokerAt(work, "sync", REPO);
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.equal(run.stderr, "broker: malformed sync reply\n");
  assert.equal(git(work, "for-each-ref", "refs/remotes"), "");
});

test("a sync --pr reply without a bundle exits 1 as malformed and imports nothing into the session's repo", async () => {
  await broker(JSON.stringify({ exit: 0, stdout: "", stderr: "", pr: 7, head: SHA }));

  const run = await client(work, {}, "sync", REPO, "--pr", "7");
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.equal(run.stderr, "broker: malformed sync reply\n");
  assert.equal(git(work, "for-each-ref", "refs/remotes"), "");
});

test("a PR bundle with two refs is refused, and the session's repo gets no origin/pr/<n>", async () => {
  git(work, "checkout", "--quiet", "-b", BRANCH);
  await commit(work, "a.txt");
  const bundlePath = join(root, "two.bundle");
  git(work, "bundle", "create", bundlePath, `refs/heads/${BRANCH}`, "refs/heads/main");
  // The first listed ref is the one an import that skips the count check would take.
  const head = git(work, "bundle", "list-heads", bundlePath).split("\n")[0].split(" ")[0];
  const bundle_b64 = execFileSync("base64", ["-i", bundlePath], { encoding: "utf8" }).replace(/\s/g, "");
  await broker(JSON.stringify({ exit: 0, stdout: "", stderr: "", pr: 7, head, bundle_b64 }));

  const run = await client(work, {}, "sync", REPO, "--pr", "7");
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.match(run.stderr, /^broker: cannot import sync bundle: the PR bundle holds 2 refs, want 1\n$/);
  assert.equal(git(work, "for-each-ref", "refs/remotes/origin/pr/7"), "");
});

test("send resolves with a well-formed broker reply", async () => {
  await broker(JSON.stringify({ exit: 0, stdout: "ok\n", stderr: "" }));

  assert.deepEqual(await send(socket, { verb: "merge", repo: REPO, number: 7 }), { exit: 0, stdout: "ok\n", stderr: "" });
  assert.deepEqual(requests, [{ verb: "merge", repo: REPO, number: 7 }]);
});

test("send rejects a JSON reply that is not a broker reply", async () => {
  await broker(JSON.stringify({ ok: true, stdout: "ok\n" }));

  await assert.rejects(send(socket, { verb: "merge", repo: REPO, number: 7 }), /malformed reply/);
});

test("send rejects a reply that is not JSON", async () => {
  await broker("merged, trust me\n");

  await assert.rejects(send(socket, { verb: "merge", repo: REPO, number: 7 }), /malformed reply/);
});

test("a merge whose broker reply exits non-zero still cleans up locally, and the client exits with the broker's code", async () => {
  git(work, "branch", BRANCH);
  const head = localBranch();
  await broker(mergedReply(head, 1));

  const run = await brokerAt(work, "merge", REPO, "7");
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.ok(run.stdout.startsWith("merged\n"), run.stdout);
  assert.equal(localBranch(), "");
});

test("a merge whose local cleanup fails exits 1 and keeps the dirty worktree and its branch", async () => {
  const tree = join(root, "tree");
  git(work, "worktree", "add", "--quiet", "-b", BRANCH, tree);
  const head = await commit(tree, "a.txt");
  await writeFile(join(tree, "draft.txt"), "draft\n");
  await broker(mergedReply(head));

  const run = await brokerAt(tree, "merge", REPO, "7");
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.ok(run.stderr.startsWith(`broker: merged, but kept worktree ${tree} and local branch ${BRANCH}: `), run.stderr);
  assert.equal(existsSync(join(tree, "draft.txt")), true);
  assert.equal(localBranch(), head);
});

test("local cleanup outside any git repo exits 1: it cannot list the worktrees", async () => {
  const plain = join(root, "plain");
  await mkdir(plain);
  await broker(mergedReply(SHA));

  const run = await brokerAt(plain, "merge", REPO, "7");
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.match(run.stderr, /^broker: merged, but cannot list the local worktrees: /m);
});

test("local cleanup exits 1 and keeps the branch when git lists no main worktree", async () => {
  git(work, "branch", BRANCH);
  const head = localBranch();
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh\nif [ "$1 $2" = "worktree list" ]; then exit 0; fi\nexec ${REAL_GIT} "$@"\n`, { mode: 0o755 });
  await broker(mergedReply(head));

  const run = await client(work, { PATH: `${bin}:${process.env.PATH ?? ""}` }, "merge", REPO, "7");
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.match(run.stderr, /^broker: merged, but git lists no main worktree\n/m);
  assert.equal(localBranch(), head);
});

test("local cleanup without a local branch of the PR exits 0 and says so", async () => {
  await broker(mergedReply(SHA));

  const run = await brokerAt(work, "merge", REPO, "7");
  assert.equal(run.code, 0, JSON.stringify(run));
  assert.equal(run.stdout, `merged\nbroker: no local branch ${BRANCH}\n`);
});

test("local cleanup keeps the branch that the main worktree has checked out", async () => {
  git(work, "checkout", "--quiet", "-b", BRANCH);
  const head = localBranch();
  await broker(mergedReply(head));

  const run = await brokerAt(work, "merge", REPO, "7");
  assert.equal(run.code, 0, JSON.stringify(run));
  assert.match(run.stdout, new RegExp(`broker: kept local branch ${BRANCH}: the main worktree .* has it checked out\\n$`));
  assert.equal(localBranch(), head);
  assert.equal(git(work, "symbolic-ref", "HEAD"), `refs/heads/${BRANCH}`);
});

test("local cleanup deletes a merged branch that has no linked worktree", async () => {
  git(work, "branch", BRANCH);
  await broker(mergedReply(localBranch()));

  const run = await brokerAt(work, "merge", REPO, "7");
  assert.equal(run.code, 0, JSON.stringify(run));
  assert.equal(run.stdout, `merged\nbroker: deleted local branch ${BRANCH}\n`);
  assert.equal(localBranch(), "");
});

test("local cleanup exits 1 and keeps the branch when git cannot delete it", async () => {
  git(work, "branch", BRANCH);
  const head = localBranch();
  await writeFile(join(work, ".git", "refs", "heads", `${BRANCH}.lock`), "");
  await broker(mergedReply(head));

  const run = await brokerAt(work, "merge", REPO, "7");
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.match(run.stderr, new RegExp(`^broker: merged, but cannot delete local branch ${BRANCH}: `, "m"));
  assert.equal(localBranch(), head);
});
