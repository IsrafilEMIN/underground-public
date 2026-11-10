import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { isAgentBranch, isDefaultBranchName } from "./protocol.ts";

export const KEPT_FILE = "ug-kept.json";
export const HELD_DIR = "ug-held";
export const MIN_AGE_MS = 10 * 60 * 1000;
export const HOLD_MS = 14 * 24 * 60 * 60 * 1000;

const LSOF = "/usr/sbin/lsof";

const execFileAsync = promisify(execFile);

export type KeptReason = "unsaved files" | "not in main" | "cannot remove";
export type Kept = { branch: string; worktree?: string; reason: KeptReason; detail: string; parked: boolean };
export type KeptFile = { at: string; kept: Kept[] };
export type Probe = () => Promise<{ ok: true; cwds: string[] } | { ok: false; reason: string }>;
export type SweepOptions = { cwd: string; base: string; now?: () => number; probe?: Probe; minAgeMs?: number };
export type SweepReport = { lines: string[]; kept: Kept[] };

type Git = { ok: true; stdout: string } | { ok: false; code: number; stderr: string };
type Worktree = { path: string; branch?: string; locked: boolean };

async function git(cwd: string, args: string[]): Promise<Git> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "number" ? error.code : 1;
    const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr !== "" ? error.stderr : String(error);
    return { ok: false, code, stderr: stderr.trim() };
  }
}

function parseWorktrees(porcelainZ: string): Worktree[] {
  const trees: Worktree[] = [];
  for (const field of porcelainZ.split("\0")) {
    const tree = trees.at(-1);
    if (field.startsWith("worktree ")) trees.push({ path: field.slice("worktree ".length), locked: false });
    else if (tree === undefined) continue;
    else if (field.startsWith("branch ")) tree.branch = field.slice("branch ".length);
    else if (field === "locked" || field.startsWith("locked ")) tree.locked = true;
  }
  return trees;
}

export const lsofProbe: Probe = async () => {
  let stdout: string;
  try {
    stdout = (await execFileAsync(LSOF, ["-n", "-P", "-w", "-d", "cwd", "-F", "n"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    stdout = error instanceof Error && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    if (stdout === "") return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const cwds = stdout.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
  return cwds.length > 0 ? { ok: true, cwds } : { ok: false, reason: "lsof listed no working folder" };
};

async function oldestReflogMs(cwd: string, ref: string): Promise<number | undefined> {
  const log = await git(cwd, ["reflog", "show", "--format=%ct", ref, "--"]);
  if (!log.ok) return undefined;
  const times = log.stdout.split("\n").filter((line) => /^\d+$/.test(line));
  return times.length > 0 ? Number(times[times.length - 1]) * 1000 : undefined;
}

async function createdMs(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    return info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs;
  } catch {
    return undefined;
  }
}

async function treeState(path: string): Promise<{ dirty: string[]; ignored: string[] } | { error: string }> {
  const status = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored=traditional"]);
  if (!status.ok) return { error: status.stderr };
  const dirty: string[] = [];
  const ignored: string[] = [];
  const entries = status.stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code === "!!") {
      ignored.push(file.replace(/\/$/, ""));
    } else {
      dirty.push(file);
      if (code[0] === "R" || code[0] === "C") i++;
    }
  }
  return { dirty, ignored };
}

function sample(files: string[]): string {
  const shown = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${files.length} files: ${shown}, …` : `${files.length} ${files.length === 1 ? "file" : "files"}: ${shown}`;
}

async function parkedBranches(cwd: string): Promise<Set<string>> {
  const listed = await git(cwd, ["config", "--bool", "--get-regexp", "^branch\\..*\\.ugparked$"]);
  const parked = new Set<string>();
  if (!listed.ok) return parked;
  for (const line of listed.stdout.split("\n")) {
    const match = /^branch\.(.+)\.ugparked true$/.exec(line);
    if (match !== null) parked.add(match[1]);
  }
  return parked;
}

async function holdIgnored(commonDir: string, tree: string, branch: string, files: string[], now: number): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const dir = join(commonDir, HELD_DIR, `${now}-${encodeURIComponent(branch)}`);
  try {
    for (const file of files) {
      const to = join(dir, file);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await rename(join(tree, file), to);
    }
    return { ok: true, dir };
  } catch (error) {
    return { ok: false, error: `cannot move its ignored files to ${dir}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function expireHeld(commonDir: string, now: number, lines: string[]): Promise<void> {
  const held = join(commonDir, HELD_DIR);
  const names = await readdir(held).catch(() => []);
  for (const name of names) {
    const at = /^(\d+)-/.exec(name)?.[1];
    if (at === undefined || now - Number(at) < HOLD_MS) continue;
    const path = join(held, name);
    try {
      await rm(path, { recursive: true, force: true });
      lines.push(`gh-broker: deleted held files ${path}, older than 14 days`);
    } catch (error) {
      lines.push(`gh-broker: cannot delete held files ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function writeKept(commonDir: string, kept: Kept[], now: number): Promise<void> {
  const path = join(commonDir, KEPT_FILE);
  const temp = join(commonDir, `.${KEPT_FILE}.${randomUUID()}.tmp`);
  const file: KeptFile = { at: new Date(now).toISOString(), kept };
  await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function sweep(options: SweepOptions): Promise<SweepReport> {
  const { cwd, base } = options;
  if (!isDefaultBranchName(base)) throw new Error(`invalid default branch: ${base}`);
  const now = (options.now ?? Date.now)();
  const minAge = options.minAgeMs ?? MIN_AGE_MS;
  const probe = options.probe ?? lsofProbe;
  const lines: string[] = [];
  const kept: Kept[] = [];

  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new Error(`not in a git repo: ${common.stderr}`);
  const commonDir = common.stdout.trim();
  const mainRef = `refs/remotes/origin/${base}`;
  const main = await git(cwd, ["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`]);
  if (!main.ok) throw new Error(`the clone has no ${mainRef}; run gh-broker sync first`);

  const pruned = await git(cwd, ["worktree", "prune"]);
  if (!pruned.ok) lines.push(`gh-broker: cannot prune missing worktrees: ${pruned.stderr}`);
  const listed = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
  if (!listed.ok) throw new Error(`cannot list the worktrees: ${listed.stderr}`);
  const [mainTree, ...trees] = parseWorktrees(listed.stdout);
  const branches = await git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
  if (!branches.ok) throw new Error(`cannot list the branches: ${branches.stderr}`);
  const parked = await parkedBranches(cwd);
  await expireHeld(commonDir, now, lines);

  let cwds: string[] | undefined;
  let probeFailed = false;
  const inUse = async (path: string): Promise<boolean> => {
    if (cwds === undefined && !probeFailed) {
      const result = await probe();
      if (result.ok) cwds = result.cwds;
      else {
        probeFailed = true;
        lines.push(`gh-broker: cannot tell which worktrees a session uses, so every worktree stays: ${result.reason}`);
      }
    }
    if (cwds === undefined) return true;
    const real = await realpath(path).catch(() => path);
    return cwds.some((seen) => [real, path].some((tree) => seen === tree || seen.startsWith(`${tree}/`)));
  };

  for (const line of branches.stdout.split("\n")) {
    const [ref, sha] = line.split(" ");
    if (ref === undefined || sha === undefined || !ref.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    if (!isAgentBranch(branch) || mainTree?.branch === ref) continue;
    const tree = trees.find((t) => t.branch === ref);
    if (tree?.locked === true) continue;
    const keep = (reason: KeptReason, detail: string): void => {
      kept.push({ branch, ...(tree === undefined ? {} : { worktree: tree.path }), reason, detail, parked: parked.has(branch) });
    };

    const born = [await oldestReflogMs(cwd, ref)];
    if (tree !== undefined) born.push(await createdMs(join(tree.path, ".git")));
    if (tree !== undefined && born[1] === undefined) continue;
    if (born.some((ms) => ms !== undefined && now - ms < minAge)) continue;
    if (tree !== undefined && (await inUse(tree.path))) continue;

    let ignored: string[] = [];
    if (tree !== undefined) {
      const state = await treeState(tree.path);
      if ("error" in state) {
        keep("cannot remove", state.error);
        continue;
      }
      if (state.dirty.length > 0) {
        keep("unsaved files", sample(state.dirty));
        continue;
      }
      ignored = state.ignored;
    }
    const merged = await git(cwd, ["merge-base", "--is-ancestor", sha, mainRef]);
    if (!merged.ok) {
      keep("not in main", merged.code === 1 ? `its commits are not in origin/${base}` : merged.stderr);
      continue;
    }

    if (tree !== undefined) {
      if (ignored.length > 0) {
        const held = await holdIgnored(commonDir, tree.path, branch, ignored, now);
        if (!held.ok) {
          keep("cannot remove", held.error);
          continue;
        }
        lines.push(`gh-broker: moved the ignored ${sample(ignored)} of ${branch} to ${held.dir}; they are deleted after 14 days`);
      }
      const removed = await git(cwd, ["worktree", "remove", tree.path]);
      if (!removed.ok) {
        keep("cannot remove", removed.stderr);
        continue;
      }
      lines.push(`gh-broker: removed worktree ${tree.path}`);
    }
    const deleted = await git(cwd, ["update-ref", "-d", ref, sha]);
    if (deleted.ok) lines.push(`gh-broker: deleted local branch ${branch}`);
    else if ((await git(cwd, ["rev-parse", "--verify", "--quiet", ref])).ok) keep("cannot remove", deleted.stderr);
  }

  for (const item of kept) lines.push(`gh-broker: kept ${item.branch}${item.parked ? " (parked)" : ""}: ${item.reason}, ${item.detail}`);
  await writeKept(commonDir, kept, now);
  return { lines, kept };
}
