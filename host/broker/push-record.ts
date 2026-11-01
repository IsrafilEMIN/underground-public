import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, isSha } from "./protocol.ts";
import type { PushRecord } from "./protocol.ts";

export type PushRecordKey = { repo: string; branch: string };

export function pushRecordPath(dir: string, key: PushRecordKey): string {
  return join(dir, key.repo, encodeURIComponent(key.branch));
}

export async function readPushRecord(dir: string, key: PushRecordKey): Promise<PushRecord> {
  let text: string;
  try {
    text = await readFile(pushRecordPath(dir, key), "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable" };
  }
  const sha = text.trim();
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

export async function dropPushRecord(dir: string, key: PushRecordKey): Promise<void> {
  await rm(pushRecordPath(dir, key), { force: true });
}
