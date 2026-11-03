import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

// The probe must never pass a check that it did not prove. These tests run it against a fake srt
// in a fake home: a leaky one that runs every command with no sandbox, and a broken one that runs
// nothing. Against the leaky one, every breach attempt must report a BREACH. Against the broken one,
// no check may PASS, because its control fails.

const SRC = join(import.meta.dirname, "../..");
const PROBE = join(SRC, "scripts/probe-arena.sh");
const versions = await readFile(join(SRC, "VERSIONS"), "utf8");
const pinOf = (name: string) => new RegExp(`^${name}=(.+)$`, "m").exec(versions)?.[1] ?? "";
const OMP_PIN = pinOf("omp");
const SRT_PIN = pinOf("srt");

const LEAKY = `const i = process.argv.indexOf("--");
const r = require("child_process").spawnSync(process.argv[i + 1], process.argv.slice(i + 2), { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`;
const BROKEN = `process.stderr.write("srt: cannot start\\n"); process.exit(1);
`;

async function fakeHome(srt: string): Promise<string> {
  const home = await tempDir(join(tmpdir(), "probe-arena-"));
  const ompDir = join(home, ".ug/sys/omp", OMP_PIN);
  const srtDir = join(home, ".ug/sys/srt", SRT_PIN, "node_modules/@anthropic-ai/sandbox-runtime/dist");
  await mkdir(ompDir, { recursive: true });
  await mkdir(srtDir, { recursive: true });
  await mkdir(join(home, ".ug/host"), { recursive: true });
  await writeFile(join(srtDir, "cli.js"), srt);
  // A fake omp that does what the probe asks of a working omp, so only the sandbox is under test.
  await writeFile(
    join(ompDir, "omp"),
    `#!/bin/sh
case "$1" in
  --version) echo "omp ${OMP_PIN}" ;;
  -p) mkdir -p "$HOME/.omp/agent/sessions" && touch "$HOME/.omp/agent/sessions/probe" && echo 391 ;;
  -e) exec "${process.execPath}" -e "$2" ;;
  auth-gateway)
    # The stdio gateway: it lists the ids in ~/.ug/fake-models, one per line, plus strata/qwen when
    # STRATA_API_KEY is set; ~/.ug/fake-models-broken makes it answer with no list.
    [ "$2" = stdio ] || exit 64
    exec "${process.execPath}" -e '
      const fs = require("fs");
      fs.readFileSync(0);
      const dir = process.env.HOME + "/.ug/";
      console.log(JSON.stringify({ ready: true, version: "${OMP_PIN}" }));
      if (fs.existsSync(dir + "fake-models-broken")) {
        console.log(JSON.stringify({ id: 1, status: 500, body: { error: "boom" } }));
        process.exit(0);
      }
      const ids = fs.existsSync(dir + "fake-models") ? fs.readFileSync(dir + "fake-models", "utf8").split("\\n").filter(Boolean) : [];
      if (process.env.STRATA_API_KEY) ids.push("strata/qwen");
      console.log(JSON.stringify({ id: 1, status: 200, body: { object: "list", data: ids.map((id) => ({ id })) } }));
    '
    ;;
esac
`,
  );
  await chmod(join(ompDir, "omp"), 0o755);
  await mkdir(join(home, ".omp"), { recursive: true });
  await mkdir(join(home, ".ug/host/auth"), { recursive: true });
  await writeFile(join(home, ".ug/host/auth/auth-gateway.token"), "test-bearer\n");
  await writeFile(join(home, ".ug/host/addresses"), "gateway=192.0.2.1:4000\nengine=192.0.2.2:8081\n");
  // The arena backup's password and config (docs/SPEC.md, B10).
  await mkdir(join(home, ".ug/host/backup"), { recursive: true });
  await writeFile(join(home, ".ug/host/backup/password"), "backup-password-for-the-probe\n");
  await writeFile(join(home, ".ug/host/backup/config"), "repo=sftp:owner@other-box:backups/arena\n");
  return home;
}

function runProbe(home: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ...extra,
    HOME: home,
    USER: "probe",
    LOGNAME: "probe",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    UG_PROBE_NODE: process.execPath,
  };
  const run = spawnSync("bash", [PROBE], { env, encoding: "utf8", timeout: 120_000 });
  const lines = run.stdout.split("\n");
  const result = (name: string) => lines.find((l) => l.split(/\s+/)[1] === name) ?? "";
  return { run, lines, result };
}

const DENY_CHECKS = ["read-deny", "omp-read", "write-deny", "symlink", "hardlink", "backup-password", "backup-config"];

test("probe-arena reports a BREACH for every deny check when srt runs commands with no sandbox", async (t) => {
  const home = await fakeHome(LEAKY);
  t.after(() => rm(home, { recursive: true, force: true }));
  const { run, result } = runProbe(home);
  assert.match(result("control"), /^PASS /, run.stdout + run.stderr);
  for (const name of DENY_CHECKS) {
    assert.match(result(name), /^FAIL\s+\S+\s+BREACH:/, `${name}\n${run.stdout}${run.stderr}`);
  }
  assert.doesNotMatch(result("egress"), /^PASS /, run.stdout);
  // The fake omp answers any prompt, so a raw omp on the host answers too: that must be a breach.
  assert.match(result("raw-omp"), /^FAIL\s+\S+\s+BREACH:/, run.stdout);
  assert.match(result("raw-models"), /^PASS /, run.stdout);
  assert.doesNotMatch(result("home-reach"), /^PASS /, run.stdout);
  assert.notEqual(run.status, 0, run.stdout);
});

test("probe-arena passes no check when srt cannot start, because the control fails", async (t) => {
  const home = await fakeHome(BROKEN);
  t.after(() => rm(home, { recursive: true, force: true }));
  const { run, lines, result } = runProbe(home);
  assert.match(result("control"), /^FAIL /, run.stdout + run.stderr);
  assert.match(result("breaches"), /^INC /, run.stdout);
  // pin and raw-models run on the host with no srt, and each has its own control.
  const hostChecks = ["pin", "raw-models"];
  assert.deepEqual(lines.filter((l) => l.startsWith("PASS ") && !hostChecks.includes(l.split(/\s+/)[1])), [], run.stdout);
  assert.notEqual(run.status, 0, run.stdout);
});

test("probe-arena lists every model that a raw omp can call, in the caller's own environment", async (t) => {
  const home = await fakeHome(LEAKY);
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, ".ug/fake-models"), "apple/on-device\nlm-studio/qwen\n");
  const keyless = runProbe(home).result("raw-models");
  assert.match(keyless, /^FAIL\s+\S+\s+BREACH:.*apple\/on-device lm-studio\/qwen;/, keyless);
  await rm(join(home, ".ug/fake-models"));
  // A key in the owner's shell reaches a raw omp, so the check must not start from env -i.
  const shell = runProbe(home, { STRATA_API_KEY: "from-the-shell" });
  assert.match(shell.result("raw-models"), /^FAIL\s+\S+\s+BREACH:.*strata\/qwen/, shell.run.stdout);
  assert.match(runProbe(home).result("raw-models"), /^PASS /);
});

test("probe-arena: a raw omp's model list that does not come back is inconclusive, not a pass", async (t) => {
  const home = await fakeHome(LEAKY);
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, ".ug/fake-models-broken"), "");
  const { run, result } = runProbe(home);
  assert.match(result("raw-models"), /^INC\s+\S+\s+the raw omp gave no model list/, run.stdout);
});

test("probe-arena leaves no canary, write target, or probe arena behind", async (t) => {
  const home = await fakeHome(LEAKY);
  t.after(() => rm(home, { recursive: true, force: true }));
  runProbe(home);
  for (const left of [".ug-probe-canary", ".ug-probe-write", ".ug/probe", ".ug/run/probe-arena.json"]) {
    const ls = spawnSync("test", ["-e", join(home, left)]);
    assert.notEqual(ls.status, 0, `${left} is still there`);
  }
});

const SSH_AGENT = "/usr/bin/ssh-agent";

test("probe-arena reports a BREACH when the sandbox reaches the ssh agent, directly or through a socket link", { skip: !existsSync(SSH_AGENT) && `no ${SSH_AGENT}` }, async (t) => {
  const home = await fakeHome(LEAKY);
  const sock = join(home, "agent.sock");
  const agent = spawn(SSH_AGENT, ["-D", "-a", sock], { stdio: "ignore" });
  t.after(async () => {
    agent.kill();
    await rm(home, { recursive: true, force: true });
  });
  for (let i = 0; i < 50 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(sock), "ssh-agent did not make its socket");
  const { run, result } = runProbe(home, { SSH_AUTH_SOCK: sock });
  assert.match(result("ssh-agent"), /^FAIL\s+\S+\s+BREACH:/, run.stdout + run.stderr);
  assert.match(result("socket-link"), /^FAIL\s+\S+\s+BREACH:/, run.stdout + run.stderr);
});
