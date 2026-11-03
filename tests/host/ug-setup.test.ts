import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

// Setup points the launchd services, which run with no sandbox and hold the GitHub key, at the code
// of the checkout it runs from. A checkout inside ~/.ug is agent-written, so setup must refuse it
// before it writes anything. The copies here have no VERSIONS file, so a run that gets past the
// guard stops at the first pin read and never reaches the test suite or the host.

const SETUP = join(import.meta.dirname, "../../host/bin/ug-setup");

async function copyAt(root: string): Promise<string> {
  await mkdir(join(root, "host/bin"), { recursive: true });
  await copyFile(SETUP, join(root, "host/bin/ug-setup"));
  return join(root, "host/bin/ug-setup");
}

test("ug-setup refuses to run from a checkout inside ~/.ug, and writes nothing", async (t) => {
  const home = await tempDir(join(tmpdir(), "ug-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const setup = await copyAt(join(home, ".ug/home/work/o/r"));
  const r = spawnSync("bash", [setup], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /is inside ~\/\.ug, where agents write/);
  assert.deepEqual((await readdir(join(home, ".ug"))).sort(), ["home"]);
});

test("ug-setup from a checkout outside ~/.ug gets past that guard", async (t) => {
  const home = await tempDir(join(tmpdir(), "ug-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const setup = await copyAt(join(home, "code/underground"));
  const r = spawnSync("bash", [setup], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.notEqual(r.status, 64, r.stderr);
  assert.doesNotMatch(r.stderr, /inside ~\/\.ug/);
  assert.match(r.stderr, /bad pin for omp in VERSIONS/);
});
