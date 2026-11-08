import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const SETUP = join(import.meta.dirname, "../../host/bin/ug-setup");

async function copyAt(root: string): Promise<string> {
  await mkdir(join(root, "host/bin"), { recursive: true });
  await mkdir(join(root, "host/lib"), { recursive: true });
  await copyFile(SETUP, join(root, "host/bin/ug-setup"));
  await copyFile(join(import.meta.dirname, "../../host/lib/ug.bash"), join(root, "host/lib/ug.bash"));
  return join(root, "host/bin/ug-setup");
}

test("ug-setup refuses to run from a checkout inside the folder that setup writes, and writes nothing", async (t) => {
  for (const dir of [".local/share/underground"]) {
    const home = await tempDir(join(tmpdir(), "ug-setup-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const setup = await copyAt(join(home, dir, "checkout"));
    const r = spawnSync("bash", [setup], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /which setup itself writes/);
    assert.deepEqual((await readdir(join(home, dir))).sort(), ["checkout"]);
  }
});

test("ug-setup from a checkout outside those folders gets past that guard", async (t) => {
  const home = await tempDir(join(tmpdir(), "ug-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const setup = await copyAt(join(home, "code/underground"));
  const r = spawnSync("bash", [setup], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.notEqual(r.status, 64, r.stderr);
  assert.doesNotMatch(r.stderr, /which setup itself writes/);
  assert.match(r.stderr, /is not a git checkout/);
});

test("ug-setup refuses a checkout that is not at origin/main or has local changes, so only what CI proved is installed", async (t) => {
  const home = await tempDir(join(tmpdir(), "ug-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const checkout = join(home, "code/underground");
  const setup = await copyAt(checkout);
  const git = (...args: string[]) => spawnSync("git", ["-C", checkout, "-c", "user.email=o@x", "-c", "user.name=o", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  git("commit", "-q", "--allow-empty", "-m", "two");
  const ahead = spawnSync("bash", [setup], { env, encoding: "utf8" });
  assert.notEqual(ahead.status, 0);
  assert.match(ahead.stderr, /not origin\/main/);
  git("reset", "-q", "--hard", "origin/main");
  await copyFile(SETUP, join(checkout, "host/bin/ug-setup.bak"));
  const dirty = spawnSync("bash", [setup], { env, encoding: "utf8" });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /not committed/);
});
