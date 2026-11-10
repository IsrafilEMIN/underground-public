import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { send } from "../../host/gh-broker/client.ts";
import { BRANCH, GIT_ENV, REPO, commit, git, initRepo } from "./fixture.ts";
import { tempDir } from "../temp.ts";

const CLIENT = join(import.meta.dirname, "../../host/gh-broker/client.ts");
const execFileAsync = promisify(execFile);

let root: string;
let work: string;
let socket: string;
let server: Server | undefined;
let requests: unknown[];

async function broker(...replies: string[]): Promise<void> {
  server = createServer({ allowHalfOpen: true }, (conn) => {
    let text = "";
    conn.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (!text.includes("\n")) return;
      requests.push(JSON.parse(text.slice(0, text.indexOf("\n"))));
      conn.end(replies[Math.min(requests.length, replies.length) - 1]);
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
      env: { ...GIT_ENV, UG_GH_BROKER_SOCKET: socket, GIT_CEILING_DIRECTORIES: root, ...env },
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

beforeEach(async () => {
  root = await tempDir(join(process.env.XDG_STATE_HOME ?? tmpdir(), "ug-cl-"));
  socket = join(root, "b.sock");
  requests = [];
  work = initRepo(join(root, "work"));
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
  { name: "too few arguments", argv: ["pr-status", REPO], reason: "wrong number of arguments" },
  { name: "too many arguments", argv: ["ci-log", REPO, "7", "8"], reason: "wrong number of arguments" },
  { name: "a repo that is not owner/repo", argv: ["pr-status", "not-a-repo", "7"], reason: "invalid <owner/repo>" },
  { name: "a push of a branch outside agent/", argv: ["push", REPO, "main"], reason: "branch must match agent/<name>" },
  { name: "a pr-create from a branch outside agent/", argv: ["pr-create", REPO, "main", "t", "b"], reason: "branch must match agent/<name>" },
  { name: "a PR number that is not a positive integer", argv: ["pr-status", REPO, "0"], reason: "invalid PR number" },
  { name: "a PR number with letters", argv: ["ci-log", REPO, "7a"], reason: "invalid PR number" },
  { name: "a sync flag other than --pr", argv: ["sync", REPO, "--x", "7"], reason: "want sync <owner/repo> --pr <n>" },
  { name: "an empty PR title", argv: ["pr-create", REPO, BRANCH, "", "body"], reason: "invalid title" },
];

for (const { name, argv, reason } of USAGE_CASES) {
  test(`usage error, ${name}: exit 64 with the reason and the usage, and nothing reaches the gh-broker`, async () => {
    await broker(JSON.stringify({ exit: 0, stdout: "sent\n", stderr: "" }));

    const run = await brokerAt(work, ...argv);
    assert.equal(run.code, 64, JSON.stringify(run));
    assert.ok(run.stderr.startsWith(`gh-broker: ${reason}`), run.stderr);
    assert.match(run.stderr, /\nusage:\n/);
    assert.equal(run.stdout, "");
    assert.deepEqual(requests, []);
  });
}

test("ci-log sends the repo and PR number to the gh-broker and prints the log it returns", async () => {
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
  assert.ok(run.stderr.startsWith("gh-broker: "), run.stderr);
  assert.doesNotMatch(run.stderr, /usage:/);
  assert.deepEqual(requests, []);
});

test("a session without a gh-broker socket exits 69 and says the socket is not set", async () => {
  const run = await client(work, { UG_GH_BROKER_SOCKET: "" }, "pr-status", REPO, "7");
  assert.equal(run.code, 69, JSON.stringify(run));
  assert.match(run.stderr, /no gh-broker socket \(UG_GH_BROKER_SOCKET is not set/);
  assert.equal(run.stdout, "");
});

test("a gh-broker that is down exits 69 and says it cannot reach the gh-broker", async () => {
  await broker(JSON.stringify({ exit: 0, stdout: "", stderr: "" }));
  const closed = Promise.withResolvers<void>();
  server?.close(() => closed.resolve());
  await closed.promise;
  server = undefined;

  const run = await brokerAt(work, "pr-status", REPO, "7");
  assert.equal(run.code, 69, JSON.stringify(run));
  assert.ok(run.stderr.startsWith("gh-broker: cannot reach gh-broker: "), run.stderr);
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
  assert.equal(run.stderr, "gh-broker: malformed sync reply\n");
  assert.equal(git(work, "for-each-ref", "refs/remotes"), "");
});

test("a sync --pr reply without a bundle exits 1 as malformed and imports nothing into the session's repo", async () => {
  await broker(JSON.stringify({ exit: 0, stdout: "", stderr: "", pr: 7, head: SHA }));

  const run = await client(work, {}, "sync", REPO, "--pr", "7");
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.equal(run.stderr, "gh-broker: malformed sync reply\n");
  assert.equal(git(work, "for-each-ref", "refs/remotes"), "");
});

test("a PR bundle with two refs is refused, and the session's repo gets no origin/pr/<n>", async () => {
  git(work, "checkout", "--quiet", "-b", BRANCH);
  await commit(work, "a.txt");
  const bundlePath = join(root, "two.bundle");
  git(work, "bundle", "create", bundlePath, `refs/heads/${BRANCH}`, "refs/heads/main");

  const head = git(work, "bundle", "list-heads", bundlePath).split("\n")[0].split(" ")[0];
  const bundle_b64 = execFileSync("base64", ["-i", bundlePath], { encoding: "utf8" }).replace(/\s/g, "");
  await broker(JSON.stringify({ exit: 0, stdout: "", stderr: "", pr: 7, head, bundle_b64 }));

  const run = await client(work, {}, "sync", REPO, "--pr", "7");
  assert.equal(run.code, 1, JSON.stringify(run));
  assert.match(run.stderr, /^gh-broker: cannot import sync bundle: the PR bundle holds 2 refs, want 1\n$/);
  assert.equal(git(work, "for-each-ref", "refs/remotes/origin/pr/7"), "");
});

test("send resolves with a well-formed gh-broker reply", async () => {
  await broker(JSON.stringify({ exit: 0, stdout: "ok\n", stderr: "" }));

  assert.deepEqual(await send(socket, { verb: "pr-status", repo: REPO, number: 7 }), { exit: 0, stdout: "ok\n", stderr: "" });
  assert.deepEqual(requests, [{ verb: "pr-status", repo: REPO, number: 7 }]);
});

test("send rejects a JSON reply that is not a gh-broker reply", async () => {
  await broker(JSON.stringify({ ok: true, stdout: "ok\n" }));

  await assert.rejects(send(socket, { verb: "pr-status", repo: REPO, number: 7 }), /malformed reply/);
});

test("send rejects a reply that is not JSON", async () => {
  await broker("pr-status output, trust me\n");

  await assert.rejects(send(socket, { verb: "pr-status", repo: REPO, number: 7 }), /malformed reply/);
});

test("sweep without one default branch name is a usage error", async () => {
  const run = await brokerAt(work, "sweep");
  assert.equal(run.code, 64, JSON.stringify(run));
  assert.ok(run.stderr.startsWith("gh-broker: want sweep <default-branch>\n"), run.stderr);
});
