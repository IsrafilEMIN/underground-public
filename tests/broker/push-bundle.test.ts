import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { startServer, stopServer } from "../../host/gh-broker/server.ts";
import type { GhBroker, ServerConfig } from "../../host/gh-broker/server.ts";
import type { Reply } from "../../host/gh-broker/protocol.ts";
import { tempDir } from "../temp.ts";
import { BRANCH, GIT_ENV, REPO, brokerConfig, bundleOf, commit, git, initMirror, initRepo, remoteRef, request, seedMain } from "./fixture.ts";

const CLIENT = join(import.meta.dirname, "../../host/gh-broker/client.ts");
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
"repo view") printf '{"defaultBranchRef":{"name":"main"}}\\n' ;;
*) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;
const execFileAsync = promisify(execFile);

let root: string;
let config: ServerConfig;
let broker: GhBroker | undefined;
let remote: string;
let mirror: string;
let work: string;
let base: string;

async function clientPush(): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await execFileAsync(process.execPath, [CLIENT, "push", REPO, BRANCH], {
      cwd: work,
      env: { ...GIT_ENV, UG_GH_BROKER_SOCKET: config.socketPath },
      encoding: "utf8",
    });
    return { code: 0, stderr };
  } catch (error) {
    const failed = error as { code: number; stderr: string };
    return { code: failed.code, stderr: failed.stderr };
  }
}

function push(sha: string): Promise<Reply> {
  return request(config, { verb: "push", branch: BRANCH, sha, bundle_b64: bundleOf(work, BRANCH) });
}

async function onBranchFrom(start: string, file: string): Promise<string> {
  git(work, "checkout", "--quiet", "-B", BRANCH, start);
  return commit(work, file);
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-pb-"));
  config = await brokerConfig(root, FAKE_GH);
  remote = initRepo(join(root, "remote.git"), true);
  mirror = initMirror(config, remote);
  work = initRepo(join(root, "work"));
  base = await seedMain(work, remote);
  git(work, "update-ref", "refs/remotes/origin/main", base);
});

afterEach(async () => {
  if (broker !== undefined) await stopServer(broker);
  broker = undefined;
  await rm(root, { recursive: true, force: true });
});

test("a push lands when the gh-broker's copy holds main, and when it lacks main, and when the branch has nothing past main", async () => {
  broker = await startServer(config);

  const lacking = await onBranchFrom(base, "a.txt");
  const first = await clientPush();
  assert.equal(first.code, 0, first.stderr);
  assert.equal(remoteRef(remote, BRANCH), lacking);

  git(mirror, "fetch", "--quiet", remote, "main:refs/heads/main");
  const holding = await onBranchFrom(base, "b.txt");
  const second = await clientPush();
  assert.equal(second.code, 0, second.stderr);
  assert.equal(remoteRef(remote, BRANCH), holding);

  git(work, "checkout", "--quiet", "-B", BRANCH, base);
  const empty = await clientPush();
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(remoteRef(remote, BRANCH), base);
});

test("a push that would drop a commit someone added on GitHub is refused, and one rebased onto it lands", async () => {
  const mine = await onBranchFrom(base, "a.txt");
  assert.equal((await push(mine)).exit, 0);
  const theirs = await commit(work, "theirs.txt");
  git(work, "push", "--quiet", remote, `${theirs}:refs/heads/${BRANCH}`);

  const dropping = await onBranchFrom(mine, "b.txt");
  const refused = await push(dropping);
  assert.ok("refused" in refused && refused.refused.includes(theirs), JSON.stringify(refused));
  assert.equal(remoteRef(remote, BRANCH), theirs);

  const rebased = await onBranchFrom(theirs, "b.txt");
  const landed = await push(rebased);
  assert.equal(landed.exit, 0, JSON.stringify(landed));
  assert.equal(remoteRef(remote, BRANCH), rebased);
});

test("the agent can rewrite a branch that still holds its own last push", async () => {
  const first = await onBranchFrom(base, "a.txt");
  assert.equal((await push(first)).exit, 0);
  const rewritten = await onBranchFrom(base, "b.txt");
  const reply = await push(rewritten);
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.equal(remoteRef(remote, BRANCH), rewritten);
});

test("a branch on GitHub that the gh-broker never pushed is not overwritten", async () => {
  const theirs = await onBranchFrom(base, "theirs.txt");
  git(work, "push", "--quiet", remote, `${theirs}:refs/heads/${BRANCH}`);
  const mine = await onBranchFrom(base, "a.txt");
  const reply = await push(mine);
  assert.ok("refused" in reply, JSON.stringify(reply));
  assert.equal(remoteRef(remote, BRANCH), theirs);
});
