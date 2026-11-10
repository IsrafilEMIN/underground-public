export const VERBS = ["sync", "push", "pr-create", "pr-status", "ci-log"] as const;
export type Verb = (typeof VERBS)[number];

export const MAX_REQUEST_BYTES = 360 * 1024 * 1024;
const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 65536;
const MAX_PR_NUMBER = 2147483647;
export const MAX_CI_LOG_BYTES = 64 * 1024;
export const MAX_SYNC_HAVES = 16;

export type SyncRequest = { verb: "sync"; repo: string; pr?: number; have?: string[]; cached?: true };
export type PushRequest = { verb: "push"; repo: string; branch: string; sha: string; bundle_b64: string };
export type PrCreateRequest = { verb: "pr-create"; repo: string; head: string; title: string; body: string };
export type PrStatusRequest = { verb: "pr-status"; repo: string; number: number };
export type CiLogRequest = { verb: "ci-log"; repo: string; number: number };
export type Request = SyncRequest | PushRequest | PrCreateRequest | PrStatusRequest | CiLogRequest;

export type ResultReply = { exit: number; stdout: string; stderr: string };
export type SyncReply = ResultReply & { branch: string; head: string; bundle_b64?: string };
export type SyncPrReply = ResultReply & { pr: number; head: string; bundle_b64: string };
export type RefusedReply = { exit: 2; refused: string };
export type Reply = ResultReply | RefusedReply;

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const AGENT_BRANCH_RE = /^(?:agent|wt)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const DEFAULT_BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

function isVerb(value: unknown): value is Verb {
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
      const { pr, have, cached } = input;
      if (pr !== undefined) {
        if (!isPrNumber(pr)) return fail("invalid PR number");
        if (have !== undefined || cached !== undefined) return fail("a PR sync takes no have and no cached");
        return { ok: true, value: { verb, repo, pr } };
      }
      if (cached !== undefined && cached !== true) return fail("cached must be true when present");
      const flags = cached === true ? { cached } : {};
      if (have === undefined) return { ok: true, value: { verb, repo, ...flags } };
      if (!Array.isArray(have) || have.length > MAX_SYNC_HAVES || !have.every(isSha)) return fail(`have must be at most ${MAX_SYNC_HAVES} full 40-hex commit shas`);
      return { ok: true, value: { verb, repo, have, ...flags } };
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
  }
}

export function isReply(value: unknown): value is Reply & Record<string, unknown> {
  if (!isRecord(value) || typeof value.exit !== "number" || !Number.isInteger(value.exit)) return false;
  if (typeof value.refused === "string") return value.exit === 2;
  return typeof value.stdout === "string" && typeof value.stderr === "string";
}

export function isSyncReply(value: unknown): value is SyncReply {
  return (
    isReply(value) &&
    !("refused" in value) &&
    isDefaultBranchName(value.branch) &&
    isSha(value.head) &&
    (value.bundle_b64 === undefined || isBundleB64(value.bundle_b64))
  );
}

export function isSyncPrReply(value: unknown): value is SyncPrReply {
  return (
    isReply(value) &&
    !("refused" in value) &&
    isPrNumber(value.pr) &&
    isSha(value.head) &&
    isBundleB64(value.bundle_b64)
  );
}

export type PushRecord = { kind: "pushed"; sha: string } | { kind: "none" } | { kind: "unreadable" };

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
