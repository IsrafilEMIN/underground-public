import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const SRC = join(import.meta.dirname, "../..");
const PIN = /^omp=(.+)$/m.exec(await readFile(join(SRC, "VERSIONS"), "utf8"))?.[1] ?? "";

async function fakeHome() {
  const home = await tempDir(join(tmpdir(), "ug-auth-"));
  const checkout = join(home, "checkout");
  for (const f of ["host/bin", "host/lib", "host/gh-broker", "VERSIONS"]) await cp(join(SRC, f), join(checkout, f), { recursive: true });
  const sys = join(home, ".ug/sys");
  const install = spawnSync("bash", ["-c", `
    set -euo pipefail
    src=${JSON.stringify(checkout)}
    sys=${JSON.stringify(sys)}
    cleanup=()
    install -d -m 700 "$sys" "$sys/bin"
    eval "$(sed -n '/^put() {/,/^}/p;/^link() {/,/^}/p;/^install_service_code() {/,/^}/p' "$src/host/bin/ug-setup")"
    install_service_code
  `], { encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  await rm(checkout, { recursive: true, force: true });
  const dir = join(sys, "omp", PIN);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "omp"), '#!/bin/sh\necho "RAN PI_CONFIG_DIR=$PI_CONFIG_DIR ARGS=$*"\n');
  await chmod(join(dir, "omp"), 0o755);
  return home;
}

const run = (home: string, ...args: string[]) =>
  spawnSync(join(home, ".ug/sys/bin/ug-auth"), args, { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });

test("the installed ug-auth runs the auth commands against ~/.ug/host/auth with the checkout gone", async (t) => {
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
