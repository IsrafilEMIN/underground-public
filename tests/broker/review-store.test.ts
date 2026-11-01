import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { isSyncPrReply, validateRequest } from "../../host/broker/protocol.ts";
import type { Binding, Reply } from "../../host/broker/protocol.ts";
import { defaultConfig, handleRequest, serveConnection } from "../../host/broker/server.ts";
import type { ServerConfig } from "../../host/broker/server.ts";
import { fakeTokens, tokenRemote } from "./fake-app.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const CLIENT = join(import.meta.dirname, "../../host/broker/client.ts");
const AUTHOR: Binding = { repo: REPO, role_name: "author", role: "author" };
const REVIEWER: Binding = { repo: REPO, role_name: "security-review", role: "security-review" };
// git 2.47+ ends fetch, commit and push with a detached `git maintenance run --auto`, which can still write in a
// repo after the command exits; afterEach then fails with ENOTEMPTY when it removes the repo. No test here needs it.
const NO_AUTO_MAINTENANCE = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false" };
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...NO_AUTO_MAINTENANCE };
const execFileAsync = promisify(execFile);

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
"repo view") printf '{"defaultBranchRef":{"name":"main"}}\\n' ;;
"pr view") cat "$HOME/pr.json" ;;
*) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;

let root: string;
let config: ServerConfig;
let remote: string;
let work: string;
let store: string;
let server: Server | undefined;

function git(dir: string, ...args: string[]): string {
  return execFileSync(config.gitPath, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: dir,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
}

function gitStatus(dir: string, ...args: string[]): number {
  try {
    execFileSync(config.gitPath, args, { cwd: dir, env: GIT_ENV, stdio: "ignore" });
    return 0;
  } catch {
    return 1;
  }
}

async function commit(file: string): Promise<string> {
  await writeFile(join(work, file), `${file}\n`);
  git(work, "add", file);
  git(work, "commit", "--quiet", "-m", file);
  return git(work, "rev-parse", "HEAD");
}

async function openPr(head: string, pushed = head): Promise<void> {
  git(work, "push", "--quiet", "--force", remote, `${pushed}:refs/pull/7/head`);
  await writeFile(join(config.home, "pr.json"), JSON.stringify({ headRefOid: head }));
}

async function listen(binding: Binding, edit: (reply: Reply) => Reply = (reply) => reply): Promise<string> {
  const path = join(root, "b.sock");
  server = createServer({ allowHalfOpen: true }, (socket) =>
    serveConnection(socket, async (input, signal) => edit(await handleRequest(config, binding, input, signal))),
  );
  const listening = Promise.withResolvers<void>();
  server.listen(path, () => listening.resolve());
  await listening.promise;
  return path;
}

type Run = { code: number; stdout: string; stderr: string };

async function client(cwd: string, env: Record<string, string>, ...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLIENT, ...args], {
      cwd,
      env: { ...GIT_ENV, UG_REVIEW_STORE: "", ...env },
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

beforeEach(async () => {
  root = await tempDir(join(process.env.XDG_STATE_HOME ?? tmpdir(), "ug-b2b-"));
  config = {
    ...defaultConfig(),
    runDir: join(root, "run"),
    bindingsFile: join(root, "bindings.json"),
    reposFile: join(root, "repos"),
    rolesFile: join(root, "roles"),
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
  await writeFile(config.reposFile, `${REPO}\n`);
  await writeFile(config.rolesFile, "author author\nsecurity-review security-review\n");
  await writeFile(config.ghPath, FAKE_GH, { mode: 0o755 });
  remote = join(root, "remote.git");
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", remote], { env: GIT_ENV });
  const bare = join(config.reposRoot, `${REPO}.git`);
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", bare], { env: GIT_ENV });
  git(bare, "config", `url.file://${remote}.insteadOf`, tokenRemote(REPO));
  git(bare, "config", "maintenance.auto", "false");
  work = join(root, "work");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
  await commit("base.txt");
  git(work, "push", "--quiet", remote, "main:main");
  git(work, "checkout", "--quiet", "-b", "agent/x");
  store = join(root, "store.git");
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", store], { env: GIT_ENV });
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

test("sync --pr makes origin/pr/<n> in the reviewer store at headRefOid", async () => {
  const head = await commit("a.txt");
  await openPr(head);
  const socket = await listen(REVIEWER);

  const run = await client(root, { UG_BROKER_SOCKET: socket, UG_REVIEW_STORE: store }, "sync", REPO, "--pr", "7");
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `origin/pr/7 is now ${head} in ${store}\n`);
  assert.equal(git(store, "rev-parse", "refs/remotes/origin/pr/7"), head);
  assert.equal(git(store, "for-each-ref", "--format=%(refname)"), "refs/remotes/origin/pr/7");
  assert.equal(git(join(config.reposRoot, `${REPO}.git`), "for-each-ref", "refs/broker"), "");

  const next = await commit("b.txt");
  await openPr(next);
  const again = await client(root, { UG_BROKER_SOCKET: socket, UG_REVIEW_STORE: store }, "sync", REPO, "--pr", "7");
  assert.equal(again.code, 0, again.stderr);
  assert.equal(git(store, "rev-parse", "refs/remotes/origin/pr/7"), next);
});

test("a plain sync in a reviewer session imports the default branch into the store", async () => {
  const socket = await listen(REVIEWER);
  const run = await client(root, { UG_BROKER_SOCKET: socket, UG_REVIEW_STORE: store }, "sync", REPO);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(git(store, "rev-parse", "refs/remotes/origin/main"), git(work, "rev-parse", "main"));
});

test("sync --pr fails and leaves no origin/pr/<n> when the imported commit is not headRefOid", async () => {
  const head = await commit("a.txt");
  await openPr(head);
  const other = await commit("b.txt");
  const socket = await listen(REVIEWER, (reply) => (isSyncPrReply(reply) ? { ...reply, head: other } : reply));
  git(work, "push", "--quiet", store, `${head}:refs/remotes/origin/pr/7`);

  const run = await client(root, { UG_BROKER_SOCKET: socket, UG_REVIEW_STORE: store }, "sync", REPO, "--pr", "7");
  assert.equal(run.code, 1);
  assert.match(run.stderr, new RegExp(`the imported commit ${head} is not the PR head ${other}`));
  assert.equal(gitStatus(store, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/pr/7"), 1);
});

test("the reviewer's store commands write neither the store config nor its hooks, which the sandbox denies", async () => {
  const snapshot = async (): Promise<unknown[]> => {
    const [file, hooks] = await Promise.all([stat(join(store, "config")), stat(join(store, "hooks"))]);
    return [await readFile(join(store, "config"), "utf8"), file.ino, file.mtimeMs, hooks.ino, hooks.mtimeMs, await readdir(join(store, "hooks"))];
  };
  const before = await snapshot();
  let wrongHead: string | undefined;
  const socket = await listen(REVIEWER, (reply) => (isSyncPrReply(reply) && wrongHead !== undefined ? { ...reply, head: wrongHead } : reply));
  const env = { UG_BROKER_SOCKET: socket, UG_REVIEW_STORE: store };
  assert.equal((await client(root, env, "sync", REPO)).code, 0);
  await openPr(await commit("a.txt"));
  assert.equal((await client(root, env, "sync", REPO, "--pr", "7")).code, 0);
  wrongHead = await commit("b.txt");
  assert.equal((await client(root, env, "sync", REPO, "--pr", "7")).code, 1);
  assert.deepEqual(await snapshot(), before);
});

test("the broker refuses a PR sync when GitHub sends a commit that is not headRefOid", async () => {
  const head = await commit("a.txt");
  const stale = await commit("b.txt");
  await openPr(head, stale);
  const reply = await handleRequest(config, REVIEWER, { verb: "sync", repo: REPO, pr: 7 }, new AbortController().signal);
  assert.deepEqual(reply, {
    exit: 2,
    refused: `PR 7 head moved during the sync: headRefOid is ${head}, GitHub sent ${stale}; run sync again`,
  });
  assert.equal(git(join(config.reposRoot, `${REPO}.git`), "for-each-ref", "refs/broker"), "");
});

test("sync --pr without a reviewer store refuses before it asks the broker", async () => {
  const run = await client(work, { UG_BROKER_SOCKET: join(root, "none.sock") }, "sync", REPO, "--pr", "7");
  assert.equal(run.code, 64);
  assert.match(run.stderr, /this session has no reviewer git store \(UG_REVIEW_STORE is not set/);
  const usage = await client(work, { UG_BROKER_SOCKET: join(root, "none.sock") }, "sync", REPO, "--pr");
  assert.equal(usage.code, 64);
  assert.equal(validateRequest({ verb: "sync", repo: REPO, pr: 0 }).ok, false);
  assert.equal(validateRequest({ verb: "sync", repo: REPO, pr: "7" }).ok, false);
});

test("sync without --pr imports origin/<default> into the author's repo as before", async () => {
  const main = git(work, "rev-parse", "main");
  await commit("local.txt");
  const socket = await listen(AUTHOR);
  const run = await client(work, { UG_BROKER_SOCKET: socket }, "sync", REPO);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `origin/main is now ${main}\n`);
  assert.equal(git(work, "rev-parse", "refs/remotes/origin/main"), main);
  assert.equal(git(store, "for-each-ref"), "");
});
