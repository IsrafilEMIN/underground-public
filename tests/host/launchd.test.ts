import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";
import { factTokens, services } from "./render.ts";

const DIR = join(import.meta.dirname, "../../host/launchd");
const LIB = join(import.meta.dirname, "../../host/lib/ug.bash");
const AGENT_DIR = join(import.meta.dirname, "../../host/agent");
const FILLED = new Set(["@DATA@", ...(await factTokens())]);
const DAEMON_FILLED = new Set(["@OMP@", "@GH@", "@GATEWAY@", "@ENGINE@", ...(await factTokens())]);
const ROWS = await services();
const DAEMONS = ROWS.filter((row) => row.user === "auth_user").map((row) => row.label);

test("the service table reads each field in its own column, even when a middle field is empty", () => {
  const sshd = ROWS.find((row) => row.label === "com.underground.agent-sshd");
  assert.ok(sshd, "the table has the agent sshd");
  assert.equal(sshd.log, "");
  assert.match(sshd.inputs, /sshd_config/);
});

test("every token in the service table names a fact or a token setup fills", async () => {
  const facts = new Set(await factTokens());
  const special: Record<string, true> = { "@DATA@": true, "@GATEWAY@": true, "@OMP_SHA@": true };
  for (const row of ROWS)
    for (const token of [row.health, row.log, row.inputs].join(" ").match(/@[A-Z_]+@/g) ?? [])
      assert.ok(facts.has(token) || token in special, `${row.label}: ${token}`);
});

const programArguments = (text: string): string[] => {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
};

test("every owner launchd template uses only the placeholders that setup fills, so none can name the checkout", async () => {
  const files = (await readdir(DIR)).filter((n) => n.endsWith(".plist"));
  assert.deepEqual(files.sort(), ROWS.filter((row) => row.scope === "agent").map((row) => `${row.label}.plist`).sort());
  for (const row of ROWS.filter((row) => row.scope === "agent")) assert.equal(row.template, `host/launchd/${row.label}.plist`);
  for (const file of files) {
    const text = await readFile(join(DIR, file), "utf8");
    for (const placeholder of text.match(/@[A-Z_]+@/g) ?? []) assert.ok(FILLED.has(placeholder), `${file}: ${placeholder}`);
    assert.doesNotMatch(text, /Tern/, `${file} names Tern's omp`);
  }
});

test("the backup and the watch run setup's copy as the owner, never the checkout", async () => {
  const args = async (label: string) => programArguments(await readFile(join(DIR, `${label}.plist`), "utf8"));
  assert.deepEqual(await args("com.underground.backup"), ["/bin/bash", "@DATA@/services/host/bin/ug-backup"]);
  assert.deepEqual(await args("com.underground.watch"), ["/bin/bash", "@DATA@/services/host/bin/ug-watch"]);
});

test("the gh-broker runs as its own user from root-owned code, on the pinned omp and the pinned gh, with nothing of the owner's", async () => {
  const text = await readFile(join(AGENT_DIR, "com.underground.gh-broker.plist"), "utf8");
  assert.deepEqual(programArguments(text), ["@OMP@", "@ROOT@/code/gh-broker/server.ts", "@GH@"]);
  assert.match(text, /<key>UserName<\/key>\s*<string>@GH_BROKER_USER@<\/string>/);
  assert.match(text, /<key>HOME<\/key>\s*<string>@GH_BROKER_HOME@<\/string>/);
  assert.match(text, /<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin<\/string>/);
  assert.doesNotMatch(text, /\/Users\/|@HOME@|@DATA@|@NODE@|\/opt\/homebrew/);
  for (const placeholder of text.match(/@[A-Z_]+@/g) ?? []) assert.ok(DAEMON_FILLED.has(placeholder), placeholder);
  const row = ROWS.find((r) => r.label === "com.underground.gh-broker");
  assert.deepEqual([row?.scope, row?.user], ["daemon", "gh_broker_user"]);
});

test("a job that is not the agent's and reads what the agent makes names a threat row that covers it", async () => {
  const threats = await readFile(join(import.meta.dirname, "../../docs/THREAT-MODEL.md"), "utf8");
  for (const row of ROWS) {
    const [kind, id] = row.agentInput.split(" ");
    assert.ok(["none", "socket", "port", "files"].includes(kind), `${row.label}: ${row.agentInput}`);
    if (row.user !== "agent_user" && kind !== "none") {
      assert.match(id ?? "", /^U\d+$/, `${row.label} runs as ${row.user} and reads ${kind} of the agent`);
      const line = threats.split("\n").find((l) => l.startsWith(`|${id}|`));
      assert.ok(line?.includes(row.label), `${row.label}: threat row ${id} must exist and name the job`);
    }
  }
});

function allowed(user: string, input: string, inputs = "", log = "") {
  return spawnSync("bash", ["-c", `source ${LIB}; ug_service_allowed com.underground.x "$1" "$2" "$3" "$4"`, "_", user, input, inputs, log], { encoding: "utf8" });
}

test("setup refuses a job of a user other than the agent that reads agent input without a threat row, and lets a job of its own user read it", () => {
  for (const [user, input, status] of [
    ["owner", "socket", 1],
    ["root", "port", 1],
    ["owner", "none", 0],
    ["owner", "files U40", 0],
    ["gh_broker_user", "socket", 1],
    ["gh_broker_user", "socket U38", 0],
    ["gh_broker_user", "everything U38", 1],
    ["auth_user", "", 1],
  ] as const) {
    assert.equal(allowed(user, input).status, status, `${user} ${input}`);
  }
  assert.match(allowed("owner", "socket").stdout, /runs as owner and reads socket that the agent makes/);
});

test("a job reads only the home of its own user, and no glob reaches a home", () => {
  assert.equal(allowed("gh_broker_user", "socket U38", "@GH_BROKER_HOME@/github-app.json").status, 0);
  assert.equal(allowed("gh_broker_user", "socket U38", "@AUTH_HOME@/.omp/auth-broker.token").status, 1);
  assert.equal(allowed("auth_user", "port U7", "", "@AGENT_HOME@/logs/auth.log").status, 1);
  assert.equal(allowed("gh_broker_user", "socket U38", "?@GH_BROKER_HOME@/x?y").status, 1);
  assert.equal(allowed("agent_user", "files", "@AGENT_HOME@/x").status, 0);
});

const FAKE_SUDO = `#!/bin/sh
[ "$1 $2 $4" = "-n -u -H" ] || { echo "fake sudo: unexpected $*" >&2; exit 64; }
login=$3
shift 4
printf '%s %s\\n' "$login" "$*" >>"$FAKE/calls"
if grep -qxF "$login" "$FAKE/nosudo" 2>/dev/null; then exit 1; fi
case $1 in
  /usr/bin/true) exit 0 ;;
  /bin/ls | /bin/cat) grep -qxF "$login $*" "$FAKE/open" 2>/dev/null && exec "$@"; exit 1 ;;
  *) exec "$@" ;;
esac
`;

async function fakeHost(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await tempDir(join(tmpdir(), "ug-walls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["bin", "owner", "u1", "u2", "u3", "root/config"]) await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, "root/config/models.yml"), "bearer\n");
  await writeFile(
    join(dir, "facts"),
    `root=${dir}/root\nagent_user=one\nagent_home=${dir}/u1\nauth_user=two\nauth_home=${dir}/u2\ngh_broker_user=three\ngh_broker_home=${dir}/u3\n`,
  );
  await writeFile(join(dir, "bin/sudo"), FAKE_SUDO);
  await chmod(join(dir, "bin/sudo"), 0o755);
  const run = (script: string, ...args: string[]) =>
    spawnSync("bash", ["-c", `source ${LIB}; ug_facts_file=$FAKE/facts; ${script}`, "_", ...args], {
      encoding: "utf8",
      env: { ...process.env, FAKE: dir, PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
    });
  const calls = async () => (await readFile(join(dir, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { dir, run, calls };
}

test("ug_as runs a command directly for the caller's own login and through sudo -n -u for another", async (t) => {
  const host = await fakeHost(t);
  const own = host.run('ug_as "$(id -un)" /bin/echo own');
  assert.equal(own.stdout, "own\n");
  assert.deepEqual(await host.calls(), []);
  const other = host.run("ug_as two /bin/echo other");
  assert.equal(other.stdout, "other\n");
  assert.deepEqual(await host.calls(), ["two /bin/echo other"]);
});

test("the restart hash is the hash of the plist and the inputs, and the inputs are read as the job's user", async (t) => {
  const host = await fakeHost(t);
  await writeFile(join(host.dir, "job.plist"), "plist\n");
  await writeFile(join(host.dir, "u2/token"), "token\n");
  await writeFile(join(host.dir, "u2/config"), "config\n");
  await writeFile(join(host.dir, "open"), `two /bin/cat -- ${host.dir}/u2/token\ntwo /bin/cat -- ${host.dir}/u2/config\n`);
  const r = host.run('ug_fingerprint two "$FAKE/job.plist" "$FAKE/u2/token" "$FAKE/u2/config"');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), createHash("sha256").update("plist\ntoken\nconfig\n").digest("hex"));
  assert.deepEqual(await host.calls(), [`two /bin/cat -- ${host.dir}/u2/token`, `two /bin/cat -- ${host.dir}/u2/config`]);
  await writeFile(join(host.dir, "nosudo"), "two\n");
  assert.notEqual(host.run('ug_fingerprint two "$FAKE/job.plist" "$FAKE/u2/token"').status, 0, "an input that cannot be read must not give a hash");
});

test("the walls between users hold only when each lower user is refused every other home and the bearer", async (t) => {
  const host = await fakeHost(t);
  const walls = () => host.run('ug_user_walls "$FAKE/owner"');

  const closed = walls();
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  assert.equal(closed.stdout, "");
  const asked = await host.calls();
  for (const login of ["one", "two", "three"]) assert.ok(asked.includes(`${login} /bin/ls ${host.dir}/owner`), `${login} was not tried on the owner's home`);
  assert.ok(asked.includes(`three /bin/ls ${host.dir}/u2`));
  assert.ok(!asked.includes(`two /bin/ls ${host.dir}/u2`), "a user's own home is not a wall");

  await writeFile(join(host.dir, "open"), `three /bin/ls ${host.dir}/u2\n`);
  const listed = walls();
  assert.equal(listed.status, 1);
  assert.equal(listed.stdout, `three can list ${host.dir}/u2, a home that is not its own\n`);

  await writeFile(join(host.dir, "open"), `two /bin/cat -- ${host.dir}/root/config/models.yml\n`);
  const bearer = walls();
  assert.equal(bearer.status, 1);
  assert.match(bearer.stdout, /^two can read the gateway bearer in /);

  await writeFile(join(host.dir, "open"), `one /bin/cat -- ${host.dir}/root/config/models.yml\n`);
  assert.equal(walls().status, 0, "the agent user holds the gateway bearer by design");
});

test("a lower user that sudo cannot run as leaves its walls open, not proven", async (t) => {
  const host = await fakeHost(t);
  await writeFile(join(host.dir, "nosudo"), "three\n");
  const r = host.run('ug_user_walls "$FAKE/owner"');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "three: sudo does not run as this user, so its walls are not proven\n");
});

test("the service table passes the least-rights rule as it stands", () => {
  const r = spawnSync("bash", ["-c", `source ${LIB}; ug_services_allowed`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a job follows only a daemon on a line above it, so root setup has restarted that daemon before it reaches the job", () => {
  ROWS.forEach((row, i) => {
    if (row.follows === "") return;
    assert.equal(row.scope, "daemon", `${row.label} follows ${row.follows}, but only a daemon can follow`);
    const before = ROWS.slice(0, i).filter((r) => r.scope === "daemon").map((r) => r.label);
    assert.ok(before.includes(row.follows), `${row.label} follows ${row.follows}, which is not a daemon above it`);
  });
});

test("setup checks each health kind only in the scope that can run it", () => {
  const probe = (scope: string, health: string) =>
    spawnSync("bash", ["-c", `source ${LIB}; ug_service_probe "$1" com.underground.x "$2" && printf '%s|' "\${ug_probe[@]}"`, "_", scope, health], { encoding: "utf8" });
  for (const [scope, health, status] of [
    ["agent", "launchd", 0],
    ["agent", "none", 0],
    ["agent", "socket /tmp/s", 1],
    ["agent", "pf 1", 1],
    ["daemon", "none", 1],
    ["daemon", "socket /tmp/s", 0],
    ["daemon", "nonsense", 1],
  ] as const) {
    assert.equal(probe(scope, health).status, status, `${scope} ${health}`);
  }
  assert.equal(probe("agent", "launchd").stdout, `launchctl|print|gui/${process.getuid?.()}/com.underground.x|`);
  assert.equal(probe("daemon", "launchd").stdout, "launchctl|print|system/com.underground.x|");
  assert.equal(probe("daemon", "port 127.0.0.1:@AGENT_SSHD_PORT@").stdout.split("|")[0], "ug_port_answers");
});

test("the login services run as the login user from root-owned code, with no profile or config dir that the owner's omp could share", async () => {
  const args = async (label: string) => programArguments(await readFile(join(AGENT_DIR, `${label}.plist`), "utf8"));
  assert.deepEqual((await args("com.underground.auth-broker")).slice(0, 3), ["@OMP@", "auth-broker", "serve"]);
  assert.deepEqual((await args("com.underground.auth-gateway")).slice(0, 3), ["@OMP@", "auth-gateway", "serve"]);
  assert.deepEqual(await args("com.underground.usage-broker"), ["@OMP@", "@ROOT@/code/gh-broker/usage-broker.ts"]);
  for (const label of DAEMONS) {
    const text = await readFile(join(AGENT_DIR, `${label}.plist`), "utf8");
    assert.match(text, /<key>UserName<\/key>\s*<string>@AUTH_USER@<\/string>/, label);
    assert.match(text, /<key>HOME<\/key>\s*<string>@AUTH_HOME@<\/string>/, label);
    assert.doesNotMatch(text, /OMP_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|\/Users\/|@HOME@|@DATA@|\/opt\/homebrew/, label);
    for (const placeholder of text.match(/@[A-Z_]+@/g) ?? []) assert.ok(DAEMON_FILLED.has(placeholder), `${label}: ${placeholder}`);
  }
});

test(
  "[mac] a service is trusted only when root or its own user owns each program, folder, and PATH entry it uses, only root owns its log folder, and no other user can write them",
  { skip: process.platform !== "darwin" && "needs BSD stat and plutil" },
  async (t) => {
    const dir = await tempDir(join(tmpdir(), "ug-trust-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const me = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
    const bin = join(dir, "bin");
    const open = join(dir, "open");
    const ruled = join(dir, "ruled");
    for (const [folder, mode] of [
      [bin, 0o755],
      [open, 0o775],
      [ruled, 0o755],
    ] as const) {
      await mkdir(folder);
      await writeFile(join(folder, "tool"), "");
      await chmod(join(folder, "tool"), 0o755);
      await chmod(folder, mode);
    }
    for (const [text, folder] of [
      ["everyone deny chown", bin],
      ["everyone allow add_file", ruled],
    ]) {
      assert.equal(spawnSync("chmod", ["+a", text, folder]).status, 0, text);
    }
    await symlink(join(bin, "tool"), join(dir, "link"));
    let n = 0;
    const check = async (o: { user?: string; program?: string; path?: string; log?: string }) => {
      const file = join(dir, `${n++}.plist`);
      const user = o.user === undefined ? "" : `<key>UserName</key><string>${o.user}</string>`;
      await writeFile(
        file,
        `<plist version="1.0"><dict>${user}<key>ProgramArguments</key><array><string>${o.program ?? join(bin, "tool")}</string><string>--flag</string></array>` +
          `<key>WorkingDirectory</key><string>${dir}</string><key>StandardOutPath</key><string>${o.log ?? "/usr/out.log"}</string>` +
          `<key>EnvironmentVariables</key><dict><key>PATH</key><string>${o.path ?? bin}</string></dict></dict></plist>\n`,
      );
      return spawnSync("bash", ["-c", `source ${LIB}; ug_trusted_daemon "$1"`, "_", file], { encoding: "utf8" });
    };

    const fine = await check({ user: me });
    assert.equal(fine.status, 0, fine.stdout + fine.stderr);

    const ownLog = await check({ user: me, log: join(dir, "out.log") });
    assert.equal(ownLog.status, 1, "the job's user could swap its log for a link that launchd opens");
    assert.match(ownLog.stdout, new RegExp(`it logs to ${dir}/out.log, but ${dir} belongs to ${me}`));

    await symlink("/etc/hosts", join(dir, "linked.log"));
    const linkedLog = await check({ user: me, log: join(dir, "linked.log") });
    assert.equal(linkedLog.status, 1, "launchd would write through a planted link");
    assert.match(linkedLog.stdout, /linked\.log, which is a link/);

    const writable = await check({ user: me, path: `/usr/bin:${open}` });
    assert.equal(writable.status, 1);
    assert.match(writable.stdout, new RegExp(`runs as ${me} and uses ${open}, but ${open} has mode 775`));

    const inWritable = await check({ user: me, program: join(open, "tool") });
    assert.equal(inWritable.status, 1, "a program in a folder that others can write can be swapped");
    assert.match(inWritable.stdout, /open has mode 775/);

    const link = await check({ user: me, program: join(dir, "link") });
    assert.equal(link.status, 1);
    assert.match(link.stdout, /link is a link/);

    const relative = await check({ user: me, path: "bin:/usr/bin" });
    assert.equal(relative.status, 1);
    assert.match(relative.stdout, /bin is not an absolute path/);

    const byRule = await check({ user: me, path: ruled });
    assert.equal(byRule.status, 1, "mode 755 with an access rule that lets every user add a file");
    assert.match(byRule.stdout, /ruled has an access rule that lets a user change it: .*allow add_file/);

    if (me !== "root") {
      const other = await check({});
      assert.equal(other.status, 1, "a service with no UserName runs as root, which trusts only root's files");
      assert.match(other.stdout, new RegExp(`runs as root and uses .* belongs to ${me}`));
    }
  },
);

test("the backup job runs once a day at 20:00, not at load, and logs in the data folder", async () => {
  const text = await readFile(join(DIR, "com.underground.backup.plist"), "utf8");
  assert.match(text, /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>20<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>\s*<\/dict>/);
  assert.doesNotMatch(text, /<key>(RunAtLoad|KeepAlive|StartInterval)<\/key>/, "it would wake the other machine at each setup or all day");
  assert.match(text, /<key>StandardErrorPath<\/key>\s*<string>@DATA@\/backup\/backup\.log<\/string>/);
});

test("the firewall check passes only when pf is on and the anchor holds the block line for that user and port", async (t) => {
  const dir = await tempDir(join(tmpdir(), "ug-pf-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pfctl"), `#!/bin/sh\ncase "$*" in\n  "-s info") cat ${dir}/info ;;\n  "-a com.apple/underground -sr") cat ${dir}/rules ;;\n  *) exit 64 ;;\nesac\n`);
  await chmod(join(bin, "pfctl"), 0o755);
  const line = (uid: number, port: number) => `block return in quick proto tcp from any to any port = ${port} user = ${uid}\n`;
  const check = async (status: string, rules: string) => {
    await writeFile(join(dir, "info"), `No ALTQ support in kernel\nStatus: ${status} for 2 days 18:54:40           Debug: Urgent\n`);
    await writeFile(join(dir, "rules"), rules);
    return spawnSync("bash", ["-c", `source ${LIB}; ug_pf_refuses_listener 502 8765`], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" }).status;
  };
  assert.equal(await check("Enabled", line(502, 8765)), 0);
  assert.equal(await check("Disabled", line(502, 8765)), 1, "a loaded rule does nothing while pf is off");
  assert.equal(await check("Enabled", line(501, 8765)), 1, "the line names another user");
  assert.equal(await check("Enabled", line(502, 18765)), 1, "the line names another port");
  assert.equal(await check("Enabled", ""), 1, "the anchor is empty");
});

async function fakeLaunchd(t: { after: (fn: () => unknown) => void }, pollsAfterBootout: number) {
  const dir = await tempDir(join(tmpdir(), "ug-launchd-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(dir, "loaded"), "");
  await writeFile(join(dir, "left"), "0\n");
  const script = [
    "#!/bin/sh",
    `s=${dir}`,
    'n=$(cat "$s/left")',
    'echo "$1" >>"$s/log"',
    "case $1 in",
    '  print) if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$s/left"; exit 0; fi; [ -e "$s/loaded" ] && exit 0; exit 113 ;;',
    `  bootout) rm -f "$s/loaded"; echo ${pollsAfterBootout} >"$s/left" ;;`,
    '  bootstrap) if [ "$n" -gt 0 ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi; : >"$s/loaded" ;;',
    "esac",
  ].join("\n");
  await writeFile(join(bin, "launchctl"), `${script}\n`);
  await writeFile(join(bin, "sleep"), "#!/bin/sh\n");
  await chmod(join(bin, "launchctl"), 0o755);
  await chmod(join(bin, "sleep"), 0o755);
  await writeFile(join(dir, "rendered.plist"), "<plist/>\n");
  const run = (call: string) =>
    spawnSync("bash", ["-c", `source ${LIB}; ${call}`], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
  const calls = async () => (await readFile(join(dir, "log"), "utf8").catch(() => "")).split("\n").filter((c) => c !== "" && c !== "print");
  return { dir, run, calls };
}

const RESTART = "ug_restart_service system com.underground.x ./x.plist";
const ensure = (answers: string) => `ug_ensure_service system com.underground.x rendered.plist x.plist stamp new ${answers}`;

test("a restart loads the new service only after launchd has let the old one go, since a bootstrap before that fails", async (t) => {
  const launchd = await fakeLaunchd(t, 3);
  const r = launchd.run(RESTART);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(await launchd.calls(), ["bootout", "bootstrap"]);
});

test("a restart whose old service never unloads fails and names it, and loads nothing", async (t) => {
  const launchd = await fakeLaunchd(t, 1000);
  const r = launchd.run(RESTART);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /com\.underground\.x is still loaded 30 s after launchctl bootout/);
  assert.deepEqual(await launchd.calls(), ["bootout"]);
});

test("a loaded service whose inputs did not change and that answers keeps running", async (t) => {
  const launchd = await fakeLaunchd(t, 0);
  await writeFile(join(launchd.dir, "stamp"), "new\n");
  const r = launchd.run(ensure("true"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /not restarted/);
  assert.deepEqual(await launchd.calls(), []);
});

test("a service whose inputs changed restarts, and its new fingerprint is saved once it answers", async (t) => {
  const launchd = await fakeLaunchd(t, 2);
  await writeFile(join(launchd.dir, "stamp"), "old\n");
  const r = launchd.run(ensure("true"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(await launchd.calls(), ["bootout", "bootstrap"]);
  assert.equal(await readFile(join(launchd.dir, "stamp"), "utf8"), "new\n");
  assert.equal(await readFile(join(launchd.dir, "x.plist"), "utf8"), "<plist/>\n");
});

test("a service that does not answer after its restart keeps no fingerprint, so the next setup restarts it again", async (t) => {
  const launchd = await fakeLaunchd(t, 0);
  await writeFile(join(launchd.dir, "stamp"), "new\n");
  const r = launchd.run(ensure("false"));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /com\.underground\.x does not answer 30 s after it loaded/);
  assert.deepEqual(await launchd.calls(), ["bootout", "bootstrap"]);
  await assert.rejects(readFile(join(launchd.dir, "stamp")));
});
