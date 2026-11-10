
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { isSyncPrReply, validateRequest } from "../../host/gh-broker/protocol.ts";
import type { Reply } from "../../host/gh-broker/protocol.ts";
import { defaultConfig, handleRequest, refreshRepos, serveConnection } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import type { GithubTokens, TokenScope } from "../../host/gh-broker/github-app.ts";
import { FAKE_TOKEN, fakeTokens, githubRemote } from "./fake-app.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const CLIENT = join(import.meta.dirname, "../../host/gh-broker/client.ts");

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
let session: string;
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

async function listen(edit: (reply: Reply) => Reply = (reply) => reply): Promise<string> {
  const path = join(root, "b.sock");
  server = createServer({ allowHalfOpen: true }, (socket) =>
    serveConnection(socket, async (input, signal) => edit(await handleRequest(config, input, signal))),
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
      env: { ...GIT_ENV, ...env },
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
  remote = join(root, "remote.git");
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", "-b", "main", remote], { env: GIT_ENV });
  const bare = join(config.reposRoot, `${REPO}.git`);
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", bare], { env: GIT_ENV });
  git(bare, "config", `url.file://${remote}.insteadOf`, githubRemote(REPO));
  git(bare, "config", "maintenance.auto", "false");
  work = join(root, "work");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
  await commit("base.txt");
  git(work, "push", "--quiet", remote, "main:main");
  git(work, "checkout", "--quiet", "-b", "agent/x");
  session = join(root, "session");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", session], { env: GIT_ENV });
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

test("sync --pr makes origin/pr/<n> in the session's repo at headRefOid, and moves it with the PR", async () => {
  const head = await commit("a.txt");
  await openPr(head);
  const socket = await listen();

  const run = await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO, "--pr", "7");
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `origin/pr/7 is now ${head}\n`);
  assert.equal(git(session, "rev-parse", "refs/remotes/origin/pr/7"), head);
  assert.equal(git(session, "for-each-ref", "--format=%(refname)"), "refs/remotes/origin/pr/7");
  assert.equal(git(join(config.reposRoot, `${REPO}.git`), "for-each-ref", "refs/gh-broker"), "");

  const next = await commit("b.txt");
  await openPr(next);
  const again = await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO, "--pr", "7");
  assert.equal(again.code, 0, again.stderr);
  assert.equal(git(session, "rev-parse", "refs/remotes/origin/pr/7"), next);
});

test("sync --pr fails and leaves no origin/pr/<n> when the imported commit is not headRefOid", async () => {
  const head = await commit("a.txt");
  await openPr(head);
  const other = await commit("b.txt");
  const socket = await listen((reply) => (isSyncPrReply(reply) ? { ...reply, head: other } : reply));
  git(work, "push", "--quiet", session, `${head}:refs/remotes/origin/pr/7`);

  const run = await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO, "--pr", "7");
  assert.equal(run.code, 1);
  assert.match(run.stderr, new RegExp(`the imported commit ${head} is not the PR head ${other}`));
  assert.equal(gitStatus(session, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/pr/7"), 1);
});

test("the gh-broker refuses a PR sync when GitHub sends a commit that is not headRefOid", async () => {
  const head = await commit("a.txt");
  const stale = await commit("b.txt");
  await openPr(head, stale);
  const reply = await handleRequest(config, { verb: "sync", repo: REPO, pr: 7 }, new AbortController().signal);
  assert.deepEqual(reply, {
    exit: 2,
    refused: `PR 7 head moved during the sync: headRefOid is ${head}, GitHub sent ${stale}; run sync again`,
  });
  assert.equal(git(join(config.reposRoot, `${REPO}.git`), "for-each-ref", "refs/gh-broker"), "");
});

test("a PR sync gives git only the token that can read code, never the token that pushes and merges", async () => {
  await openPr(await commit("a.txt"));
  const real = config.gitPath;
  const read = `${FAKE_TOKEN}read`;
  config.github = { token: (_repo, _signal, scope = "app") => Promise.resolve(scope === "contents-read" ? read : FAKE_TOKEN), drop: () => {} };
  config.gitPath = join(root, "git");
  await writeFile(config.gitPath, `#!/bin/sh\nprintf '%s\\n' "$GIT_CONFIG_VALUE_0" >> "$HOME/git-headers"\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const reply = await handleRequest(config, { verb: "sync", repo: REPO, pr: 7 }, new AbortController().signal);
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  const headers = (await readFile(join(config.home, "git-headers"), "utf8")).split("\n").filter((line) => line !== "");
  assert.deepEqual([...new Set(headers)], [`Authorization: Basic ${Buffer.from(`x-access-token:${read}`).toString("base64")}`]);
});

test("sync --pr without a PR number, or with a bad one, is a usage error", async () => {
  const usage = await client(session, { UG_GH_BROKER_SOCKET: join(root, "none.sock") }, "sync", REPO, "--pr");
  assert.equal(usage.code, 64);
  assert.equal(validateRequest({ verb: "sync", repo: REPO, pr: 0 }).ok, false);
  assert.equal(validateRequest({ verb: "sync", repo: REPO, pr: "7" }).ok, false);
});

test("sync without --pr imports origin/<default> into the session's repo, and no PR ref", async () => {
  const main = git(work, "rev-parse", "main");
  await commit("local.txt");
  const socket = await listen();
  const run = await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `origin/main is now ${main}\n`);
  assert.equal(git(session, "for-each-ref", "--format=%(refname) %(objectname)"), `refs/remotes/origin/main ${main}`);
});

async function moveMain(file: string): Promise<string> {
  const head = await commit(file);
  git(work, "push", "--quiet", remote, "HEAD:main");
  return head;
}

function scopedTokens(): { tokens: GithubTokens; scopes: TokenScope[] } {
  const scopes: TokenScope[] = [];
  return {
    scopes,
    tokens: {
      token: (_repo, _signal, scope = "app") => {
        scopes.push(scope);
        return Promise.resolve(FAKE_TOKEN);
      },
      drop: () => {},
    },
  };
}

test("a sync from a clone that already has main gets no bundle and keeps origin/main", async () => {
  const main = git(work, "rev-parse", "main");
  const bundles: boolean[] = [];
  const socket = await listen((reply) => {
    bundles.push("bundle_b64" in reply);
    return reply;
  });
  assert.equal((await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO)).code, 0);
  const again = await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, `origin/main is now ${main}\n`);
  assert.deepEqual(bundles, [true, false]);
  assert.equal(git(session, "rev-parse", "refs/remotes/origin/main"), main);
});

test("a launch sync (--cached) within 40 s of the last check gets main from the gh-broker's copy; after that the gh-broker asks GitHub and sends only the new commits", async () => {
  let now = 1_000_000;
  config.now = () => now;
  const first = git(work, "rev-parse", "main");
  const socket = await listen();
  assert.equal((await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO, "--cached")).stdout, `origin/main is now ${first}\n`);

  const moved = await moveMain("a.txt");
  now += 40_000;
  const cached = await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO, "--cached");
  assert.equal(cached.stdout, `origin/main is now ${first}\n`, "a check 40 s old still counts as current");

  now += 1;
  const reply = await handleRequest(config, { verb: "sync", repo: REPO, have: [first], cached: true }, new AbortController().signal);
  assert.ok("head" in reply && reply.head === moved, JSON.stringify(reply));
  const bundle = "bundle_b64" in reply ? reply.bundle_b64 : undefined;
  assert.ok(bundle !== undefined, JSON.stringify(reply));
  const header = Buffer.from(bundle, "base64").toString("latin1").split("\n\n")[0] ?? "";
  assert.ok(header.split("\n").some((line) => line.startsWith(`-${first}`)), `the bundle needs the clone's commit, so it holds only the new ones: ${header}`);

  const fresh = await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO, "--cached");
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(fresh.stdout, `origin/main is now ${moved}\n`);
  assert.equal(git(session, "rev-parse", "refs/remotes/origin/main"), moved);
});

test("a plain sync asks GitHub even right after a check, so a session that syncs to rebase gets the main of this moment", async () => {
  let now = 1_000_000;
  config.now = () => now;
  const socket = await listen();
  assert.equal((await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO, "--cached")).code, 0);
  const moved = await moveMain("a.txt");
  now += 1_000;
  const run = await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `origin/main is now ${moved}\n`);
});

test("the refresh picks up a new main for a recently synced repo, so the next launch sync gets it without asking GitHub", async () => {
  let now = 1_000_000;
  config.now = () => now;
  const socket = await listen();
  assert.equal((await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO, "--cached")).code, 0);
  const moved = await moveMain("a.txt");
  now += 30_000;
  await refreshRepos(config, new AbortController().signal);
  now += 30_000;
  const { tokens, scopes } = scopedTokens();
  config.github = tokens;
  const run = await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO, "--cached");
  assert.equal(run.stdout, `origin/main is now ${moved}\n`);
  assert.deepEqual(scopes, [], "a launch sync right after a refresh needs no GitHub call");
});

test("the refresh asks GitHub only with a token that can read code, and skips a repo with no sync for 7 days", async () => {
  let now = 1_000_000;
  config.now = () => now;
  const { tokens, scopes } = scopedTokens();
  config.github = tokens;
  assert.equal((await handleRequest(config, { verb: "sync", repo: REPO }, new AbortController().signal)).exit, 0);
  scopes.length = 0;
  await moveMain("a.txt");
  now += 30_000;
  await refreshRepos(config, new AbortController().signal);
  assert.ok(scopes.length > 0 && scopes.every((scope) => scope === "contents-read"), scopes.join(","));

  scopes.length = 0;
  now += 7 * 24 * 60 * 60 * 1000 + 1;
  await moveMain("b.txt");
  await refreshRepos(config, new AbortController().signal);
  assert.deepEqual(scopes, []);
});

test("a refresh and a sync at the same moment both succeed and leave the copy at GitHub's main", async () => {
  let now = 1_000_000;
  config.now = () => now;
  const signal = new AbortController().signal;
  assert.equal((await handleRequest(config, { verb: "sync", repo: REPO }, signal)).exit, 0);
  const moved = await moveMain("a.txt");
  now += 41_000;
  const [, reply] = await Promise.all([refreshRepos(config, signal), handleRequest(config, { verb: "sync", repo: REPO }, signal)]);
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.ok("head" in reply && reply.head === moved, JSON.stringify(reply));
  assert.equal(git(join(config.reposRoot, `${REPO}.git`), "rev-parse", "refs/heads/main"), moved);
});

test("a clone whose origin/main the gh-broker does not know gets the full history", async () => {
  const main = git(work, "rev-parse", "main");
  const stray = join(root, "stray");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", stray], { env: GIT_ENV });
  git(stray, "commit", "--quiet", "--allow-empty", "-m", "stray");
  git(stray, "push", "--quiet", session, "HEAD:refs/remotes/origin/main");
  const socket = await listen();
  const run = await client(session, { UG_GH_BROKER_SOCKET: socket }, "sync", REPO);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, `origin/main is now ${main}\n`);
  assert.equal(git(session, "rev-parse", "refs/remotes/origin/main"), main);
});

test("a sync request takes at most 16 full commit shas as have and cached only as true, and a PR sync takes neither", () => {
  const sha = "a".repeat(40);
  assert.equal(validateRequest({ verb: "sync", repo: REPO, have: [sha] }).ok, true);
  for (const have of [["--all"], [`^${sha}`], [sha.slice(1)], Array(17).fill(sha), sha]) {
    assert.equal(validateRequest({ verb: "sync", repo: REPO, have }).ok, false, JSON.stringify(have));
  }
  assert.equal(validateRequest({ verb: "sync", repo: REPO, pr: 7, have: [sha] }).ok, false);
  assert.equal(validateRequest({ verb: "sync", repo: REPO, pr: 7, cached: true }).ok, false);
  assert.equal(validateRequest({ verb: "sync", repo: REPO, cached: true }).ok, true);
  for (const cached of [false, "yes", 1]) assert.equal(validateRequest({ verb: "sync", repo: REPO, cached }).ok, false, String(cached));
});
