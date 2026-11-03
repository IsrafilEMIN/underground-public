import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

// ug-auth starts the pinned omp on the host, with no sandbox, against the root that holds every
// login. So it must run nothing but the two auth command groups, and always with that root.

const UG_AUTH = join(import.meta.dirname, "../../host/bin/ug-auth");
const PIN = /^omp=(.+)$/m.exec(await readFile(join(import.meta.dirname, "../../VERSIONS"), "utf8"))?.[1] ?? "";

async function fakeHome() {
  const home = await tempDir(join(tmpdir(), "ug-auth-"));
  const dir = join(home, ".ug/sys/omp", PIN);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "omp"), '#!/bin/sh\necho "RAN PI_CONFIG_DIR=$PI_CONFIG_DIR ARGS=$*"\n');
  await chmod(join(dir, "omp"), 0o755);
  return home;
}

const run = (home: string, ...args: string[]) =>
  spawnSync("bash", [UG_AUTH, ...args], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });

test("ug-auth runs the auth commands against ~/.ug/host/auth", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const args of [["auth-broker", "login", "anthropic"], ["auth-gateway", "token", "--regenerate"]]) {
    const r = run(home, ...args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `RAN PI_CONFIG_DIR=.ug/host/auth ARGS=${args.join(" ")}`);
  }
});

test("ug-auth refuses anything that is not an auth command, so it never starts a session with every login", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const args of [[], ["-p", "hi"], ["--version"], ["config", "list"], ["auth-brokerx"], ["--", "auth-broker"]]) {
    const r = run(home, ...args);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /RAN/, `${args.join(" ")} started omp`);
  }
});
