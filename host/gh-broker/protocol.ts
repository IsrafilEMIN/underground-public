export const VERBS = ["sync", "push", "pr-create", "pr-status", "ci-log", "review", "merge"] as const;
export type Verb = (typeof VERBS)[number];

export const MAX_REQUEST_BYTES = 360 * 1024 * 1024;
export const MAX_TITLE_CHARS = 256;
export const MAX_BODY_CHARS = 65536;
export const MAX_PR_NUMBER = 2147483647;
export const MAX_REASON_CHARS = 2000;
export const MAX_CI_LOG_BYTES = 64 * 1024;
export const MAX_SYNC_HAVES = 16;

export const VERDICTS = ["pass", "manual", "block"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const REVIEWER_ROLES = ["code-review", "security-review", "risk-review"] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];
export const ROLE_VERDICTS: Record<ReviewerRole, readonly Verdict[]> = {
  "code-review": ["pass", "block"],
  "security-review": ["pass", "block"],
  "risk-review": ["pass", "manual"],
};

export type SyncRequest = { verb: "sync"; repo: string; pr?: number; have?: string[] };
export type PushRequest = { verb: "push"; repo: string; branch: string; sha: string; bundle_b64: string };
export type PrCreateRequest = { verb: "pr-create"; repo: string; head: string; title: string; body: string };
export type PrStatusRequest = { verb: "pr-status"; repo: string; number: number };
export type CiLogRequest = { verb: "ci-log"; repo: string; number: number };
export type MergeRequest = { verb: "merge"; repo: string; number: number };

export type ReviewRequest = { verb: "review"; repo: string; number: number; sha: string; role: ReviewerRole; verdict: Verdict; reason: string };
export type Request =
  | SyncRequest
  | PushRequest
  | PrCreateRequest
  | PrStatusRequest
  | CiLogRequest
  | ReviewRequest
  | MergeRequest;

export type ReviewRecord = { repo: string; pr: number; role: ReviewerRole; head: string; verdict: Verdict; reason: string; at: string };
export type ReviewRecords = { kind: "records"; records: ReviewRecord[] } | { kind: "unreadable" };

export type ResultReply = { exit: number; stdout: string; stderr: string };
export type SyncReply = ResultReply & { branch: string; head: string; bundle_b64?: string };
export type SyncPrReply = ResultReply & { pr: number; head: string; bundle_b64: string };
export type MergeReply = ResultReply & { merged: { branch: string; head: string } };
export type RefusedReply = { exit: 2; refused: string };
export type Reply = ResultReply | RefusedReply;

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const AGENT_BRANCH_RE = /^(?:agent|wt)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const DEFAULT_BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

export function isVerb(value: unknown): value is Verb {
  return typeof value === "string" && (VERBS as readonly string[]).includes(value);
}

export function isRepo(value: unknown): value is string {
  if (typeof value !== "string" || !REPO_RE.test(value)) return false;
  const name = value.slice(value.indexOf("/") + 1);
  return !name.startsWith(".");
}

export function isAgentBranch(value: unknown): value is string {
  if (typeof value !== "string" || !AGENT_BRANCH_RE.test(value)) return false;
  if (value.includes("..")) return false;
  return value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

export function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA_RE.test(value);
}

export function isPrNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_PR_NUMBER;
}

export function parsePrNumber(text: string): number | undefined {
  if (!/^[1-9][0-9]{0,9}$/.test(text)) return undefined;
  const n = Number(text);
  return isPrNumber(n) ? n : undefined;
}

export function isTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TITLE_CHARS && !/[\r\n\0]/.test(value);
}

export function isBody(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_BODY_CHARS && !value.includes("\0");
}

export function isBundleB64(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length % 4 === 0 && BASE64_RE.test(value);
}

export function isDefaultBranchName(value: unknown): value is string {
  return typeof value === "string" && DEFAULT_BRANCH_RE.test(value) && !value.includes("..");
}

export function parseRemoteHead(text: string): { branch: string; head: string } | undefined {
  let branch: string | undefined;
  let head: string | undefined;
  for (const line of text.split("\n")) {
    const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (symref !== null) branch = symref[1];
    const tip = /^(\S+)\tHEAD$/.exec(line);
    if (tip !== null) head = tip[1];
  }
  return isDefaultBranchName(branch) && isSha(head) ? { branch, head } : undefined;
}

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

export function isReviewerRole(value: unknown): value is ReviewerRole {
  return typeof value === "string" && (REVIEWER_ROLES as readonly string[]).includes(value);
}

export function isReason(verdict: Verdict, value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_REASON_CHARS || value.includes("\0")) return false;
  return verdict === "pass" || value.trim().length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail<T>(reason: string): Checked<T> {
  return { ok: false, reason };
}

export function validateRequest(input: unknown): Checked<Request> {
  if (!isRecord(input)) return fail("request is not a JSON object");
  const verb = input.verb;
  if (!isVerb(verb)) return fail("unknown verb");
  const repo = input.repo;
  if (!isRepo(repo)) return fail("invalid repo");
  switch (verb) {
    case "sync": {
      const { pr, have } = input;
      if (pr !== undefined) {
        if (!isPrNumber(pr)) return fail("invalid PR number");
        if (have !== undefined) return fail("a PR sync takes no have");
        return { ok: true, value: { verb, repo, pr } };
      }
      if (have === undefined) return { ok: true, value: { verb, repo } };
      if (!Array.isArray(have) || have.length > MAX_SYNC_HAVES || !have.every(isSha)) return fail(`have must be at most ${MAX_SYNC_HAVES} full 40-hex commit shas`);
      return { ok: true, value: { verb, repo, have } };
    }
    case "push": {
      const { branch, sha, bundle_b64 } = input;
      if (!isAgentBranch(branch)) return fail("branch is not an agent branch");
      if (!isSha(sha)) return fail("invalid sha");
      if (!isBundleB64(bundle_b64)) return fail("invalid bundle");
      return { ok: true, value: { verb, repo, branch, sha, bundle_b64 } };
    }
    case "pr-create": {
      const { head, title, body } = input;
      if (!isAgentBranch(head)) return fail("head is not an agent branch");
      if (!isTitle(title)) return fail("invalid title");
      if (!isBody(body)) return fail("invalid or too large body");
      return { ok: true, value: { verb, repo, head, title, body } };
    }
    case "pr-status":
    case "ci-log": {
      const { number } = input;
      if (!isPrNumber(number)) return fail("invalid PR number");
      return { ok: true, value: { verb, repo, number } };
    }
    case "review": {
      const { number, sha, role, verdict, reason } = input;
      if (!isPrNumber(number)) return fail("invalid PR number");
      if (!isSha(sha)) return fail("invalid sha");
      if (!isReviewerRole(role)) return fail(`role must be ${REVIEWER_ROLES.join(", ")}`);
      if (!isVerdict(verdict)) return fail("verdict must be pass, manual or block");
      if (!ROLE_VERDICTS[role].includes(verdict)) return fail(`${role} cannot give ${verdict}: use ${ROLE_VERDICTS[role].join(" or ")}`);
      if (!isReason(verdict, reason)) return fail(`invalid reason (required for manual and block, at most ${MAX_REASON_CHARS} characters)`);
      return { ok: true, value: { verb, repo, number, sha, role, verdict, reason } };
    }
    case "merge": {
      const { number } = input;
      if (!isPrNumber(number)) return fail("invalid PR number");
      return { ok: true, value: { verb, repo, number } };
    }
  }
}

export function isReply(value: unknown): value is Reply {
  if (!isRecord(value) || typeof value.exit !== "number" || !Number.isInteger(value.exit)) return false;
  if (typeof value.refused === "string") return value.exit === 2;
  return typeof value.stdout === "string" && typeof value.stderr === "string";
}

export function isSyncReply(value: unknown): value is SyncReply {
  return (
    isReply(value) &&
    !("refused" in value) &&
    isRecord(value) &&
    isDefaultBranchName(value.branch) &&
    isSha(value.head) &&
    (value.bundle_b64 === undefined || isBundleB64(value.bundle_b64))
  );
}

export function isSyncPrReply(value: unknown): value is SyncPrReply {
  return (
    isReply(value) &&
    !("refused" in value) &&
    isRecord(value) &&
    isPrNumber(value.pr) &&
    isSha(value.head) &&
    isBundleB64(value.bundle_b64)
  );
}

export function isMergeReply(value: unknown): value is MergeReply {
  if (!isReply(value) || "refused" in value || !isRecord(value) || !isRecord(value.merged)) return false;
  return isAgentBranch(value.merged.branch) && isSha(value.merged.head);
}

export type PushRecord = { kind: "pushed"; sha: string } | { kind: "none" } | { kind: "unreadable" };

export type MergeInputs = {
  repo: string;
  pr: number;
  branch: string;
  head: string;
  pushed: PushRecord;
  checks: unknown;
  records: ReviewRecords;
  files: string[] | undefined;
  protectedGlobs: string[];
};

function pushedRefusal(branch: string, head: string, pushed: PushRecord): string | undefined {
  switch (pushed.kind) {
    case "pushed":
      return pushed.sha === head ? undefined : `the gh-broker did not push it: the last gh-broker push to ${branch} is ${pushed.sha}`;
    case "none":
      return `the gh-broker has no push record for ${branch}`;
    case "unreadable":
      return `the push record of ${branch} cannot be read`;
    default: {
      const _exhaustive: never = pushed;
      return _exhaustive;
    }
  }
}

function checksRefusal(checks: unknown): string | undefined {
  if (!Array.isArray(checks) || checks.length === 0) return "no checks reported for the head commit";
  for (const check of checks) {
    if (!isRecord(check)) return "cannot read checks";
    const name = String(check.name ?? check.context ?? "unnamed check");
    const result = check.__typename === "StatusContext" ? check.state : check.status === "COMPLETED" ? check.conclusion : check.status;
    if (result !== "SUCCESS") return `check ${name} is ${String(result)}`;
  }
  return undefined;
}

export function globRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else {
      re += glob[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export function parseProtectedPaths(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^\/+/, ""))
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function isProtectedPath(path: string, globs: string[]): boolean {
  if (path.startsWith(".github/") || path.split("/").at(-1) === "CODEOWNERS") return true;
  return globs.some((glob) => globRegExp(glob).test(path));
}

function hasRecordFields(value: unknown): value is Omit<ReviewRecord, "role"> {
  return (
    isRecord(value) &&
    isRepo(value.repo) &&
    isPrNumber(value.pr) &&
    isSha(value.head) &&
    isVerdict(value.verdict) &&
    typeof value.reason === "string" &&
    typeof value.at === "string" &&
    Number.isFinite(Date.parse(value.at))
  );
}

export function parseReviewRecord(value: unknown): ReviewRecord | undefined {
  if (!hasRecordFields(value) || !isRecord(value)) return undefined;
  const role = value.role;
  if (!isReviewerRole(role)) return undefined;
  return { repo: value.repo, pr: value.pr, role, head: value.head, verdict: value.verdict, reason: value.reason, at: value.at };
}

export const ATTEMPTS_BEFORE_HOLD = 3;

export type Hold =
  | { kind: "manual"; record: ReviewRecord }
  | { kind: "attempt"; attempt: number; record: ReviewRecord }
  | { kind: "protected-path"; path: string };

export function attempts(records: ReviewRecord[]): ReviewRecord[] {
  const firstBlocks = new Map<string, ReviewRecord>();
  for (const record of records) {
    if (record.verdict === "block" && !firstBlocks.has(record.head)) firstBlocks.set(record.head, record);
  }
  return [...firstBlocks.values()];
}

export function holds(records: ReviewRecord[], protectedFiles: string[]): Hold[] {
  return [
    ...records.filter((record) => record.verdict === "manual").map((record): Hold => ({ kind: "manual", record })),
    ...attempts(records)
      .map((record, index): Hold => ({ kind: "attempt", attempt: index + 1, record }))
      .slice(ATTEMPTS_BEFORE_HOLD),
    ...protectedFiles.map((path): Hold => ({ kind: "protected-path", path })),
  ];
}

function holdRefusal(hold: Hold): string {
  const prefix = "a hold refuses, so the owner merges this PR on GitHub";
  switch (hold.kind) {
    case "manual":
      return `${prefix}: ${hold.record.role} asked for manual review of ${hold.record.head} at ${hold.record.at}: ${hold.record.reason}`;
    case "attempt":
      return `${prefix}: attempt ${hold.attempt} (${hold.record.head}) got a block at ${hold.record.at} from ${hold.record.role}: ${hold.record.reason}`;
    case "protected-path":
      return `${prefix}: protected path ${hold.path} changed`;
    default: {
      const _exhaustive: never = hold;
      return _exhaustive;
    }
  }
}

function headVerdictRefusal(records: ReviewRecord[], head: string): string | undefined {
  const onHead = records.filter((record) => record.head === head);
  const block = onHead.find((record) => record.verdict === "block");
  if (block !== undefined) return `${block.role} blocks it: ${block.reason}`;
  for (const role of REVIEWER_ROLES) {
    const latest = onHead.filter((record) => record.role === role).at(-1);
    if (latest === undefined) return `${role} has no verdict on it`;
    if (latest.verdict !== "pass") return `the latest ${role} verdict on it is ${latest.verdict}`;
  }
  return undefined;
}

export function mergeRefusal(input: MergeInputs): string | undefined {
  const checks = checksRefusal(input.checks);
  if (checks !== undefined) return checks;
  const pushed = pushedRefusal(input.branch, input.head, input.pushed);
  if (pushed !== undefined) return pushed;
  if (input.records.kind === "unreadable") return "cannot read review records";
  if (input.files === undefined) return "the changed files cannot be read";
  const records = input.records.records.filter((r) => r.repo === input.repo && r.pr === input.pr);
  const protectedFiles = input.files.filter((f) => isProtectedPath(f, input.protectedGlobs));
  const hold = holds(records, protectedFiles).at(0);
  if (hold !== undefined) return holdRefusal(hold);
  return headVerdictRefusal(records, input.head);
}

export function prHeadRefusal(pr: Record<string, unknown>): string | undefined {
  if (pr.isCrossRepository !== false) return "pull request head is not in the same repo";
  if (!isAgentBranch(pr.headRefName)) return "pull request head is not an agent branch";
  return undefined;
}

export type FailedRun = { id: number; name: string };

export function failedPullRequestRuns(pages: unknown, head: string): Checked<FailedRun[]> {
  if (!Array.isArray(pages)) return fail("cannot read the workflow runs");
  const runs: FailedRun[] = [];
  for (const page of pages) {
    if (!isRecord(page) || !Array.isArray(page.workflow_runs)) return fail("cannot read the workflow runs");
    for (const run of page.workflow_runs) {
      if (!isRecord(run) || typeof run.id !== "number" || typeof run.name !== "string") return fail("cannot read the workflow runs");
      if (run.event !== "pull_request" || run.head_sha !== head || run.status !== "completed") continue;
      if (run.conclusion !== "failure" && run.conclusion !== "timed_out") continue;
      runs.push({ id: run.id, name: run.name });
    }
  }
  return { ok: true, value: runs };
}

export function tailLog(text: string, bytes: number): { text: string; cut: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= bytes) return { text, cut: false };
  let tail = buffer.subarray(buffer.byteLength - bytes).toString("utf8");
  const newline = tail.indexOf("\n");
  if (newline !== -1 && newline < tail.length - 1) tail = tail.slice(newline + 1);
  return { text: tail, cut: true };
}

export function reviewHeadRefusal(pr: Record<string, unknown>, sha: string): string | undefined {
  const refusal = prHeadRefusal(pr);
  if (refusal !== undefined) return refusal;
  if (!isSha(pr.headRefOid)) return "cannot read pull request head commit";
  if (pr.headRefOid !== sha) return `PR head is ${pr.headRefOid}, not the reviewed ${sha}`;
  return undefined;
}
