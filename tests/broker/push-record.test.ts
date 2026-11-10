import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { isReply } from "../../host/gh-broker/protocol.ts";
import type { Reply } from "../../host/gh-broker/protocol.ts";
import { dropPushRecord, listPushRecords, pushRecordPath, readPushRecord, writePushRecord } from "../../host/gh-broker/push-record.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import { tempDir } from "../temp.ts";
import { BRANCH, REPO, brokerConfig, bundleOf, commit, git, initMirror, initRepo, request } from "./fixture.ts";

const FAKE_GH = `#!/bin/sh
case "$1 $2 $4" in
"repo view "*) printf '{"defaultBranchRef":{"name":"main"}}\\n' ;;
*) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;

const BROKER_PROCESS = `
import { handleRequest } from ${JSON.stringify(new URL("../../host/gh-broker/server.ts", import.meta.url).href)};
import { fakeTokens } from ${JSON.stringify(new URL("./fake-app.ts", import.meta.url).href)};
const [config, request] = JSON.parse(process.argv[1]);
config.github = fakeTokens();
process.stdout.write(JSON.stringify(await handleRequest(config, request, new AbortController().signal)));
`;

let root: string;
let config: ServerConfig;
let work: string;
let remote: string;

function brokerPush(sha: string): Promise<Reply> {
  return request(config, { verb: "push", branch: BRANCH, sha, bundle_b64: bundleOf(work, BRANCH) });
}

function brokerProcess(request: Record<string, unknown>): Reply {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", BROKER_PROCESS, JSON.stringify([config, request])], {
    encoding: "utf8",
  });
  const reply: unknown = JSON.parse(out);
  assert.ok(isReply(reply), out);
  return reply;
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-b4-"));
  config = await brokerConfig(root, FAKE_GH);
  remote = initRepo(join(root, "remote.git"), true);
  initMirror(config, remote);
  work = initRepo(join(root, "work"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a gh-broker push records the commit for its repo and branch, and a later push replaces it", async () => {
  const first = await commit(work, "a.txt", BRANCH);
  const one = await brokerPush(first);
  assert.equal(one.exit, 0, JSON.stringify(one));
  assert.equal(git(remote, "rev-parse", `refs/heads/${BRANCH}`), first);
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: BRANCH }), { kind: "pushed", sha: first });

  const second = await commit(work, "b.txt", BRANCH);
  const two = await brokerPush(second);
  assert.equal(two.exit, 0, JSON.stringify(two));
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: BRANCH }), { kind: "pushed", sha: second });
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: "agent/other" }), { kind: "none" });
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: "o/other", branch: BRANCH }), { kind: "none" });
});

test("a refused push leaves the record unchanged", async () => {
  const first = await commit(work, "a.txt", BRANCH);
  assert.equal((await brokerPush(first)).exit, 0);
  const other = await commit(work, "b.txt", BRANCH);
  await commit(work, "c.txt", BRANCH);
  const reply = await brokerPush(other);
  assert.deepEqual(reply, { exit: 2, refused: "bundle ref does not match sha" });
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: BRANCH }), { kind: "pushed", sha: first });
});

test("a drop removes only its own record, and only while the record holds the commit it names", async () => {
  const key = { repo: REPO, branch: BRANCH };
  const nested = { repo: REPO, branch: `${BRANCH}/nested` };
  await writePushRecord(config.pushesDir, key, "a".repeat(40));
  await writePushRecord(config.pushesDir, nested, "b".repeat(40));
  assert.equal(await dropPushRecord(config.pushesDir, key, "c".repeat(40)), false);
  assert.deepEqual(await readPushRecord(config.pushesDir, key), { kind: "pushed", sha: "a".repeat(40) });
  assert.equal(await dropPushRecord(config.pushesDir, key, "a".repeat(40)), true);
  assert.deepEqual(await readPushRecord(config.pushesDir, key), { kind: "none" });
  assert.equal(await dropPushRecord(config.pushesDir, key, "a".repeat(40)), false);
  assert.deepEqual(await readPushRecord(config.pushesDir, nested), { kind: "pushed", sha: "b".repeat(40) });
  assert.deepEqual(await listPushRecords(config.pushesDir), [{ repo: REPO, branch: `${BRANCH}/nested`, sha: "b".repeat(40) }]);
});

test("a push record that exists but cannot be read is unreadable, not absent", async () => {
  const key = { repo: REPO, branch: BRANCH };
  await mkdir(join(pushRecordPath(config.pushesDir, key), "x"), { recursive: true });
  assert.deepEqual(await readPushRecord(config.pushesDir, key), { kind: "unreadable" });
});

test("a push record is a file only its owner can read, in a folder only its owner can enter", async () => {
  const key = { repo: REPO, branch: BRANCH };
  await writePushRecord(config.pushesDir, key, "a".repeat(40));
  assert.equal((await stat(pushRecordPath(config.pushesDir, key))).mode & 0o777, 0o600);
  assert.equal((await stat(join(config.pushesDir, REPO))).mode & 0o777, 0o700);
});

test("a write that fails leaves no temp file in the record folder", async () => {
  const key = { repo: REPO, branch: BRANCH };
  const blocker = join(pushRecordPath(config.pushesDir, key), "x");
  await mkdir(blocker, { recursive: true });
  await assert.rejects(writePushRecord(config.pushesDir, key, "a".repeat(40)));
  assert.deepEqual(await readdir(join(config.pushesDir, REPO)), [encodeURIComponent(BRANCH)]);
  assert.deepEqual(await readdir(pushRecordPath(config.pushesDir, key)), ["x"]);
  assert.deepEqual(await readPushRecord(config.pushesDir, key), { kind: "unreadable" });
});

test("the record survives a gh-broker restart", async () => {
  const head = await commit(work, "a.txt", BRANCH);
  const pushed = brokerProcess({ verb: "push", repo: REPO, branch: BRANCH, sha: head, bundle_b64: bundleOf(work, BRANCH) });
  assert.equal(pushed.exit, 0, JSON.stringify(pushed));
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: BRANCH }), { kind: "pushed", sha: head });
});
