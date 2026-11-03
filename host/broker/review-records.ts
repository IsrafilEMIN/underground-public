import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isLegacyReviewRecord, isRecord, parseReviewRecord } from "./protocol.ts";
import type { LegacyReviewRecord, ReviewRecord, ReviewRecords } from "./protocol.ts";

export type PrKey = { repo: string; pr: number };

export type LegacyMove = { kind: "none" } | { kind: "moved"; count: number } | { kind: "failed"; reason: string };

type FileText = { kind: "text"; text: string } | { kind: "missing" } | { kind: "unreadable" };

export function reviewRecordsPath(dir: string, key: PrKey): string {
  return join(dir, key.repo, `${key.pr}.jsonl`);
}

export function movedLegacyPath(legacyFile: string): string {
  return `${legacyFile}.moved`;
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

async function appendLines(dir: string, key: PrKey, records: ReviewRecord[]): Promise<void> {
  const path = reviewRecordsPath(dir, key);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
}

export function appendReviewRecord(dir: string, record: ReviewRecord): Promise<void> {
  return serially(() => appendLines(dir, record, [record]));
}

function parseLegacy(legacyFile: string, text: string): LegacyReviewRecord[] | string {
  if (text.trim() === "") return [];
  let legacy: unknown;
  try {
    legacy = JSON.parse(text);
  } catch {
    return `${legacyFile} is not JSON`;
  }
  if (!Array.isArray(legacy) || !legacy.every(isLegacyReviewRecord)) return `${legacyFile} holds a record that is not a review record`;
  return legacy;
}

function groupByPr(legacy: LegacyReviewRecord[]): ReviewRecord[][] {
  const groups = new Map<string, ReviewRecord[]>();
  for (const old of legacy) {
    const key = `${old.repo}#${old.pr}`;
    const group = groups.get(key) ?? [];
    group.push({ repo: old.repo, pr: old.pr, role: null, head: old.head, verdict: old.verdict, reason: old.reason, at: old.at });
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function moveLegacyReviews(legacyFile: string, dir: string): Promise<LegacyMove> {
  return serially(async (): Promise<LegacyMove> => {
    const file = await readFileText(legacyFile);
    if (file.kind === "missing") return { kind: "none" };
    if (file.kind === "unreadable") return { kind: "failed", reason: `cannot read ${legacyFile}` };
    const legacy = parseLegacy(legacyFile, file.text);
    if (typeof legacy === "string") return { kind: "failed", reason: legacy };
    let count = 0;
    for (const group of groupByPr(legacy)) {
      const existing = await readReviewRecords(dir, group[0]);
      if (existing.kind === "unreadable") return { kind: "failed", reason: `cannot read ${reviewRecordsPath(dir, group[0])}` };
      const present = new Set(existing.records.map((record) => JSON.stringify(record)));
      const missing = group.filter((record) => !present.has(JSON.stringify(record)));
      if (missing.length === 0) continue;
      await appendLines(dir, group[0], missing);
      count += missing.length;
    }
    await rename(legacyFile, movedLegacyPath(legacyFile));
    return { kind: "moved", count };
  });
}
