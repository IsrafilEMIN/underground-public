import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Db = {
  prepare(sql: string): { run(...params: unknown[]): { changes: number | bigint }; all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
  close(): void;
};

export const openDb: (path: string) => Db = process.versions.bun
  ? ((m) => (path: string) => new m.Database(path) as unknown as Db)(await import("bun:sqlite"))
  : ((m) => (path: string) => new m.DatabaseSync(path) as unknown as Db)(await import("node:sqlite"));

export function movePath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
}

export function rewriteSessionText(text: string, from: string, to: string): string | undefined {
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!line.includes('"type":"session"')) return line;
    let entry: { type?: unknown; cwd?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      return line;
    }
    if (entry.type !== "session" || typeof entry.cwd !== "string") return line;
    const cwd = movePath(entry.cwd, from, to);
    if (cwd === entry.cwd) return line;
    changed = true;
    return JSON.stringify({ ...entry, cwd });
  });
  return changed ? lines.join("\n") : undefined;
}

function sessionFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return [];
    if (st.isDirectory()) return sessionFiles(path);
    return name.endsWith(".jsonl") ? [path] : [];
  });
}

export function rewriteSessions(agentDir: string, from: string, to: string): number {
  let n = 0;
  for (const dir of ["sessions", "sessions-set-aside"]) {
    for (const file of sessionFiles(join(agentDir, dir))) {
      const text = rewriteSessionText(readFileSync(file, "utf8"), from, to);
      if (text === undefined) continue;
      writeFileSync(`${file}.migrate`, text);
      renameSync(`${file}.migrate`, file);
      n++;
    }
  }
  return n;
}

export function rewriteHistory(dbPath: string, from: string, to: string): number {
  const db = openDb(dbPath);
  try {
    let n = 0;
    for (const table of ["history", "session_recaps"]) {
      const res = db
        .prepare(`UPDATE ${table} SET cwd = ?1 || substr(cwd, length(?2) + 1) WHERE cwd = ?2 OR substr(cwd, 1, length(?2) + 1) = ?2 || '/'`)
        .run(to, from);
      n += Number(res.changes);
    }
    return n;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [home, from, to] = process.argv.slice(2);
  if (!home || !from || !to) {
    console.error("usage: migrate-paths.ts <agent home> <old home> <new home>");
    process.exit(64);
  }
  const agentDir = join(home, ".omp/agent");
  const files = rewriteSessions(agentDir, from, to);
  const rows = rewriteHistory(join(agentDir, "history.db"), from, to);
  console.log(`session files: ${files}, history rows: ${rows}`);
}
