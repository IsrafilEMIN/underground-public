import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isAgentBranch,
  isSha,
  isVerdict,
  isReviewerRole,
  isMergeReply,
  isReply,
  isSyncPrReply,
  isSyncReply,
  isRepo,
  parsePrNumber,
  REVIEWER_ROLES,
  validateRequest,
} from "./protocol.ts";
import type { MergeReply, Reply, Request, SyncPrReply, SyncReply } from "./protocol.ts";

export const SOCKET_ENV = "UG_GH_BROKER_SOCKET";

const EXIT_USAGE = 64;
const EXIT_REFUSED = 2;
const EXIT_UNAVAILABLE = 69;

const USAGE = `usage:
  gh-broker sync <owner/repo> [--pr <n>]
  gh-broker push <owner/repo> <agent/branch>
  gh-broker pr-create <owner/repo> <agent/branch> <title> <body>
  gh-broker pr-status <owner/repo> <n>
  gh-broker ci-log <owner/repo> <n>
  gh-broker review <owner/repo> <n> <sha> code-review|security-review|risk-review pass|manual|block [reason]
  gh-broker merge <owner/repo> <n>
`;

const execFileAsync = promisify(execFile);

class UsageError extends Error {}

async function localBranch(branch: string): Promise<{ sha: string; bundle_b64: string }> {
  const ref = `refs/heads/${branch}`;
  const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
  });
  const { stdout: bundle } = await execFileAsync("git", ["bundle", "create", "-", ref], {
    encoding: "buffer",
    maxBuffer: Infinity,
  });
  return { sha: shaOut.trim(), bundle_b64: bundle.toString("base64") };
}

async function runGit(args: string[], cwd: string): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return { ok: true, stdout };
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr !== "" ? error.stderr : String(error);
    return { ok: false, stderr: stderr.trim() };
  }
}

type Worktree = { path: string; branch?: string };

function parseWorktrees(porcelainZ: string): Worktree[] {
  const trees: Worktree[] = [];
  for (const field of porcelainZ.split("\0")) {
    if (field.startsWith("worktree ")) trees.push({ path: field.slice("worktree ".length) });
    else if (field.startsWith("branch ") && trees.length > 0) trees[trees.length - 1].branch = field.slice("branch ".length);
  }
  return trees;
}

export async function cleanUpLocal(merged: MergeReply["merged"], cwd: string = process.cwd()): Promise<number> {
  const ref = `refs/heads/${merged.branch}`;
  const listed = await runGit(["worktree", "list", "--porcelain", "-z"], cwd);
  if (!listed.ok) {
    process.stderr.write(`gh-broker: merged, but cannot list the local worktrees: ${listed.stderr}\n`);
    return 1;
  }
  const [main, ...linked] = parseWorktrees(listed.stdout);
  if (main === undefined) {
    process.stderr.write("gh-broker: merged, but git lists no main worktree\n");
    return 1;
  }
  const tip = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], main.path);
  if (!tip.ok) {
    process.stdout.write(`gh-broker: no local branch ${merged.branch}\n`);
    return 0;
  }
  const sha = tip.stdout.trim();
  if (sha !== merged.head) {
    process.stdout.write(`gh-broker: kept local branch ${merged.branch} and its worktree: it moved from the merged commit ${merged.head} to ${sha}\n`);
    return 0;
  }
  if (main.branch === ref) {
    process.stdout.write(`gh-broker: kept local branch ${merged.branch}: the main worktree ${main.path} has it checked out\n`);
    return 0;
  }
  const tree = linked.find((t) => t.branch === ref);
  if (tree !== undefined) {
    const removed = await runGit(["worktree", "remove", tree.path], main.path);
    if (!removed.ok) {
      process.stderr.write(`gh-broker: merged, but kept worktree ${tree.path} and local branch ${merged.branch}: ${removed.stderr}\n`);
      return 1;
    }
    process.stdout.write(`gh-broker: removed worktree ${tree.path}\n`);
  }
  const deleted = await runGit(["update-ref", "-d", ref, merged.head], main.path);
  if (!deleted.ok) {
    process.stderr.write(`gh-broker: merged, but cannot delete local branch ${merged.branch}: ${deleted.stderr}\n`);
    return 1;
  }
  process.stdout.write(`gh-broker: deleted local branch ${merged.branch}\n`);
  return 0;
}

function needRepo(value: string | undefined): string {
  if (!isRepo(value)) throw new UsageError("invalid <owner/repo>");
  return value;
}

function needBranch(value: string | undefined): string {
  if (!isAgentBranch(value)) throw new UsageError("branch must match agent/<name> or wt/<name>");
  return value;
}

function needNumber(value: string | undefined): number {
  const n = value === undefined ? undefined : parsePrNumber(value);
  if (n === undefined) throw new UsageError("invalid PR number");
  return n;
}

function needArgCount(args: string[], min: number, max: number): void {
  if (args.length < min || args.length > max) throw new UsageError("wrong number of arguments");
}

export async function buildRequest(argv: string[]): Promise<Request> {
  const [verb, ...args] = argv;
  switch (verb) {
    case "sync": {
      needArgCount(args, 1, 3);
      const repo = needRepo(args[0]);
      if (args.length === 1) return { verb, repo };
      if (args[1] !== "--pr" || args.length !== 3) throw new UsageError("want sync <owner/repo> --pr <n>");
      return { verb, repo, pr: needNumber(args[2]) };
    }
    case "push": {
      needArgCount(args, 2, 2);
      const repo = needRepo(args[0]);
      const branch = needBranch(args[1]);
      return { verb, repo, branch, ...(await localBranch(branch)) };
    }
    case "pr-create":
      needArgCount(args, 4, 4);
      return { verb, repo: needRepo(args[0]), head: needBranch(args[1]), title: args[2] ?? "", body: args[3] ?? "" };
    case "pr-status":
    case "ci-log":
      needArgCount(args, 2, 2);
      return { verb, repo: needRepo(args[0]), number: needNumber(args[1]) };
    case "review": {
      needArgCount(args, 5, 6);
      const [repo, number, sha, role, verdict, reason] = args;
      if (!isSha(sha)) throw new UsageError("sha must be a full 40-hex commit sha");
      if (!isReviewerRole(role)) throw new UsageError(`role must be ${REVIEWER_ROLES.join(", ")}`);
      if (!isVerdict(verdict)) throw new UsageError("verdict must be pass, manual or block");
      return { verb, repo: needRepo(repo), number: needNumber(number), sha, role, verdict, reason: reason ?? "" };
    }
    case "merge":
      needArgCount(args, 2, 2);
      return { verb, repo: needRepo(args[0]), number: needNumber(args[1]) };
    default:
      throw new UsageError(verb === undefined ? "missing verb" : `unknown verb: ${verb}`);
  }
}

export function send(socketPath: string, request: Request): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const chunks: Buffer[] = [];
  const socket = connect(socketPath);
  socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("error", reject);
  socket.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8").trim();
    try {
      const reply: unknown = JSON.parse(text);
      if (isReply(reply)) resolve(reply);
      else reject(new Error("malformed reply"));
    } catch {
      reject(new Error("malformed reply"));
    }
  });
  return promise;
}

async function importSync(reply: SyncReply): Promise<number> {
  const tempDir = await mkdtemp(join(tmpdir(), "gh-broker-sync-"));
  try {
    const bundlePath = join(tempDir, "sync.bundle");
    await writeFile(bundlePath, Buffer.from(reply.bundle_b64, "base64"), { mode: 0o600 });
    const ref = `refs/remotes/origin/${reply.branch}`;
    await execFileAsync("git", ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--update-head-ok", bundlePath, `+refs/heads/${reply.branch}:${ref}`]);
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" });
    process.stdout.write(`origin/${reply.branch} is now ${stdout.trim()}\n`);
    return 0;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function importPr(reply: SyncPrReply, cwd: string = process.cwd()): Promise<number> {
  const git = async (args: string[]): Promise<string> => (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
  const ref = `refs/remotes/origin/pr/${reply.pr}`;
  const tempDir = await mkdtemp(join(tmpdir(), "gh-broker-sync-"));
  try {
    const bundlePath = join(tempDir, "pr.bundle");
    await writeFile(bundlePath, Buffer.from(reply.bundle_b64, "base64"), { mode: 0o600 });
    const heads = (await git(["bundle", "list-heads", bundlePath])).split("\n").filter((line) => line !== "");
    if (heads.length !== 1) throw new Error(`the PR bundle holds ${heads.length} refs, want 1`);
    const source = heads[0].slice(heads[0].indexOf(" ") + 1);
    await git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", bundlePath, `+${source}:${ref}`]);
    const imported = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
    if (imported !== reply.head) throw new Error(`the imported commit ${imported} is not the PR head ${reply.head}`);
    process.stdout.write(`origin/pr/${reply.pr} is now ${imported}\n`);
    return 0;
  } catch (error) {
    await git(["update-ref", "-d", ref]).catch(() => "");
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function main(argv: string[], socketPath: string | undefined = process.env[SOCKET_ENV]): Promise<number> {
  let request: Request;
  try {
    request = await buildRequest(argv);
    const checked = validateRequest(request);
    if (!checked.ok) throw new UsageError(checked.reason);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`gh-broker: ${error.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    process.stderr.write(`gh-broker: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (socketPath === undefined || socketPath === "") {
    process.stderr.write(`gh-broker: this session has no gh-broker socket (${SOCKET_ENV} is not set)\n`);
    return EXIT_UNAVAILABLE;
  }
  let reply: Reply;
  try {
    reply = await send(socketPath, request);
  } catch (error) {
    process.stderr.write(`gh-broker: cannot reach gh-broker: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_UNAVAILABLE;
  }
  if ("refused" in reply) {
    process.stderr.write(`refused: ${reply.refused}\n`);
    return EXIT_REFUSED;
  }
  process.stdout.write(reply.stdout);
  process.stderr.write(reply.stderr);
  if (request.verb === "merge" && isMergeReply(reply)) {
    const local = await cleanUpLocal(reply.merged);
    return reply.exit !== 0 ? reply.exit : local;
  }
  if (reply.exit !== 0) return reply.exit;
  if (request.verb !== "sync") return 0;
  try {
    if (request.pr !== undefined) {
      if (isSyncPrReply(reply)) return await importPr(reply);
    } else if (isSyncReply(reply)) {
      return await importSync(reply);
    }
  } catch (error) {
    process.stderr.write(`gh-broker: cannot import sync bundle: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  process.stderr.write("gh-broker: malformed sync reply\n");
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
