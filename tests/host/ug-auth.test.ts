import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const SRC = join(import.meta.dirname, "../..");
const PIN = /^omp=(.+)$/m.exec(await readFile(join(SRC, "VERSIONS"), "utf8"))?.[1] ?? "";

async function fakeHome() {
  const home = await tempDir(join(tmpdir(), "ug-auth-"));
  const checkout = join(home, "checkout");
  for (const f of ["host/bin", "host/lib", "host/gh-broker", "host/facts", "host/services", "VERSIONS"]) await cp(join(SRC, f), join(checkout, f), { recursive: true });
  const data = join(home, ".local/share/underground");
  const install = spawnSync("bash", ["-c", `
    set -euo pipefail
    src=${JSON.stringify(checkout)}
    data=${JSON.stringify(data)}
    bin_dir=${JSON.stringify(join(home, ".local/bin"))}
    cleanup=()
    install -d -m 700 "$data" "$bin_dir"
    source "$src/host/lib/ug.bash"
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
  const short = run(home, "login", "anthropic");
  assert.equal(short.status, 0, short.stderr);
  assert.equal(short.stdout, login.stdout, "ug-auth login <provider> is the short form of auth-broker login");
  for (const bad of [["login", "anthropic", "x"], ["login", "--via=owner@host"]]) assert.equal(run(home, ...bad).status, 64, bad.join(" "));
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

test("ug-auth list shows each credential with its key redacted, and revoke turns off one id through the broker", async (t) => {
  const home = await fakeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const key = "sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCD";
  const bearer = "broker-bearer-0123456789";
  const credentials = [
    { id: 3, provider: "anthropic", credential: { type: "oauth", refresh: "x", access: "oauth-access-secret", expires: 1, email: "owner@example.com" }, identityKey: "email:owner@example.com", rotatesInMs: null },
    { id: 7, provider: "anthropic", credential: { type: "api_key", key }, identityKey: null, rotatesInMs: null },
  ];
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization} ${body}`);
      const known = req.url === "/v1/snapshot" || req.url === "/v1/credential/7/disable";
      res.writeHead(known ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url === "/v1/snapshot" ? { generation: 1, credentials } : { ok: known }));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await mkdir(join(home, "ugauth/.omp"), { recursive: true });
  await writeFile(join(home, "ugauth/.omp/auth-broker.token"), `${bearer}\n`);
  await writeFile(
    join(home, "fakebin/sudo"),
    `#!/bin/sh\necho "SUDO_ARGS $*" >&2\nshift 3\nfor a; do case $a in HOME=*) a=HOME=${join(home, "ugauth")} ;; OMP_AUTH_BROKER_URL=*) a=OMP_AUTH_BROKER_URL=http://127.0.0.1:${address.port} ;; esac; set -- "$@" "$a"; shift; done\nexec "$@"\n`,
  );
  const ugAuth = (...args: string[]) => {
    const { promise, resolve } = Promise.withResolvers<{ status: number | null; stdout: string; stderr: string }>();
    const child = spawn(join(home, ".local/bin/ug-auth"), args, { env: { HOME: home, PATH: `${join(home, "fakebin")}:/usr/bin:/bin` } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    return promise;
  };

  const list = await ugAuth("list");
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.stdout.trim().split("\n").slice(1), ["3\tanthropic\toauth\towner@example.com", "7\tanthropic\tapi_key\tsk-ant-api03-0123...ABCD"]);

  const revoke = await ugAuth("revoke", "7");
  assert.equal(revoke.status, 0, revoke.stderr);
  assert.match(revoke.stdout, /^7\tanthropic\tapi_key\tsk-ant-api03-0123\.\.\.ABCD$/m);
  assert.deepEqual(seen.filter((line) => line.startsWith("POST")), [`POST /v1/credential/7/disable Bearer ${bearer} {"cause":"logged out by user"}`]);

  const missing = await ugAuth("revoke", "9");
  assert.equal(missing.status, 1, missing.stdout);
  assert.equal(seen.filter((line) => line.startsWith("POST")).length, 1, "an unknown id must not reach the disable route");

  for (const r of [list, revoke, missing]) {
    for (const secret of [key, bearer, "oauth-access-secret"]) assert.ok(!`${r.stdout}${r.stderr}`.includes(secret), `${secret} was printed or passed as an argument`);
  }
  for (const bad of [["list", "x"], ["revoke"], ["revoke", "7x"], ["revoke", "7", "8"]]) assert.equal(run(home, ...bad).status, 64, bad.join(" "));
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
