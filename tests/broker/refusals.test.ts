import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Reply } from "../../host/gh-broker/protocol.ts";
import { readPushRecord } from "../../host/gh-broker/push-record.ts";
import { defaultConfig, handleRequest } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import { fakeTokens, githubRemote } from "./fake-app.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const OTHER_REPO = "o/other";
const BRANCH = "agent/x";
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/gh-calls"
case "$1 $2 $4" in
"repo view "*) printf '{"defaultBranchRef":{"name":"%s"}}\\n' "$(cat "$HOME/default-branch")" ;;
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

function request(input: Record<string, unknown>): Promise<Reply> {
  return handleRequest(config, { repo: REPO, ...input }, new AbortController().signal);
}

function push(branch: string, sha: string): Promise<Reply> {
  const bundle = execFileSync(config.gitPath, ["bundle", "create", "-", `refs/heads/${branch}`], { cwd: work, env: GIT_ENV }).toString("base64");
  return request({ verb: "push", branch, sha, bundle_b64: bundle });
}

function remoteRef(branch: string): string {
  return git(remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
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
    ...defaultConfig("/unused/gh"),
    socketPath: join(root, "run", "gh-broker.sock"),
    reposRoot: join(root, "bare"),
    pushesDir: join(root, "pushes"),
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

test("a push whose record cannot be written fails and says the branch cleanup will not delete the branch", async () => {
  const first = await commit(BRANCH, "a.txt");
  const one = await push(BRANCH, first);
  assert.equal(one.exit, 0, JSON.stringify(one));
  const second = await commit(BRANCH, "b.txt");

  await chmod(join(config.pushesDir, REPO), 0o500);
  const two = await push(BRANCH, second);
  await chmod(join(config.pushesDir, REPO), 0o700);
  assert.equal(two.exit, 1, JSON.stringify(two));
  assert.ok(
    "stderr" in two && two.stderr.includes("gh-broker: pushed, but cannot write the push record, so the branch cleanup will not delete this branch after its merge"),
    JSON.stringify(two),
  );
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: BRANCH }), { kind: "pushed", sha: first });
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

test("a repo where the gh-broker app is not installed gets no token, so no gh call, push, or record happens", async () => {
  const head = await commit(BRANCH, "a.txt");
  const bundle = execFileSync(config.gitPath, ["bundle", "create", "-", `refs/heads/${BRANCH}`], { cwd: work, env: GIT_ENV }).toString("base64");
  const signal = new AbortController().signal;
  const installed = config.github;
  config.github = {
    token: (repo, s) => (repo === REPO ? installed.token(repo, s) : Promise.reject(new Error(`the app is not installed on ${repo}`))),
    dropIfRejected: (repo, token, s) => installed.dropIfRejected(repo, token, s),
  };

  for (const input of [
    { verb: "sync", repo: OTHER_REPO },
    { verb: "push", repo: OTHER_REPO, branch: BRANCH, sha: head, bundle_b64: bundle },
    { verb: "pr-create", repo: OTHER_REPO, head: BRANCH, title: "t", body: "" },
    { verb: "pr-status", repo: OTHER_REPO, number: 7 },
  ]) {
    const reply = await handleRequest(config, input, signal);
    assert.notEqual(reply.exit, 0, `${input.verb}: ${JSON.stringify(reply)}`);
    assert.match(JSON.stringify(reply), /not installed on|cannot get a GitHub App token/, input.verb);
  }
  assert.equal(await readHome("gh-calls"), "");
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: OTHER_REPO, branch: BRANCH }), { kind: "none" });
});
