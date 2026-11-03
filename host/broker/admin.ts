import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { send } from "./client.ts";
import {
  ADMIN_SOCKET_NAME,
  MAX_ROLE_NAME_CHARS,
  MAX_SOCKET_PATH_BYTES,
  githubRepoFromGitConfig,
  isRegisterReply,
  parseReposFile,
  validateAdminRequest,
} from "./protocol.ts";

// The arena wrapper registers each session's broker binding through this, on the host
// (host/bin/omp-arena). Until the broker rebuild, the binding is per checkout and role name.
export const ADMIN_SOCKET_PATH = join(homedir(), ".agents/broker/run", ADMIN_SOCKET_NAME);
export const REPOS_FILE = join(homedir(), ".config/underground-broker/repos");

const EXIT_USAGE = 64;
const EXIT_REFUSED = 2;
const EXIT_UNAVAILABLE = 69;

const USAGE = `usage:
  admin.ts session <repo-folder> <role-name>
  admin.ts register <repo-id> <role-name> <owner/repo>
`;

export type Files = { socketPath: string; reposFile: string };
const DEFAULT_FILES: Files = { socketPath: ADMIN_SOCKET_PATH, reposFile: REPOS_FILE };

export async function sessionRepo(repoFolder: string, reposFile: string): Promise<string | undefined> {
  let config: string;
  let listed: Set<string>;
  try {
    config = await readFile(join(repoFolder, ".git/config"), "utf8");
    listed = parseReposFile(await readFile(reposFile, "utf8"));
  } catch {
    return undefined;
  }
  const origin = githubRepoFromGitConfig(config)?.toLowerCase();
  if (origin === undefined) return undefined;
  return [...listed].find((repo) => repo.toLowerCase() === origin);
}

const MAX_BINDING_NAME_CHARS = 55;

export function bindingRepoId(repoFolder: string, runDir: string, hash: string): string {
  const room = MAX_SOCKET_PATH_BYTES - Buffer.byteLength(join(runDir, `-${hash}`, `${"x".repeat(MAX_ROLE_NAME_CHARS)}.sock`));
  const name = basename(repoFolder)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, Math.max(0, Math.min(room, MAX_BINDING_NAME_CHARS)));
  return name === "" ? hash : `${name}-${hash}`;
}

async function registerInput(argv: string[], files: Files, repoHash?: string): Promise<Record<string, unknown> | null | undefined> {
  const [verb, ...args] = argv;
  if (verb === "session" && args.length === 2) {
    const repo = await sessionRepo(args[0], files.reposFile);
    if (repo === undefined) return null;
    const hash = repoHash ?? createHash("sha256").update(args[0]).digest("hex").slice(0, 8);
    return { verb: "register", repo_id: bindingRepoId(args[0], dirname(files.socketPath), hash), role_name: args[1], repo };
  }
  if (verb === "register" && args.length === 3) {
    return { verb, repo_id: args[0], role_name: args[1], repo: args[2] };
  }
  return undefined;
}

type Registration = { kind: "registered"; socket: string } | { kind: "unlisted" } | { kind: "error"; exit: number; stderr: string };

async function register(argv: string[], files: Files, repoHash?: string): Promise<Registration> {
  const input = await registerInput(argv, files, repoHash);
  if (input === undefined) return { kind: "error", exit: EXIT_USAGE, stderr: USAGE };
  if (input === null) return { kind: "unlisted" };
  const checked = validateAdminRequest(input);
  if (!checked.ok) return { kind: "error", exit: EXIT_USAGE, stderr: `broker admin: ${checked.reason}\n` };
  let reply;
  try {
    reply = await send(files.socketPath, checked.value);
  } catch (error) {
    return { kind: "error", exit: EXIT_UNAVAILABLE, stderr: `broker admin: cannot reach broker: ${error instanceof Error ? error.message : String(error)}\n` };
  }
  if ("refused" in reply) return { kind: "error", exit: EXIT_REFUSED, stderr: `broker admin: refused: ${reply.refused}\n` };
  if (reply.exit !== 0) return { kind: "error", exit: reply.exit, stderr: reply.stderr };
  if (!isRegisterReply(reply)) return { kind: "error", exit: 1, stderr: "broker admin: register reply has no socket\n" };
  return { kind: "registered", socket: reply.socket };
}

export async function main(argv: string[], files: Files = DEFAULT_FILES): Promise<number> {
  const result = await register(argv, files);
  if (result.kind === "registered") process.stdout.write(`${result.socket}\n`);
  if (result.kind === "error") {
    process.stderr.write(result.stderr);
    return result.exit;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
