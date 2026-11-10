import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const ROOT = join(import.meta.dirname, "../..");
const CHECK = join(ROOT, "scripts/check-doc-citations.mjs");

test("the docs cite no line of a repo file, and each cited name is in its file", () => {
  const run = spawnSync(process.execPath, [CHECK], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

test("the citation check refuses repo line numbers and missing names, and accepts names and outside lines", async (t) => {
  const root = await tempDir(join(tmpdir(), "doc-citations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "host/lib"), { recursive: true });
  await copyFile(CHECK, join(root, "scripts/check-doc-citations.mjs"));
  await writeFile(join(root, "host/lib/ug.bash"), "ug_render() {\n  :\n}\n");
  await writeFile(join(root, "NOTES.md"), "\n");
  const git = spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  assert.equal(spawnSync("git", ["-C", root, "add", "-A"]).status, 0);
  const check = async (text: string) => {
    await writeFile(join(root, "NOTES.md"), `${text}\n`);
    return spawnSync(process.execPath, [join(root, "scripts/check-doc-citations.mjs")], { encoding: "utf8" });
  };

  for (const [text, reason] of [
    ["(`host/lib/ug.bash:2`)", /cites a line of a repo file/],
    ["(`ug.bash:2-3`)", /cites a line of a repo file/],
    ["(`host/bin/removed:9`)", /cites a line of a repo file/],
    ["(`ug_render`, `host/lib/ug.bash`, `:2`)", /cites a line of host\/lib\/ug\.bash/],
    ["(`ug_missing`, `host/lib/ug.bash`)", /`ug_missing` is not in host\/lib\/ug\.bash/],
  ] as const) {
    const run = await check(text);
    assert.equal(run.status, 1, text);
    assert.match(run.stderr, reason, text);
  }

  const fine = await check("(`ug_render`, `host/lib/ug.bash`) and omp (`model-registry.ts:1636`, v18) on `127.0.0.1:8765`");
  assert.equal(fine.status, 0, fine.stderr);
});
