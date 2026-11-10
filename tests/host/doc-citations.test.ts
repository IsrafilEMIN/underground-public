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

test("the citation check refuses repo line numbers, missing names, and dead or loose section cites, and accepts names, sections, and outside lines", async (t) => {
  const root = await tempDir(join(tmpdir(), "doc-citations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "host/lib"), { recursive: true });
  await mkdir(join(root, "host/bin"), { recursive: true });
  await mkdir(join(root, "docs"));
  await copyFile(CHECK, join(root, "scripts/check-doc-citations.mjs"));
  await writeFile(join(root, "host/lib/ug.bash"), "ug_render() {\n  :\n}\n");
  await writeFile(join(root, "host/bin/tool"), "echo fine\n");
  await writeFile(join(root, "docs/SPEC.md"), "# Spec\n\n**Backup.** Every snapshot stays.\n\n## Deferred\n");
  await writeFile(join(root, "docs/THREAT-MODEL.md"), "|id|node|\n|---|---|\n|U14|Data out.|\n");
  await writeFile(join(root, "NOTES.md"), "\n");
  const git = spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  assert.equal(spawnSync("git", ["-C", root, "add", "-A"]).status, 0);
  const check = async (text: string, file = "NOTES.md") => {
    await writeFile(join(root, "NOTES.md"), "\n");
    await writeFile(join(root, "host/bin/tool"), "echo fine\n");
    await writeFile(join(root, file), `${text}\n`);
    return spawnSync(process.execPath, [join(root, "scripts/check-doc-citations.mjs")], { encoding: "utf8" });
  };

  for (const [text, reason, file] of [
    ["(`host/lib/ug.bash:2`)", /cites a line of a repo file/],
    ["(`ug.bash:2-3`)", /cites a line of a repo file/],
    ["(`host/bin/removed:9`)", /cites a line of a repo file/],
    ["(`ug_render`, `host/lib/ug.bash`, `:2`)", /cites a line of host\/lib\/ug\.bash/],
    ["(`ug_missing`, `host/lib/ug.bash`)", /`ug_missing` is not in host\/lib\/ug\.bash/],
    ["(`docs/SPEC.md`, B10)", /B10 is not a row of docs\/SPEC\.md/],
    ['(`docs/SPEC.md`, "Watch")', /"Watch" is not a heading or bold label in docs\/SPEC\.md/],
    ["(`docs/SPEC.md`, decision 4)", /after docs\/SPEC\.md, cite a section as/],
    ["every snapshot stays (B10)", /B10 is not a row id of any doc/],
    ['fail "no config (docs/SPEC.md, B10)"', /host\/bin\/tool:1: B10 is not a row of docs\/SPEC\.md/, "host/bin/tool"],
  ] as const) {
    const run = await check(text, file);
    assert.equal(run.status, 1, text);
    assert.match(run.stderr, reason, text);
  }

  const fine = await check(
    '(`ug_render`, `host/lib/ug.bash`) and omp (`model-registry.ts:1636`, v18) on `127.0.0.1:8765`; (`docs/SPEC.md`, "Backup", item 2; `docs/SPEC.md`, "Deferred"; `docs/THREAT-MODEL.md`, U14) and U14; (`docs/SPEC.md`, `docs/THREAT-MODEL.md`)',
  );
  assert.equal(fine.status, 0, fine.stderr);
  const fineScript = await check('fail "see docs/SPEC.md, \\"Backup\\""', "host/bin/tool");
  assert.equal(fineScript.status, 0, fineScript.stderr);
});
