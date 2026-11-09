import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSha } from "./protocol.ts";
import type { PushRecord } from "./protocol.ts";
import { readFileAsText } from "./read-file.ts";

export type PushRecordKey = { repo: string; branch: string };
export type PushedBranch = PushRecordKey & { sha: string };

export function pushRecordPath(dir: string, key: PushRecordKey): string {
  return join(dir, key.repo, encodeURIComponent(key.branch));
}

export async function readPushRecord(dir: string, key: PushRecordKey): Promise<PushRecord> {
  const file = await readFileAsText(pushRecordPath(dir, key));
  if (file.kind === "missing") return { kind: "none" };
  if (file.kind === "unreadable") return { kind: "unreadable" };
  const sha = file.text.trim();
  return isSha(sha) ? { kind: "pushed", sha } : { kind: "unreadable" };
}

export async function writePushRecord(dir: string, key: PushRecordKey, sha: string): Promise<void> {
  const folder = join(dir, key.repo);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temp = join(folder, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${sha}\n`, { mode: 0o600 });
    await rename(temp, pushRecordPath(dir, key));
  } finally {
    await rm(temp, { force: true });
  }
}

export async function listPushRecords(dir: string): Promise<PushedBranch[]> {
  const found: PushedBranch[] = [];
  for (const owner of await folderNames(dir)) {
    for (const name of await folderNames(join(dir, owner))) {
      const repo = `${owner}/${name}`;
      for (const file of await readdir(join(dir, repo)).catch(() => [])) {
        if (file.startsWith(".")) continue;
        let branch: string;
        try {
          branch = decodeURIComponent(file);
        } catch {
          continue;
        }
        const record = await readPushRecord(dir, { repo, branch });
        if (record.kind === "pushed") found.push({ repo, branch, sha: record.sha });
      }
    }
  }
  return found;
}

async function folderNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
}

export async function dropPushRecord(dir: string, key: PushRecordKey, sha: string): Promise<boolean> {
  const record = await readPushRecord(dir, key);
  if (record.kind !== "pushed" || record.sha !== sha) return false;
  await rm(pushRecordPath(dir, key), { force: true });
  return true;
}
