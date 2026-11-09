import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseReviewRecord } from "./protocol.ts";
import type { ReviewRecord, ReviewRecords } from "./protocol.ts";
import { readFileAsText } from "./read-file.ts";

export type PrKey = { repo: string; pr: number };

export function reviewRecordsPath(dir: string, key: PrKey): string {
  return join(dir, key.repo, `${key.pr}.jsonl`);
}

function parseRecordLine(line: string, key: PrKey): ReviewRecord | undefined {
  try {
    const record = parseReviewRecord(JSON.parse(line));
    if (record !== undefined && record.repo === key.repo && record.pr === key.pr) return record;
  } catch {}
  return undefined;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export async function readReviewRecords(dir: string, key: PrKey): Promise<ReviewRecords> {
  const file = await readFileAsText(reviewRecordsPath(dir, key));
  if (file.kind === "missing") return { kind: "records", records: [] };
  if (file.kind === "unreadable") return { kind: "unreadable" };
  const records: ReviewRecord[] = [];
  const lines = file.text.split("\n");
  const last = lines.pop() ?? "";
  for (const line of lines) {
    if (line === "") continue;
    const record = parseRecordLine(line, key);
    if (record === undefined) return { kind: "unreadable" };
    records.push(record);
  }
  if (last !== "" && isJson(last)) {
    const finished = parseRecordLine(last, key);
    if (finished === undefined) return { kind: "unreadable" };
    records.push(finished);
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
