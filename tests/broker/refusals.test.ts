import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Reply } from "../../host/gh-broker/protocol.ts";
import { readPushRecord } from "../../host/gh-broker/push-record.ts";
import { handleRequest } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import { tempDir } from "../temp.ts";
import { BRANCH, REPO, brokerConfig, bundleOf, commit, git, initMirror, initRepo, remoteRef, request, seedMain } from "./fixture.ts";

const OTHER_REPO = "o/other";

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

function push(branch: string, sha: string): Promise<Reply> {
  return request(config, { verb: "push", branch, sha, bundle_b64: bundleOf(work, branch) });
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
  config = await brokerConfig(root, FAKE_GH);
  await writeFile(join(config.home, "default-branch"), "main");
  remote = initRepo(join(root, "remote.git"), true);
  initMirror(config, remote);
  work = initRepo(join(root, "work"));
  const base = await seedMain(work, remote);
  assert.equal(remoteRef(remote, "main"), base);
});

afterEach(async () => {
  await chmod(join(config.pushesDir, REPO), 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

test("a push to main is refused, and main on GitHub and the push records stay unchanged", async () => {
  const base = remoteRef(remote, "main");
  const head = await commit(work, "a.txt", "main");

  assertRefused(await push("main", head));
  assert.equal(remoteRef(remote, "main"), base);
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: "main" }), { kind: "none" });
});

test("a push to a branch that is not agent/* is refused and lands nothing on GitHub", async () => {
  const head = await commit(work, "a.txt", "feature/x");

  assertRefused(await push("feature/x", head));
  assert.equal(remoteRef(remote, "feature/x"), "");
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: "feature/x" }), { kind: "none" });
});

test("a push to the default branch is refused even when its name is agent/*, while another agent branch pushes", async () => {
  await writeFile(join(config.home, "default-branch"), "agent/main");
  const base = git(work, "rev-parse", "main");
  git(work, "push", "--quiet", remote, "main:agent/main");
  const head = await commit(work, "a.txt", "agent/main");

  assertRefused(await push("agent/main", head));
  assert.equal(remoteRef(remote, "agent/main"), base);
  assert.deepEqual(await readPushRecord(config.pushesDir, { repo: REPO, branch: "agent/main" }), { kind: "none" });

  const other = await commit(work, "b.txt", BRANCH);
  const pushed = await push(BRANCH, other);
  assert.equal(pushed.exit, 0, JSON.stringify(pushed));
  assert.equal(remoteRef(remote, BRANCH), other);
});

test("a push whose record cannot be written fails and says the branch cleanup will not delete the branch", async () => {
  const first = await commit(work, "a.txt", BRANCH);
  const one = await push(BRANCH, first);
  assert.equal(one.exit, 0, JSON.stringify(one));
  const second = await commit(work, "b.txt", BRANCH);

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
  const head = await commit(work, "a.txt", BRANCH);
  assert.equal((await push(BRANCH, head)).exit, 0);

  const reply = await request(config, { verb: "pr-create", head: BRANCH, title: "Fix the thing", body: "Line one\nLine two\n" });
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
  const head = await commit(work, "a.txt", BRANCH);
  const bundle = bundleOf(work, BRANCH);
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
