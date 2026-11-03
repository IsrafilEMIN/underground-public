import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

// The history import writes into the arena from the host, and everything it brings in is readable by
// every agent. These tests try to get a secret, a write through a planted link, or an overwrite past it.

const SCRIPT = join(import.meta.dirname, "../../scripts/import-history.sh");
const FAKE_ANT = `sk-ant-oat01-${"A".repeat(40)}`;
const FAKE_GHS = `ghs_${"b".repeat(36)}`;
const STRATA = "strata-value-1234567890";

async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function fakeHome() {
  const home = await tempDir(join(tmpdir(), "ug-import-"));
  const old = join(home, ".ug/omp/agent/sessions");
  const raw = join(home, ".omp/agent/sessions");
  await mkdir(join(home, ".ug/home"), { recursive: true });
  await put(join(old, "ug-proj-1234abcd/2026-10-30_a.jsonl"), '{"type":"message","text":"clean"}\n');
  await put(join(old, "ug-proj-1234abcd/2026-10-30_a/sub-1.jsonl"), '{"type":"message","text":"subagent"}\n');
  await put(join(old, "author/ug-old-5678ef90/2026-10-29_b.jsonl"), '{"type":"message","text":"role era"}\n');
  await put(join(old, "ug-proj-1234abcd/2026-10-31_leak.jsonl"), `{"text":"key ${FAKE_ANT}"}\n`);
  await put(join(old, "ug-proj-1234abcd/2026-10-31_app.jsonl"), `{"text":"token ${FAKE_GHS}"}\n`);
  await put(join(old, "ug-proj-1234abcd/2026-10-31_strata.jsonl"), `{"text":"${STRATA}"}\n`);
  await put(join(old, "ug-proj-1234abcd/2026-10-31_refresh.jsonl"), '{"text":"{\\"refresh_token\\":\\"abcdefghijklmnopqrstuv\\"}"}\n');
  await put(join(raw, "--Users-me-code--/2026-10-01_c.jsonl"), '{"type":"message","text":"raw"}\n');
  await put(join(home, ".config/strata/api_key"), `${STRATA}\n`);
  return { home, old, raw, target: join(home, ".ug/home/.omp/agent/sessions") };
}

function run(home: string, ...args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], { env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: tmpdir() }, encoding: "utf8" });
}

async function listAll(dir: string, base = dir): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listAll(path, base)));
    else out.push(path.slice(base.length + 1));
  }
  return out.sort();
}

test("import-history without --go changes nothing", async (t) => {
  const { home, old, target } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const before = await listAll(old);
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would do \(run again with --go\): move 3, copy 1/);
  assert.deepEqual(await listAll(old), before);
  assert.equal(existsSync(target), false);
});

test("import-history leaves out every file with a secret, moves the old wrapper's, copies the raw ones, and lifts the role era", async (t) => {
  const { home, old, raw, target } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = run(home, "--go");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await listAll(target), [
    "--Users-me-code--/2026-10-01_c.jsonl",
    "ug-old-5678ef90-author/2026-10-29_b.jsonl",
    "ug-proj-1234abcd/2026-10-30_a.jsonl",
    "ug-proj-1234abcd/2026-10-30_a/sub-1.jsonl",
  ]);
  const arena = (await Promise.all((await listAll(target)).map((f) => readFile(join(target, f), "utf8")))).join("");
  for (const secret of [FAKE_ANT, FAKE_GHS, STRATA, "refresh_token"]) assert.ok(!arena.includes(secret), `${secret} reached the arena`);
  for (const leak of ["leak", "app", "strata", "refresh"]) {
    assert.match(r.stdout, new RegExp(`skip \\(holds a secret or a token shape\\): .*2026-10-31_${leak}\\.jsonl`));
    assert.ok(existsSync(join(old, `ug-proj-1234abcd/2026-10-31_${leak}.jsonl`)), `${leak} left its old place`);
  }
  assert.equal(existsSync(join(old, "ug-proj-1234abcd/2026-10-30_a.jsonl")), false, "the old wrapper's file was not moved");
  assert.ok(existsSync(join(raw, "--Users-me-code--/2026-10-01_c.jsonl")), "the raw file was moved, not copied");
});

test("import-history never writes through a planted link, and never overwrites a file in the arena", async (t) => {
  const { home, target } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const outside = join(home, "outside");
  await mkdir(outside);
  await mkdir(target, { recursive: true });
  await symlink(outside, join(target, "ug-old-5678ef90-author"));
  await put(join(target, "ug-proj-1234abcd/2026-10-30_a.jsonl"), "arena's own\n");
  const r = run(home, "--go");
  assert.notEqual(r.status, 0, "it went on past a planted link");
  assert.match(r.stderr, /must be a folder that you own, not a link/);
  assert.deepEqual(await readdir(outside), [], "it wrote through the link");
  assert.equal(await readFile(join(target, "ug-proj-1234abcd/2026-10-30_a.jsonl"), "utf8"), "arena's own\n");
});

test("import-history refuses a target folder that is a link, before it writes anything", async (t) => {
  const { home } = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const outside = join(home, "outside");
  await mkdir(join(outside, "agent"), { recursive: true });
  await symlink(outside, join(home, ".ug/home/.omp"));
  const r = run(home, "--go");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\.omp must be a folder that you own, not a link/);
  assert.deepEqual(await readdir(join(outside, "agent")), []);
});

test("import-history refuses while a session of this home's arena runs, and ignores another home's", async (t) => {
  const { home, old } = await fakeHome();
  const other = await tempDir(join(tmpdir(), "ug-import-other-"));
  const holder = (h: string) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", join(h, ".ug/run/session.ab12cd/srt.json")], { stdio: "ignore" });
  const otherSession = holder(other);
  t.after(async () => {
    otherSession.kill();
    await rm(home, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  });
  await new Promise((r) => setTimeout(r, 200));
  const before = await listAll(old);
  const free = run(home);
  assert.equal(free.status, 0, `another home's session stopped it: ${free.stderr}`);
  const ownSession = holder(home);
  t.after(() => ownSession.kill());
  await new Promise((r) => setTimeout(r, 200));
  const busy = run(home, "--go");
  assert.notEqual(busy.status, 0);
  assert.match(busy.stderr, /an arena session is running/);
  assert.deepEqual(await listAll(old), before, "it moved files while a session ran");
});
