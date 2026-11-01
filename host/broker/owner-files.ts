import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OWNER_MODE = 0o644;
const PERMISSION_BITS = 0o7777;

export function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentUid(): number {
  if (process.getuid === undefined) throw new Error("omp: owner files need a POSIX user id");
  return process.getuid();
}

function readSource(from: string): Buffer {
  try {
    return readFileSync(from);
  } catch (error) {
    throw new Error(`omp: cannot read the owner template ${tilde(from)}: ${errorText(error)}; run ug-install`);
  }
}

// Reads the destination only when it is a regular file that already has the owner metadata, so a
// FIFO, socket or device is refused before anything opens it. The descriptor is checked against
// the lstat result, so a swap between the two calls reads as not compliant.
function compliantBytes(to: string, uid: number): Buffer | undefined {
  const before = lstatSync(to, { throwIfNoEntry: false });
  if (before === undefined) return undefined;
  if (before.isSymbolicLink() || before.isDirectory()) {
    throw new Error(`omp: ${tilde(to)} must be a file, not a symlink or a folder`);
  }
  if (!before.isFile()) throw new Error(`omp: ${tilde(to)} must be a regular file`);
  if (before.uid !== uid || (before.mode & PERMISSION_BITS) !== OWNER_MODE) return undefined;
  const fd = openSync(to, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return undefined;
    if (opened.uid !== uid || (opened.mode & PERMISSION_BITS) !== OWNER_MODE) return undefined;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function replaceAtomically(to: string, bytes: Buffer): void {
  const temp = `${to}.tmp.${randomBytes(12).toString("hex")}`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written);
      fchmodSync(fd, OWNER_MODE);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, to);
    renamed = true;
  } finally {
    if (!renamed) rmSync(temp, { force: true });
  }
}

function installOwnerFile(from: string, to: string, uid: number): void {
  const bytes = readSource(from);
  const current = compliantBytes(to, uid);
  if (current !== undefined && current.equals(bytes)) return;
  try {
    replaceAtomically(to, bytes);
  } catch (error) {
    throw new Error(`omp: cannot write ${tilde(to)}: ${errorText(error)}`);
  }
}

// The owner part of the omp root follows the installed templates: each start compares them again,
// so an owner change reaches every role at its next start. No role can write these files.
// The wrapper makes the folders first (make_omp_root), so this writes files only.
export function syncOwnerFiles(ompRoot: string): void {
  const uid = currentUid();
  const templates = join(homedir(), ".agents/roles");
  const agent = join(ompRoot, "agent");
  for (const file of ["policy.yml", "hooks/pre/concise-reply.ts", "hooks/pre/role-rules.ts"]) {
    installOwnerFile(join(templates, file), join(agent, file), uid);
  }
}
