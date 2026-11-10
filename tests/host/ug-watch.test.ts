import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const JOB = join(import.meta.dirname, "../../host/bin/ug-watch");
const PING = "https://hc-ping.example/uuid";

const FAKE_CURL = `#!/bin/sh
printf '%s\\n' "$*" >>"$HOME/curl"
case "$*" in *--data-binary*) cat >>"$HOME/curl-body" ;; esac
case "$*" in *hc-ping*) exit 0 ;; *healthz*) ;; *) exit 22 ;; esac
case "$*" in *:18765*) [ ! -e "$HOME/usage-down" ] ;; *:4000*) [ ! -e "$HOME/gateway-down" ] ;; *) exit 0 ;; esac
`;

const FAKE_NC = `#!/bin/sh
n=$(cat "$HOME/nc-fails" 2>/dev/null || echo 0)
if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$HOME/nc-fails"; exit 1; fi
`;

const FAKE_LAUNCHCTL = `#!/bin/sh
case "$2" in
*com.underground.backup) if [ -e "$HOME/backup-failed" ]; then printf '\\tlast exit code = 1: Operation not permitted\\n'; else printf '\\tlast exit code = 0\\n'; fi ;;
*com.underground.agent-refresh) printf '\\tusername = ugagent\\n\\tlast exit code = (never exited)\\n' ;;
*com.underground.gh-broker) if [ -e "$HOME/broker-as-owner" ]; then printf '\\tusername = kutluk\\n'; elif [ -e "$HOME/broker-pid-only" ]; then printf '\\tpid = 4242\\n'; elif [ -e "$HOME/broker-pid-gone" ]; then printf '\\tpid = 9191\\n'; else printf '\\tusername = ugbroker\\n'; fi ;;
*com.underground.auth-broker|*com.underground.auth-gateway|*com.underground.usage-broker) printf '\\tusername = ugauth\\n' ;;
*com.underground.agent-sshd) printf '\\tstate = running\\n' ;;
*com.underground.agent-pf) if [ -e "$HOME/pf-stopped" ]; then printf '\\tstate = exited\\n'; elif [ -e "$HOME/pf-failed" ]; then printf '\\tstate = running\\n\\tlast exit code = 1\\n'; else printf '\\tstate = running\\n\\tlast exit code = 0\\n'; fi ;;
*) exit 113 ;;
esac
`;

const FAKE_PS = `#!/bin/sh
[ "$4" = 4242 ] && printf 'kutluk\\n'
`;

async function exe(path: string, text: string) {
  await writeFile(path, text);
  await chmod(path, 0o755);
}

async function fakeHome(t: { after: (fn: () => unknown) => void }, { ping = true } = {}) {
  const home = await tempDir(join(tmpdir(), "ug-watch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const data = join(home, ".local/share/underground");
  const bin = join(home, "fakebin");
  const daemons = join(home, "LaunchDaemons");
  for (const dir of [bin, daemons, join(data, "gh-broker"), join(data, "backup"), join(data, "watch")]) await mkdir(dir, { recursive: true });
  await exe(join(bin, "curl"), FAKE_CURL);
  await exe(join(bin, "nc"), FAKE_NC);
  await exe(join(bin, "launchctl"), FAKE_LAUNCHCTL);
  await exe(join(bin, "ps"), FAKE_PS);
  for (const label of ["com.underground.agent-pf", "com.underground.agent-sshd"])
    await writeFile(join(daemons, `${label}.plist`), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${label}</string>\n</dict>\n</plist>\n`);
  const now = Math.floor(Date.now() / 1000);
  await writeFile(join(data, "gh-broker/status"), `at=${now}\nfailed=\nsocket=ok\n`);
  await writeFile(join(data, "backup/last"), `${now}\n`);
  await writeFile(join(data, "addresses"), "gateway=100.64.0.1:4000\nengine=10.0.0.2:1234\n");
  if (ping) await writeFile(join(data, "watch/ping"), `${PING}\n`);
  return { home, data, bin, daemons };
}

function run(o: { home: string; bin: string; data: string; daemons: string }) {
  return spawnSync("bash", [JOB], {
    env: { HOME: o.home, PATH: `${o.bin}:/usr/bin:/bin`, UG_WATCH_RETRY_SECONDS: "0", UG_GH_BROKER_STATUS: join(o.data, "gh-broker/status"), UG_LAUNCH_DAEMONS: o.daemons },
    encoding: "utf8",
  });
}

const status = (o: { data: string }) => readFile(join(o.data, "watch/status"), "utf8");
const pings = async (o: { home: string }) => (await readFile(join(o.home, "curl"), "utf8")).split("\n").filter((line) => line.includes(PING));

test("ug-watch with every job healthy writes a status with no problem and pings the outside check as up", async (t) => {
  const o = await fakeHome(t);
  const r = run(o);
  assert.equal(r.status, 0, r.stderr);
  assert.match(await status(o), /^at=\d+\n$/);
  const sent = await pings(o);
  assert.equal(sent.length, 1, sent.join("\n"));
  assert.ok(sent[0].endsWith(PING), sent[0]);
  assert.equal(r.stderr, "");
});

test("ug-watch reports each problem that is still there on the second look, and sends only the job names to the outside check", async (t) => {
  const o = await fakeHome(t);
  const old = Math.floor(Date.now() / 1000) - 600;
  await writeFile(join(o.data, "gh-broker/status"), `at=${old}\nfailed=o/secret-repo\n`);
  await writeFile(join(o.data, "backup/last"), `${old - 40 * 3600}\n`);
  await writeFile(join(o.home, "backup-failed"), "");
  await writeFile(join(o.home, "usage-down"), "");
  await writeFile(join(o.home, "gateway-down"), "");
  const r = run(o);
  assert.equal(r.status, 0, r.stderr);
  const lines = (await status(o)).trim().split("\n");
  assert.match(lines[0], /^at=\d+$/);
  assert.deepEqual(
    lines.slice(1).map((line) => line.slice(0, line.indexOf(":"))),
    ["gh-broker", "backup", "backup", "auth gateway", "usage broker"],
  );
  assert.match(lines.join("\n"), /backup: its last run exited with 1/);
  const sent = await pings(o);
  assert.equal(sent.length, 1, sent.join("\n"));
  assert.ok(sent[0].endsWith(`${PING}/fail`), sent[0]);
  const body = await readFile(join(o.home, "curl-body"), "utf8");
  assert.equal(body, "gh-broker\nbackup\nauth gateway\nusage broker\n");
  assert.doesNotMatch(body, /\/Users\/|\/var\/|\d+\.\d+\.\d+\.\d+|secret-repo/, "no path, address, or repo leaves the mac");
  assert.doesNotMatch(r.stderr, /hc-ping/, "the log never holds the secret ping address");
});

test("ug-watch names the repos whose last gh-broker refresh failed", async (t) => {
  const o = await fakeHome(t);
  await writeFile(join(o.data, "gh-broker/status"), `at=${Math.floor(Date.now() / 1000)}\nfailed=o/a o/b\n`);
  run(o);
  assert.match(await status(o), /^gh-broker: the last refresh failed for o\/a o\/b;/m);
});

test("ug-watch reports a daemon that launchd runs as a user other than the one the service table names", async (t) => {
  const o = await fakeHome(t);
  await writeFile(join(o.home, "broker-as-owner"), "");
  run(o);
  assert.match(await status(o), /^gh-broker: launchd runs com\.underground\.gh-broker as kutluk, not ugbroker$/m);
});

test("ug-watch reads the user of a daemon from its pid when launchd prints no user name", async (t) => {
  const o = await fakeHome(t);
  await writeFile(join(o.home, "broker-pid-only"), "");
  run(o);
  assert.match(await status(o), /^gh-broker: launchd runs com\.underground\.gh-broker as kutluk, not ugbroker$/m);
});

test("ug-watch reports the firewall job whose last run exited with 1", async (t) => {
  const o = await fakeHome(t);
  await writeFile(join(o.home, "pf-failed"), "");
  run(o);
  assert.match(await status(o), /^agent pf: its last run exited with 1$/m);
});

test("ug-watch reports a fresh gh-broker status whose own socket check did not answer", async (t) => {
  const o = await fakeHome(t);
  await writeFile(join(o.data, "gh-broker/status"), `at=${Math.floor(Date.now() / 1000)}\nfailed=\nsocket=ECONNREFUSED\n`);
  run(o);
  assert.match(await status(o), /^gh-broker: its socket did not answer its own check \(ECONNREFUSED\); see sudo cat /m);
});

test("ug-watch reports a fresh gh-broker status with no socket line", async (t) => {
  const o = await fakeHome(t);
  await writeFile(join(o.data, "gh-broker/status"), `at=${Math.floor(Date.now() / 1000)}\nfailed=\n`);
  run(o);
  assert.match(await status(o), /^gh-broker: its socket did not answer its own check \(no socket line\); see sudo cat /m);
});

test("ug-watch reports a daemon whose user it cannot read from its pid", async (t) => {
  const o = await fakeHome(t);
  await writeFile(join(o.home, "broker-pid-gone"), "");
  run(o);
  assert.match(await status(o), /^gh-broker: cannot read the user of com\.underground\.gh-broker \(pid 9191\)$/m);
});

test("ug-watch reports a stopped daemon with no plist to read its user from", async (t) => {
  const o = await fakeHome(t);
  await writeFile(join(o.home, "pf-stopped"), "");
  await rm(join(o.daemons, "com.underground.agent-pf.plist"));
  run(o);
  assert.match(await status(o), /^agent pf: cannot read the user of com\.underground\.agent-pf: no user name, no pid, and no readable /m);
});

test("ug-watch reads a stopped root daemon's user from its plist, which names no user", async (t) => {
  const o = await fakeHome(t);
  await writeFile(join(o.home, "pf-stopped"), "");
  const r = run(o);
  assert.equal(r.status, 0, r.stderr);
  assert.match(await status(o), /^at=\d+\n$/);
});

test("ug-watch drops a problem that is gone on the second look, as when the mac has just woken", async (t) => {
  const o = await fakeHome(t);
  await writeFile(join(o.home, "nc-fails"), "1\n");
  run(o);
  assert.match(await status(o), /^at=\d+\n$/);
  assert.ok((await pings(o))[0].endsWith(PING));
});

test("ug-watch without a ping address says so in the status and pings nothing", async (t) => {
  const o = await fakeHome(t, { ping: false });
  run(o);
  assert.match(await status(o), /^watch: .*watch\/ping has no https ping address/m);
  assert.deepEqual(await pings(o), []);
  assert.equal(existsSync(join(o.home, "curl-body")), false);
});
