import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BUNDLE_LACKS_BASE,
  isAgentBranch,
  isDefaultBranchName,
  isSha,
  isReply,
  isSyncPrReply,
  isSyncReply,
  isRepo,
  MAX_SYNC_HAVES,
  parsePrNumber,
  validateRequest,
} from "./protocol.ts";
import type { Reply, Request, SyncPrReply, SyncReply, SyncRequest } from "./protocol.ts";
import { sweep } from "./sweep.ts";

export const SOCKET_ENV = "UG_GH_BROKER_SOCKET";

const EXIT_USAGE = 64;
const EXIT_REFUSED = 2;
const EXIT_UNAVAILABLE = 69;

const USAGE = `usage:
  gh-broker sync <owner/repo> [--pr <n> | --cached]
  gh-broker push <owner/repo> <agent/branch>
  gh-broker pr-create <owner/repo> <agent/branch> <title> <body>
  gh-broker pr-status <owner/repo> <n>
  gh-broker ci-log <owner/repo> <n>
  gh-broker sweep <default-branch>
`;

const execFileAsync = promisify(execFile);

class UsageError extends Error {}

async function bundle(refs: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["bundle", "create", "-", ...refs], { encoding: "buffer", maxBuffer: Infinity });
  return stdout.toString("base64");
}

async function localBranch(branch: string, thin: boolean): Promise<{ sha: string; bundle_b64: string }> {
  const ref = `refs/heads/${branch}`;
  const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
  });
  const bases = thin ? (await originHeads()).map((head) => `^${head}`) : [];
  let bundle_b64: string;
  try {
    bundle_b64 = await bundle([ref, ...bases]);
  } catch (error) {
    if (bases.length === 0) throw error;
    bundle_b64 = await bundle([ref]);
  }
  return { sha: shaOut.trim(), bundle_b64 };
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
      if (args.length === 1) return { verb, repo, have: await originHeads() };
      if (args[1] === "--cached" && args.length === 2) return { verb, repo, have: await originHeads(), cached: true };
      if (args[1] !== "--pr" || args.length !== 3) throw new UsageError("want sync <owner/repo> --pr <n>, or sync <owner/repo> --cached");
      return { verb, repo, pr: needNumber(args[2]) };
    }
    case "push": {
      needArgCount(args, 2, 2);
      const repo = needRepo(args[0]);
      const branch = needBranch(args[1]);
      return { verb, repo, branch, ...(await localBranch(branch, true)) };
    }
    case "pr-create":
      needArgCount(args, 4, 4);
      return { verb, repo: needRepo(args[0]), head: needBranch(args[1]), title: args[2] ?? "", body: args[3] ?? "" };
    case "pr-status":
    case "ci-log":
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

async function originHeads(): Promise<string[]> {
  const listed = await runGit(["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin/"], process.cwd());
  if (!listed.ok) return [];
  const heads = listed.stdout
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([sha, ref]) => isSha(sha) && ref !== undefined && !ref.startsWith("refs/remotes/origin/pr/"))
    .map(([sha]) => sha);
  return [...new Set(heads)].slice(0, MAX_SYNC_HAVES);
}

async function withTempBundle<T>(bundleB64: string, name: string, use: (bundlePath: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "gh-broker-sync-"));
  try {
    const bundlePath = join(tempDir, name);
    await writeFile(bundlePath, Buffer.from(bundleB64, "base64"), { mode: 0o600 });
    return await use(bundlePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function importSync(reply: SyncReply): Promise<void> {
  const ref = `refs/remotes/origin/${reply.branch}`;
  if (reply.bundle_b64 === undefined) {
    await execFileAsync("git", ["update-ref", ref, `${reply.head}^{commit}`]);
  } else {
    await withTempBundle(reply.bundle_b64, "sync.bundle", async (bundlePath) => {
      await execFileAsync("git", ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--update-head-ok", bundlePath, `+refs/heads/${reply.branch}:${ref}`]);
    });
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" });
  const imported = stdout.trim();
  if (imported !== reply.head) throw new Error(`origin/${reply.branch} is ${imported}, not the gh-broker's ${reply.head}`);
}

async function importPr(reply: SyncPrReply, cwd: string = process.cwd()): Promise<number> {
  const git = async (args: string[]): Promise<string> => (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
  const ref = `refs/remotes/origin/pr/${reply.pr}`;
  await withTempBundle(reply.bundle_b64, "pr.bundle", async (bundlePath) => {
    try {
      const heads = (await git(["bundle", "list-heads", bundlePath])).split("\n").filter((line) => line !== "");
      if (heads.length !== 1) throw new Error(`the PR bundle holds ${heads.length} refs, want 1`);
      const source = heads[0].slice(heads[0].indexOf(" ") + 1);
      await git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", bundlePath, `+${source}:${ref}`]);
      const imported = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
      if (imported !== reply.head) throw new Error(`the imported commit ${imported} is not the PR head ${reply.head}`);
      process.stdout.write(`origin/pr/${reply.pr} is now ${imported}\n`);
    } catch (error) {
      await git(["update-ref", "-d", ref]).catch(() => "");
      throw error;
    }
  });
  return 0;
}

async function runSweep(args: string[]): Promise<number> {
  const [base] = args;
  if (args.length !== 1 || !isDefaultBranchName(base)) {
    process.stderr.write(`gh-broker: want sweep <default-branch>\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    const report = await sweep({ cwd: process.cwd(), base });
    for (const line of report.lines) process.stdout.write(`${line}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`gh-broker: sweep: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function syncMain(socketPath: string, request: SyncRequest, first: Reply): Promise<{ branch: string } | number> {
  if (!isSyncReply(first)) {
    process.stderr.write("gh-broker: malformed sync reply\n");
    return 1;
  }
  let synced = first;
  try {
    try {
      await importSync(synced);
    } catch (error) {
      if (request.have === undefined || request.have.length === 0) throw error;
      const full = await send(socketPath, { verb: "sync", repo: request.repo });
      if (!isSyncReply(full) || full.exit !== 0) throw error;
      synced = full;
      await importSync(synced);
    }
  } catch (error) {
    process.stderr.write(`gh-broker: cannot import sync bundle: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  process.stdout.write(`origin/${synced.branch} is now ${synced.head}\n`);
  return { branch: synced.branch };
}

export async function main(argv: string[], socketPath: string | undefined = process.env[SOCKET_ENV]): Promise<number> {
  if (argv[0] === "sweep") return runSweep(argv.slice(1));
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
  if (request.verb === "push" && "refused" in reply && reply.refused === BUNDLE_LACKS_BASE) {
    try {
      request = { ...request, ...(await localBranch(request.branch, false)) };
      reply = await send(socketPath, request);
    } catch (error) {
      process.stderr.write(`gh-broker: cannot send the full branch: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if ("refused" in reply) {
    process.stderr.write(`refused: ${reply.refused}\n`);
    return EXIT_REFUSED;
  }
  if (request.verb === "sync" && request.pr === undefined && reply.exit === 0) {
    process.stderr.write(reply.stderr);
    const synced = await syncMain(socketPath, request, reply);
    return typeof synced === "number" ? synced : 0;
  }
  process.stdout.write(reply.stdout);
  process.stderr.write(reply.stderr);
  if (reply.exit !== 0) return reply.exit;
  if (request.verb !== "sync") return 0;
  try {
    if (isSyncPrReply(reply)) return await importPr(reply);
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
