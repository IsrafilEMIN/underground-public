import assert from "node:assert/strict";
import { test } from "node:test";
import { failedPullRequestRuns, validateRequest } from "../../host/gh-broker/protocol.ts";

const REPO = "o/r";
const HEAD = "a".repeat(40);
const BUNDLE = "UEFDSw==";

const VALID = {
  sync: { verb: "sync", repo: REPO },
  push: { verb: "push", repo: REPO, branch: "agent/task", sha: HEAD, bundle_b64: BUNDLE },
  "pr-create": { verb: "pr-create", repo: REPO, head: "agent/task", title: "Fix the thing", body: "Body text." },
  "pr-status": { verb: "pr-status", repo: REPO, number: 7 },
  "ci-log": { verb: "ci-log", repo: REPO, number: 7 },
} as const;

type VerbName = keyof typeof VALID;

function accepts(request: Record<string, unknown>): void {
  assert.deepEqual(validateRequest(request), { ok: true, value: request });
}

function refuses(request: unknown, reason: RegExp): void {
  const result = validateRequest(request);
  assert.equal(result.ok, false, `accepted ${JSON.stringify(request)}`);
  if (!result.ok) assert.match(result.reason, reason);
}

function withField(verb: VerbName, field: string, value: unknown): Record<string, unknown> {
  return { ...VALID[verb], [field]: value };
}

test("a well-formed request of each verb is accepted with its fields", () => {
  for (const request of Object.values(VALID)) accepts(request);
  accepts({ verb: "sync", repo: REPO, pr: 7 });
});

test("a request that is not a JSON object is refused", () => {
  for (const input of [null, "sync o/r", 7, [VALID.sync]]) refuses(input, /not a JSON object/);
  accepts(VALID.sync);
});

test("a request with an unknown or missing verb is refused", () => {
  refuses({ verb: "delete", repo: REPO, number: 7 }, /unknown verb/);
  refuses({ repo: REPO }, /unknown verb/);
  accepts(VALID["pr-status"]);
});

test("a request for a malformed repo name is refused, for every verb", () => {
  for (const verb of Object.keys(VALID) as VerbName[]) {
    for (const repo of ["o", "o/r/x", "o/r x", "", 7, undefined]) refuses(withField(verb, "repo", repo), /invalid repo/);
  }
  accepts(withField("pr-status", "repo", "own-er/re.po_1"));
});

test("a repo name that starts with '.' is refused, and one with a '.' inside is accepted", () => {
  refuses(withField("sync", "repo", "o/.github"), /invalid repo/);
  refuses(withField("sync", "repo", "o/.."), /invalid repo/);
  accepts(withField("sync", "repo", "o/r.github"));
});

test("sync --pr refuses a PR number that is not a positive integer up to 2^31-1", () => {
  for (const pr of [0, -1, 1.5, "7", 2147483648]) refuses({ ...VALID.sync, pr }, /invalid PR number/);
  accepts({ ...VALID.sync, pr: 2147483647 });
});

test("push refuses a sha that is not 40 lowercase hex characters", () => {
  for (const sha of ["a".repeat(39), "A".repeat(40), "g".repeat(40), undefined]) refuses(withField("push", "sha", sha), /invalid sha/);
  accepts(withField("push", "sha", "0123456789abcdef".repeat(2) + "01234567"));
});

test("push refuses a bundle that is empty or not base64", () => {
  for (const bundle of ["", "UEFDSw", "UEFD Sw==", "UEFDSw===", 7]) refuses(withField("push", "bundle_b64", bundle), /invalid bundle/);
  accepts(withField("push", "bundle_b64", "UEFDSw=="));
});

test("an agent branch with '..' is refused for push and pr-create, and one with a single '.' is accepted", () => {
  refuses(withField("push", "branch", "agent/a..b"), /not an agent branch/);
  refuses(withField("pr-create", "head", "agent/a..b"), /not an agent branch/);
  accepts(withField("push", "branch", "agent/a.b"));
  accepts(withField("pr-create", "head", "agent/a.b"));
});

test("an agent branch with a component that starts with '.' or ends with '.lock' is refused", () => {
  for (const branch of ["agent/.hidden", "agent/x/.hidden", "agent/task.lock", "agent/task.lock/x"]) {
    refuses(withField("push", "branch", branch), /not an agent branch/);
    refuses(withField("pr-create", "head", branch), /not an agent branch/);
  }
  accepts(withField("push", "branch", "agent/x/task.locked"));
  accepts(withField("pr-create", "head", "agent/x/task.locked"));
});

test("pr-create refuses a head that is neither an agent branch nor a wt branch", () => {
  for (const head of ["main", "feature/x", "agent", "agent/", "wt", "wt/", "wtx/a", 7]) refuses(withField("pr-create", "head", head), /head is not an agent branch/);
  accepts(withField("pr-create", "head", "agent/x/y"));
  accepts(withField("pr-create", "head", "wt/20261103-201235"));
  accepts(withField("push", "branch", "wt/20261103-201235"));
});

test("pr-create refuses a blank title, and a title with a line break or NUL", () => {
  for (const title of ["", "   ", "a\nb", "a\rb", "a\0b", "x".repeat(257), 7]) refuses(withField("pr-create", "title", title), /invalid title/);
  accepts(withField("pr-create", "title", "x".repeat(256)));
});

test("pr-create refuses a body over 65536 characters or with NUL, and accepts an empty body or one of exactly 65536", () => {
  for (const body of ["x".repeat(65537), "a\0b", undefined]) refuses(withField("pr-create", "body", body), /invalid or too large body/);
  accepts(withField("pr-create", "body", "x".repeat(65536)));
  accepts(withField("pr-create", "body", ""));
});

test("pr-status and ci-log refuse a PR number that is not a positive integer up to 2^31-1", () => {
  for (const verb of ["pr-status", "ci-log"] as const) {
    for (const number of [0, -3, 2.5, "7", 2147483648, undefined]) refuses(withField(verb, "number", number), /invalid PR number/);
    accepts(withField(verb, "number", 2147483647));
  }
});

function run(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: `wf${id}`, event: "pull_request", head_sha: HEAD, status: "completed", conclusion: "failure", ...over };
}

test("failedPullRequestRuns refuses a page without a workflow_runs list", () => {
  for (const page of [null, "x", {}, { workflow_runs: "x" }, { workflow_runs: { 0: run(1) } }]) {
    assert.deepEqual(failedPullRequestRuns([{ workflow_runs: [run(1)] }, page], HEAD), { ok: false, reason: "cannot read the workflow runs" });
  }
  assert.deepEqual(failedPullRequestRuns([{ workflow_runs: [run(1)] }, { workflow_runs: [run(2)] }], HEAD), {
    ok: true,
    value: [
      { id: 1, name: "wf1" },
      { id: 2, name: "wf2" },
    ],
  });
});

test("failedPullRequestRuns drops a run that has not completed, even when it already carries a failure", () => {
  const pages = [{ workflow_runs: [run(1), run(2, { status: "in_progress" }), run(3, { status: "queued" })] }];
  assert.deepEqual(failedPullRequestRuns(pages, HEAD), { ok: true, value: [{ id: 1, name: "wf1" }] });
});
