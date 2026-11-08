import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb, rewriteHistory, rewriteSessionText, rewriteSessions } from "../../host/agent/migrate-paths.ts";

const FROM = "/home/agent";
const TO = "/Users/ugagent";

test("a session header cwd under the old home moves to the new home", () => {
  const text = JSON.stringify({ type: "session", id: "s1", cwd: "/home/agent/proj/app" });
  const out = rewriteSessionText(text, FROM, TO);
  assert.equal(out, JSON.stringify({ type: "session", id: "s1", cwd: "/Users/ugagent/proj/app" }));
});

test("a session header cwd elsewhere stays, and no change returns undefined", () => {
  const text = JSON.stringify({ type: "session", id: "s1", cwd: "/srv/data" });
  assert.equal(rewriteSessionText(text, FROM, TO), undefined);
});

test("other lines that mention the old path are untouched", () => {
  const header = JSON.stringify({ type: "session", id: "s1", cwd: "/home/agent" });
  const message = JSON.stringify({ type: "message", text: "open /home/agent/notes.md" });
  const out = rewriteSessionText([header, message].join("\n"), FROM, TO);
  assert.equal(out, [JSON.stringify({ type: "session", id: "s1", cwd: "/Users/ugagent" }), message].join("\n"));
});

test("rewriteSessions rewrites only the session files that change", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "migrate-sessions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions/proj");
  await mkdir(sessions, { recursive: true });
  const moved = join(sessions, "a.jsonl");
  const kept = join(sessions, "b.jsonl");
  await writeFile(moved, JSON.stringify({ type: "session", cwd: "/home/agent/x" }));
  await writeFile(kept, JSON.stringify({ type: "session", cwd: "/srv/y" }));
  assert.equal(rewriteSessions(dir, FROM, TO), 1);
  assert.equal(await readFile(moved, "utf8"), JSON.stringify({ type: "session", cwd: "/Users/ugagent/x" }));
  assert.equal(await readFile(kept, "utf8"), JSON.stringify({ type: "session", cwd: "/srv/y" }));
});

test("history and session_recaps cwd rows move, and other rows stay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "migrate-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "history.db");
  const db = openDb(dbPath);
  db.exec("CREATE TABLE history (cwd TEXT)");
  db.exec("CREATE TABLE session_recaps (cwd TEXT)");
  for (const cwd of ["/home/agent", "/home/agent/proj", "/home/agent2", "/srv/z"]) {
    db.prepare("INSERT INTO history (cwd) VALUES (?1)").run(cwd);
    db.prepare("INSERT INTO session_recaps (cwd) VALUES (?1)").run(cwd);
  }
  db.close();

  assert.equal(rewriteHistory(dbPath, FROM, TO), 4);

  const check = openDb(dbPath);
  const rows = (table: string) => (check.prepare(`SELECT cwd FROM ${table} ORDER BY rowid`).all() as { cwd: string }[]).map((r) => r.cwd);
  assert.deepEqual(rows("history"), ["/Users/ugagent", "/Users/ugagent/proj", "/home/agent2", "/srv/z"]);
  assert.deepEqual(rows("session_recaps"), ["/Users/ugagent", "/Users/ugagent/proj", "/home/agent2", "/srv/z"]);
  check.close();
});
