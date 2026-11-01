import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { displayPrefs } from "../../host/broker/display-prefs.ts";
import { tempDir } from "../temp.ts";

const SRC = join(import.meta.dirname, "../..");
const SCRIPT = join(SRC, "host/broker/display-prefs.ts");
const pin = /^omp=(.+)$/m.exec(await readFile(join(SRC, "VERSIONS"), "utf8"))?.[1] ?? "";
const OMP = join(homedir(), "Library/Application Support/Tern/omp/versions", pin);
const skip = existsSync(OMP) ? false : `needs the pinned omp ${pin} at ${OMP} to run the script under Bun`;

let root: string;

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-prefs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makePrefs(ownerConfig: string, out: string): { status: number | null; stderr: string } {
  return spawnSync(OMP, [SCRIPT, ownerConfig, out], { cwd: "/", env: { ...process.env, BUN_BE_BUN: "1" }, encoding: "utf8" });
}

test("an empty owner config, which YAML reads as null, gives no display prefs", () => {
  assert.deepEqual(displayPrefs(null), {});
  assert.deepEqual(displayPrefs(undefined), {});
});

test("the script writes the owner's display keys only", { skip }, async () => {
  const ownerConfig = join(root, "config.yml");
  const out = join(root, "prefs.json");
  await writeFile(ownerConfig, "theme:\n  dark: dark\nmodelRoles:\n  default: x\n");
  const made = makePrefs(ownerConfig, out);
  assert.equal(made.status, 0, made.stderr);
  assert.deepEqual(JSON.parse(await readFile(out, "utf8")), { theme: { dark: "dark" } });
});

test("an empty owner config makes empty prefs, and the script succeeds", { skip }, async () => {
  const ownerConfig = join(root, "config.yml");
  const out = join(root, "prefs.json");
  await writeFile(ownerConfig, "");
  const made = makePrefs(ownerConfig, out);
  assert.equal(made.status, 0, made.stderr);
  assert.deepEqual(JSON.parse(await readFile(out, "utf8")), {});
});

test("an owner config that is not YAML is reported, roles get empty prefs, and the script still succeeds", { skip }, async () => {
  const ownerConfig = join(root, "config.yml");
  const out = join(root, "prefs.json");
  await writeFile(ownerConfig, "theme: [dark\n  statusLine: {\n");
  const made = makePrefs(ownerConfig, out);
  assert.equal(made.status, 0, made.stderr);
  assert.ok(made.stderr.startsWith(`display-prefs: ${ownerConfig}: `), made.stderr);
  assert.match(made.stderr, /roles keep omp's default look\n$/);
  assert.deepEqual(JSON.parse(await readFile(out, "utf8")), {});
  assert.deepEqual((await readdir(root)).sort(), ["config.yml", "prefs.json"]);
});
