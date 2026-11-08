import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord, parseReviewRecord } from "./protocol.ts";
import type { ReviewRecord, ReviewRecords } from "./protocol.ts";

export type PrKey = { repo: string; pr: number };

type FileText = { kind: "text"; text: string } | { kind: "missing" } | { kind: "unreadable" };

export function reviewRecordsPath(dir: string, key: PrKey): string {
  return join(dir, key.repo, `${key.pr}.jsonl`);
}

async function readFileText(path: string): Promise<FileText> {
  try {
    return { kind: "text", text: await readFile(path, "utf8") };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable" };
  }
}

function parseRecordLine(line: string, key: PrKey): ReviewRecord | undefined {
  try {
    const record = parseReviewRecord(JSON.parse(line));
    if (record !== undefined && record.repo === key.repo && record.pr === key.pr) return record;
  } catch {}
  return undefined;
}

export async function readReviewRecords(dir: string, key: PrKey): Promise<ReviewRecords> {
  const file = await readFileText(reviewRecordsPath(dir, key));
  if (file.kind === "missing") return { kind: "records", records: [] };
  if (file.kind === "unreadable") return { kind: "unreadable" };
  const records: ReviewRecord[] = [];
  for (const line of file.text.split("\n")) {
    if (line === "") continue;
    const record = parseRecordLine(line, key);
    if (record === undefined) return { kind: "unreadable" };
    records.push(record);
  }
  return { kind: "records", records };
}

let appendQueue: Promise<unknown> = Promise.resolve();

function serially<T>(work: () => Promise<T>): Promise<T> {
  const next = appendQueue.then(work);
  appendQueue = next.catch(() => {});
  return next;
}

export function appendReviewRecord(dir: string, record: ReviewRecord): Promise<void> {
  return serially(async () => {
    const path = reviewRecordsPath(dir, record);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
}
