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
  const data = join(home, ".local/share/underground");
  const install = spawnSync("bash", ["-c", `
    set -euo pipefail
    src=${JSON.stringify(checkout)}
    data=${JSON.stringify(data)}
    bin_dir=${JSON.stringify(join(home, ".local/bin"))}
    cleanup=()
    install -d -m 700 "$data" "$bin_dir"
    eval "$(sed -n '/^put() {/,/^}/p;/^link() {/,/^}/p;/^install_service_code() {/,/^}/p' "$src/host/bin/ug-setup")"
    install_service_code
  `], { encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  await rm(checkout, { recursive: true, force: true });
  await mkdir(join(home, "fakebin"));
  await writeFile(join(home, "fakebin/sudo"), '#!/bin/sh\necho "SUDO $*"\n');
  await chmod(join(home, "fakebin/sudo"), 0o755);
  return home;
}

const run = (home: string, ...args: string[]) =>
  spawnSync(join(home, ".local/bin/ug-auth"), args, {
    env: { HOME: home, PATH: `${join(home, "fakebin")}:/usr/bin:/bin`, PI_CONFIG_DIR: ".elsewhere", OMP_PROFILE: "x" },
    encoding: "utf8",
  });

test("the installed ug-auth runs the pinned omp as ugauth in a clean environment, with the checkout gone", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const omp = `/Library/Underground/omp/${PIN}/omp`;
  const login = run(home, "auth-broker", "login", "anthropic");
  assert.equal(login.status, 0, login.stderr);
  assert.equal(login.stdout.trim(), `SUDO -u ugauth -H /usr/bin/env -i HOME=/Users/ugauth PATH=/usr/bin:/bin ${omp} auth-broker login anthropic`);
  const token = run(home, "auth-gateway", "token", "--regenerate");
  assert.equal(token.status, 0, token.stderr);
  assert.equal(
    token.stdout.trim(),
    `SUDO -u ugauth -H /usr/bin/env -i HOME=/Users/ugauth PATH=/usr/bin:/bin OMP_AUTH_BROKER_URL=http://127.0.0.1:8765 ${omp} auth-gateway token --regenerate`,
  );
});

test("ug-auth key hands the pasted key to the login user's broker upload through its environment, never an argument", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "fakebin/sudo"), '#!/bin/sh\necho "SUDO_ARGS $*" >&2\nshift 3\nexec "$@"\n');
  const root = join(home, "root");
  await mkdir(join(root, "omp", PIN), { recursive: true });
  await writeFile(join(root, "omp", PIN, "omp"), '#!/bin/sh\necho "OMP_ARGS $*"\necho "OMP_KEY ${ANTHROPIC_API_KEY-unset} ${OMP_AUTH_BROKER_URL-unset}"\n');
  await chmod(join(root, "omp", PIN, "omp"), 0o755);
  const key = "sk-ant-test-0123456789";
  const r = spawnSync(join(home, ".local/bin/ug-auth"), ["key", "ANTHROPIC_API_KEY"], {
    env: { HOME: home, PATH: `${join(home, "fakebin")}:/usr/bin:/bin`, UG_ROOT: root },
    input: `${key}\n`,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^OMP_ARGS auth-broker migrate --from-local --include-env$/m);
  assert.match(r.stdout, new RegExp(`^OMP_KEY ${key} http://127.0.0.1:8765$`, "m"));
  assert.doesNotMatch(r.stderr, new RegExp(key), "the key must not be in any argument");
  for (const bad of [["key"], ["key", "anthropic"], ["key", "ANTHROPIC_API_KEY", "x"]]) assert.equal(run(home, ...bad).status, 64, bad.join(" "));
});

test("ug-auth refuses anything that is not an auth command, so it never starts a session with every login", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const args of [[], ["-p", "hi"], ["--version"], ["config", "list"], ["auth-brokerx"], ["--", "auth-broker"]]) {
    const r = run(home, ...args);
    assert.equal(r.status, 64, `${args.join(" ")}: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /SUDO/, `${args.join(" ")} started omp`);
  }
});
