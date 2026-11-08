import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

test("ug-setup refuses to run from a checkout inside a folder that setup writes, and writes nothing", async (t) => {
  for (const dir of [".ug", ".local/share/underground"]) {
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

function migrate(home: string) {
  const stub = join(home, "stub");
  return spawnSync("bash", ["-c", `
    set -euo pipefail
    mkdir -p ${JSON.stringify(stub)}
    printf '#!/bin/sh\\necho "$*" >> ${join(home, "launchctl-calls")}\\n' > ${JSON.stringify(join(stub, "launchctl"))}
    chmod +x ${JSON.stringify(join(stub, "launchctl"))}
    PATH=${JSON.stringify(stub)}:$PATH
    data="$HOME/.local/share/underground"; old_ug="$HOME/.ug"; auth_root="$HOME/.omp/profiles/ug-auth"; labels="com.underground.auth-broker"
    die() { printf 'ug-setup: %s\\n' "$*" >&2; exit 1; }
    eval "$(sed -n '/^stop_services() {/,/^}/p;/^migrate_ug() {/,/^}/p;/^remove_old_ug() {/,/^}/p' ${JSON.stringify(SETUP)})"
    migrate_ug
    remove_old_ug
  `], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
}

async function oldHome() {
  const home = await tempDir(join(tmpdir(), "ug-migrate-"));
  for (const dir of [".ug/host/auth/agent", ".ug/host/gh-broker/pushes", ".ug/sys/restic/0.19.1", ".ug/sys/omp/1.0", ".ug/run", ".ug/home"]) {
    await mkdir(join(home, dir), { recursive: true });
  }
  await writeFile(join(home, ".ug/host/auth/agent/agent.db"), "logins");
  await writeFile(join(home, ".ug/host/github-app.pem"), "key");
  await writeFile(join(home, ".ug/host/gh-broker/pushes/owner%2Frepo"), "sha");
  await writeFile(join(home, ".ug/sys/restic/0.19.1/restic"), "restic");
  return home;
}

test("setup moves the logins into the ug-auth profile and the rest into the data folder, and keeps what it did not write in ~/.ug", async (t) => {
  const home = await oldHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const r = migrate(home);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(join(home, ".omp/profiles/ug-auth/agent/agent.db"), "utf8"), "logins");
  const data = join(home, ".local/share/underground");
  assert.equal(await readFile(join(data, "github-app.pem"), "utf8"), "key");
  assert.equal(await readFile(join(data, "gh-broker/pushes/owner%2Frepo"), "utf8"), "sha");
  assert.equal(await readFile(join(data, "restic/0.19.1/restic"), "utf8"), "restic");
  assert.equal(existsSync(join(data, "auth")), false, "the logins must not stay in the data folder");
  assert.deepEqual(await readdir(join(home, ".ug")), ["home"]);
  assert.match(r.stderr, /still holds files that setup did not write: home/);
  assert.equal(migrate(home).status, 0, "a second run must be a no-op");
});

test("setup refuses to migrate when the data folder already exists, and moves nothing, not even the logins", async (t) => {
  const home = await oldHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".local/share/underground"), { recursive: true });
  const r = migrate(home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /both .*\.ug\/host and .* exist/);
  assert.equal(await readFile(join(home, ".ug/host/auth/agent/agent.db"), "utf8"), "logins");
  assert.equal(existsSync(join(home, ".omp")), false);
  assert.equal(existsSync(join(home, ".ug/sys/omp/1.0")), true, "nothing is deleted on a refusal");
  assert.equal(existsSync(join(home, "launchctl-calls")), false, "the services keep running on a refusal");
});
