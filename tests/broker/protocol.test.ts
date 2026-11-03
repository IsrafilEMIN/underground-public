import assert from "node:assert/strict";
import { test } from "node:test";
import { failedPullRequestRuns, mergeRefusal, reviewHeadRefusal, validateRequest } from "../../host/broker/protocol.ts";
import type { MergeInputs, ReviewRecord, ReviewerRole } from "../../host/broker/protocol.ts";

const REPO = "o/r";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const BUNDLE = "UEFDSw==";

const VALID = {
  sync: { verb: "sync", repo: REPO },
  push: { verb: "push", repo: REPO, branch: "agent/task", sha: HEAD, bundle_b64: BUNDLE },
  "pr-create": { verb: "pr-create", repo: REPO, head: "agent/task", title: "Fix the thing", body: "Body text." },
  "pr-status": { verb: "pr-status", repo: REPO, number: 7 },
  "ci-log": { verb: "ci-log", repo: REPO, number: 7 },
  review: { verb: "review", repo: REPO, number: 7, sha: HEAD, role: "security-review", verdict: "block", reason: "planted defect" },
  merge: { verb: "merge", repo: REPO, number: 7 },
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
  accepts(VALID.merge);
});

test("a request for a malformed repo name is refused, for every verb", () => {
  for (const verb of Object.keys(VALID) as VerbName[]) {
    for (const repo of ["o", "o/r/x", "o/r x", "", 7, undefined]) refuses(withField(verb, "repo", repo), /invalid repo/);
  }
  accepts(withField("merge", "repo", "own-er/re.po_1"));
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

test("pr-create refuses a head that is not an agent/* branch", () => {
  for (const head of ["main", "feature/x", "agent", "agent/", 7]) refuses(withField("pr-create", "head", head), /head is not an agent branch/);
  accepts(withField("pr-create", "head", "agent/x/y"));
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

test("pr-status, ci-log, review and merge refuse a PR number that is not a positive integer up to 2^31-1", () => {
  for (const verb of ["pr-status", "ci-log", "review", "merge"] as const) {
    for (const number of [0, -3, 2.5, "7", 2147483648, undefined]) refuses(withField(verb, "number", number), /invalid PR number/);
    accepts(withField(verb, "number", 2147483647));
  }
});

test("review refuses a sha that is not 40 lowercase hex characters", () => {
  for (const sha of ["a".repeat(41), "HEAD", undefined]) refuses(withField("review", "sha", sha), /invalid sha/);
  accepts(withField("review", "sha", OTHER));
});

test("review refuses a verdict other than pass, manual or block", () => {
  for (const verdict of ["approve", "PASS", "", undefined]) refuses(withField("review", "verdict", verdict), /verdict must be pass, manual or block/);
  for (const verdict of ["pass", "block"]) accepts(withField("review", "verdict", verdict));
  accepts({ ...VALID.review, role: "risk-review", verdict: "manual", reason: "needs a human" });
});

// Since 2026-11-03 a review names its reviewer role in the request: no socket says who asks.
test("review refuses a role that is not one of the three reviewer roles", () => {
  for (const role of ["author", "Code-Review", "codereview", "", undefined, 7]) refuses(withField("review", "role", role), /role must be code-review, security-review, risk-review/);
  for (const role of ["code-review", "security-review"]) accepts(withField("review", "role", role));
});

test("review refuses a verdict that its role cannot give", () => {
  for (const role of ["code-review", "security-review"]) refuses({ ...VALID.review, role, verdict: "manual" }, new RegExp(`${role} cannot give manual: use pass or block`));
  refuses({ ...VALID.review, role: "risk-review", verdict: "block" }, /risk-review cannot give block: use pass or manual/);
});

test("review refuses a manual or block with a blank reason, and accepts a pass with an empty reason", () => {
  for (const [role, verdict] of [["risk-review", "manual"], ["security-review", "block"]]) {
    for (const reason of ["", "  \n "]) refuses({ ...VALID.review, role, verdict, reason }, /invalid reason/);
    accepts({ ...VALID.review, role, verdict, reason: "why" });
  }
  accepts({ ...VALID.review, verdict: "pass", reason: "" });
});

test("review refuses a reason over 2000 characters, with NUL, or not a string, for every verdict", () => {
  for (const [role, verdict] of [["code-review", "pass"], ["risk-review", "manual"], ["security-review", "block"]]) {
    for (const reason of ["x".repeat(2001), "a\0b", 7, undefined]) refuses({ ...VALID.review, role, verdict, reason }, /invalid reason/);
    accepts({ ...VALID.review, role, verdict, reason: "x".repeat(2000) });
  }
});

function pass(role: ReviewerRole): ReviewRecord {
  return { repo: REPO, pr: 7, role_name: role, role, head: HEAD, verdict: "pass", reason: "", at: "2026-11-01T00:00:00Z" };
}

const GREEN_CHECK = { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" };

function gate(over: Partial<MergeInputs> = {}): MergeInputs {
  return {
    repo: REPO,
    pr: 7,
    branch: "agent/task",
    head: HEAD,
    pushed: { kind: "pushed", sha: HEAD },
    checks: [GREEN_CHECK],
    records: { kind: "records", records: [pass("code-review"), pass("security-review"), pass("risk-review")] },
    files: ["src/a.ts"],
    protectedGlobs: [],
    ...over,
  };
}

test("the merge gate lets through a head with green checks, its push record, and a pass from all three roles", () => {
  assert.equal(mergeRefusal(gate()), undefined);
});

test("the merge gate refuses a head with no checks reported", () => {
  for (const checks of [[], undefined, null, {}]) assert.match(mergeRefusal(gate({ checks })) ?? "", /no checks reported/);
  assert.equal(mergeRefusal(gate({ checks: [GREEN_CHECK] })), undefined);
});

test("the merge gate refuses a check entry it cannot read", () => {
  for (const bad of [null, "ci", 7, [GREEN_CHECK]]) assert.match(mergeRefusal(gate({ checks: [GREEN_CHECK, bad] })) ?? "", /cannot read checks/);
  assert.equal(mergeRefusal(gate({ checks: [GREEN_CHECK, GREEN_CHECK] })), undefined);
});

test("the merge gate refuses a check that is still pending or in progress, and names it", () => {
  const running = { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null };
  const queued = { __typename: "CheckRun", name: "lint", status: "QUEUED", conclusion: null };
  const pendingStatus = { __typename: "StatusContext", context: "deploy/preview", state: "PENDING" };
  assert.match(mergeRefusal(gate({ checks: [GREEN_CHECK, running] })) ?? "", /check lint is IN_PROGRESS/);
  assert.match(mergeRefusal(gate({ checks: [GREEN_CHECK, queued] })) ?? "", /check lint is QUEUED/);
  assert.match(mergeRefusal(gate({ checks: [GREEN_CHECK, pendingStatus] })) ?? "", /check deploy\/preview is PENDING/);
  assert.equal(mergeRefusal(gate({ checks: [GREEN_CHECK, { ...running, status: "COMPLETED", conclusion: "SUCCESS" }] })), undefined);
});

test("the merge gate reads a commit status from its state: SUCCESS passes, FAILURE refuses", () => {
  const status = { __typename: "StatusContext", context: "ext/ci", state: "SUCCESS" };
  assert.equal(mergeRefusal(gate({ checks: [GREEN_CHECK, status] })), undefined);
  assert.match(mergeRefusal(gate({ checks: [GREEN_CHECK, { ...status, state: "FAILURE" }] })) ?? "", /check ext\/ci is FAILURE/);
});

test("the merge gate refuses when the changed files of the PR cannot be read", () => {
  assert.match(mergeRefusal(gate({ files: undefined })) ?? "", /changed files cannot be read/);
  assert.equal(mergeRefusal(gate({ files: [] })), undefined);
});

const PR = { isCrossRepository: false, headRefName: "agent/task", headRefOid: HEAD };

test("a review of the PR head of an agent branch in the same repo is let through", () => {
  assert.equal(reviewHeadRefusal(PR, HEAD), undefined);
});

test("a review of a PR whose head is in another repo, or is not an agent branch, is refused", () => {
  assert.match(reviewHeadRefusal({ ...PR, isCrossRepository: true }, HEAD) ?? "", /not in the same repo/);
  assert.match(reviewHeadRefusal({ ...PR, isCrossRepository: undefined }, HEAD) ?? "", /not in the same repo/);
  assert.match(reviewHeadRefusal({ ...PR, headRefName: "main" }, HEAD) ?? "", /not an agent branch/);
  assert.match(reviewHeadRefusal({ ...PR, headRefName: "agent/a..b" }, HEAD) ?? "", /not an agent branch/);
});

test("a review of a sha that is no longer the PR head is refused, and names both commits", () => {
  const refusal = reviewHeadRefusal({ ...PR, headRefOid: OTHER }, HEAD) ?? "";
  assert.ok(refusal.includes(OTHER) && refusal.includes(HEAD), refusal);
  assert.equal(reviewHeadRefusal({ ...PR, headRefOid: OTHER }, OTHER), undefined);
});

test("a review is refused when the PR head commit cannot be read", () => {
  for (const headRefOid of [undefined, null, "HEAD", HEAD.toUpperCase()]) {
    assert.notEqual(reviewHeadRefusal({ ...PR, headRefOid }, HEAD), undefined, String(headRefOid));
  }
  assert.equal(reviewHeadRefusal(PR, HEAD), undefined);
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
