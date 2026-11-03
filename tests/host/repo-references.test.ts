import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const ROOT = join(import.meta.dirname, "../..");
const CHECK = join(ROOT, "scripts/check-repo-references.mjs");

test("release files contain no fixed repository identity", () => {
  const run = spawnSync(process.execPath, [CHECK], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

test("release guard rejects fixed identities and accepts checkout placeholders", async (t) => {
  const root = await tempDir(join(tmpdir(), "repo-references-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  const check = join(root, "scripts/check-repo-references.mjs");
  await copyFile(CHECK, check);
  for (const args of [["init", "--quiet"], ["add", "AGENTS.md", "scripts/check-repo-references.mjs"]]) {
    await writeFile(join(root, "AGENTS.md"), "broker sync <owner/repo>\n");
    const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  }
  for (const text of [
    "broker sync Previous-Owner/previous-repo",
    "REPO=Previous-Owner/previous-repo",
    "repo_url=git@github.com:Previous-Owner/previous-repo.git",
    "https://github.com/Previous-Owner/previous-repo",
    "Merge pull request #1 from Previous-Owner/agent/work",
  ]) {
    await writeFile(join(root, "AGENTS.md"), `${text}\n`);
    const run = spawnSync(process.execPath, [check], { encoding: "utf8" });
    assert.equal(run.status, 1, text);
    assert.match(run.stderr, /AGENTS\.md:1: fixed repository identity/);
  }
  await writeFile(join(root, "AGENTS.md"), "broker sync <owner/repo>\nhttps://github.com/settings/apps/new\n");
  const run = spawnSync(process.execPath, [check], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
