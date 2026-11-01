import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

// install.sh is never run against the real HOME. Each test sources a copy of it in a temp folder, with HOME,
// TMPDIR, and PATH inside that folder, stub programs that log their calls, and node_bin, npm_bin, gh_bin, and
// tailscale_app pointed at stubs. Every path install.sh writes starts with $HOME (install.sh:6-9, :19-74, :85-87,
// :258-274), $TMPDIR (:198), or $src (read only); assertConfined checks the expanded paths before any run.

const SRC = join(import.meta.dirname, "../..");
const skip = process.platform !== "darwin" ? "needs macOS (sw_vers, the launchd layout)" : false;
const UID = process.getuid?.() ?? 0;
const LABELS = ["com.underground.broker", "com.underground.auth-broker", "com.underground.auth-gateway", "com.underground.usage-broker"];
const ADDRESSES = "gateway=100.64.0.1:4000\nengine=100.64.0.2:8081\n";
const PASSING_TAP = "# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n";
const OMP_TEMPLATE = "pin=@OMP_PIN@ srt=@SRT_PIN@ home=@HOME@ gateway=@GATEWAY@\n";
const TOOLS = ["bash", "sh", "sed", "grep", "mktemp", "chmod", "mv", "mkdir", "dirname", "cat", "shasum", "perl", "rm", "ln", "sw_vers", "env", "basename", "tr", "head", "touch"];

const STUB_NODE = `#!/bin/bash
printf 'node %s\\n' "$*" >>"$UG_LOG"
if [[ $1 == --test ]]; then
  dest=""
  for a in "$@"; do
    case $a in
      --test-reporter-destination=stdout) ;;
      --test-reporter-destination=*) dest=\${a#*=} ;;
    esac
  done
  printf '%s' "$FAKE_TAP" >"$dest"
  exit "\${FAKE_TEST_EXIT:-0}"
fi
exec ${JSON.stringify(process.execPath)} "$@"
`;
const STUB_NPM = `#!/bin/bash
printf 'npm %s|cwd=%s\\n' "$*" "$PWD" >>"$UG_LOG"
[[ \${FAKE_NPM_EXIT:-0} -eq 0 ]] || exit "$FAKE_NPM_EXIT"
prefix="" prev=""
for a in "$@"; do
  [[ $prev == --prefix ]] && prefix=$a
  prev=$a
done
pkg=\${!#}
mkdir -p "$prefix/node_modules/\${pkg%@*}/dist"
printf 'console.log("%s");\\n' "\${pkg##*@}" >"$prefix/node_modules/\${pkg%@*}/dist/cli.js"
`;
const STUB_GIT = `#!/bin/bash
printf 'git %s|cwd=%s\\n' "$*" "$PWD" >>"$UG_LOG"
[[ \${FAKE_GIT_EXIT:-0} -eq 0 ]] || exit "$FAKE_GIT_EXIT"
dest=\${!#}
mkdir -p "$dest"
printf '#!/bin/bash\\nprintf "install.sh %%s|cwd=%%s\\\\n" "$#" "$PWD" >>"$UG_LOG"\\nexit "\${FAKE_INSTALL_EXIT:-0}"\\n' >"$dest/install.sh"
`;
const STUB_LAUNCHCTL = `#!/bin/bash
printf 'launchctl %s\\n' "$*" >>"$UG_LOG"
count() {
  local n
  n=$(cat "$UG_STATE/$1" 2>/dev/null || printf 0)
  n=$((n + 1))
  printf '%s' "$n" >"$UG_STATE/$1"
  printf '%s' "$n"
}
case $1 in
  bootout) exit 0 ;;
  print)
    n=$(count "print-\${2##*/}")
    [[ $n -le \${LC_LOADED:-0} ]] && exit 0
    exit 113
    ;;
  bootstrap)
    label=\${3##*/}
    n=$(count "bootstrap-\${label%.plist}")
    if [[ \${LC_BOOTSTRAP_FAIL:-0} == all || $n -le \${LC_BOOTSTRAP_FAIL:-0} ]]; then
      printf 'Bootstrap failed: 5: Input/output error\\n' >&2
      exit 5
    fi
    exit 0
    ;;
esac
`;
const STUB_OMP = `#!/bin/bash
printf 'omp %s\\n' "$*" >>"$UG_LOG"
exit "\${FAKE_OMP_EXIT:-0}"
`;

type Fixture = { root: string; home: string; src: string; stub: string; log: string; tmp: string; ompBin: string; srtDir: string };
type Run = { status: number | null; stdout: string; stderr: string };

async function put(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode });
}

async function makeFixture(versions = "srt=9.9.9\nomp=1.2.3\n"): Promise<Fixture> {
  const root = await tempDir(join(tmpdir(), "ugi-"));
  const home = join(root, "home");
  const src = join(root, "src");
  const stub = join(root, "stub");
  const tools = join(root, "tools");
  const tmp = join(root, "tmp");
  for (const dir of [home, stub, tools, tmp, join(root, "state")]) await mkdir(dir, { recursive: true });
  await cp(join(SRC, "host"), join(src, "host"), { recursive: true });
  await cp(join(SRC, "install.sh"), join(src, "install.sh"));
  await cp(join(SRC, "INSTALL_SOURCE"), join(src, "INSTALL_SOURCE"));
  await put(join(home, ".agents/bin/ug-install"), await readFile(join(src, "host/bin/ug-install"), "utf8"), 0o755);
  await put(join(src, "VERSIONS"), versions);
  await put(join(src, "host/bin/omp"), OMP_TEMPLATE, 0o755);
  await put(join(src, "tests/broker/a.test.ts"), "");
  await put(join(src, "tests/host/a.test.ts"), "");
  for (const tool of TOOLS) {
    const path = [`/bin/${tool}`, `/usr/bin/${tool}`].find((p) => existsSync(p));
    if (path !== undefined) await symlink(path, join(tools, tool));
  }
  await put(join(stub, "node"), STUB_NODE, 0o755);
  await put(join(stub, "npm"), STUB_NPM, 0o755);
  await put(join(stub, "gh"), "#!/bin/sh\nexit 0\n", 0o755);
  await put(join(stub, "git"), STUB_GIT, 0o755);
  await put(join(stub, "launchctl"), STUB_LAUNCHCTL, 0o755);
  await put(join(stub, "sleep"), "#!/bin/sh\nprintf 'sleep %s\\n' \"$*\" >>\"$UG_LOG\"\n", 0o755);
  const ompBin = join(home, "Library/Application Support/Tern/omp/versions/1.2.3");
  await put(ompBin, STUB_OMP, 0o755);
  await put(join(home, ".config/underground-broker/addresses"), ADDRESSES, 0o600);
  return { root, home, src, stub, log: join(root, "calls.log"), tmp, ompBin, srtDir: join(home, ".agents/srt/9.9.9") };
}

function env(fx: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: fx.home, PATH: `${fx.stub}:${join(fx.root, "tools")}`, TMPDIR: fx.tmp, UG_LOG: fx.log, UG_STATE: join(fx.root, "state"), FAKE_TAP: PASSING_TAP, ...extra };
}

function source(fx: Fixture, script: string, extra: Record<string, string> = {}): Run {
  assert.notEqual(fx.home, homedir());
  const run = spawnSync("/bin/bash", ["-c", `source "$1/install.sh"; node_bin="$2/node"; npm_bin="$2/npm"; gh_bin="$2/gh"; tailscale_app=/nonexistent; ${script}`, "_", fx.src, fx.stub], {
    cwd: fx.root,
    env: env(fx, extra),
    encoding: "utf8",
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// Prints every path that install.sh writes or runs, as the sourced script expands it, and checks that each is in the temp folder.
function assertConfined(fx: Fixture): void {
  const run = source(
    fx,
    `printf '%s\\n' "$agents_dir" "$addresses_file" "$install_record" "$omp_bin" "$srt_dir" "$srt_cli" "$node_bin" "$npm_bin" "$gh_bin" "$HOME/.zshrc" "$HOME/.config/underground-broker/roles" "$HOME/.agents/bin/pinned/omp" "\${TMPDIR}"
while IFS='|' read -r rel dest _ _; do if [[ -n $rel ]]; then printf '%s\\n' "$dest"; fi; done <<<"$targets"
while IFS='|' read -r dir _; do if [[ -n $dir ]]; then printf '%s\\n' "$dir"; fi; done <<<"$dirs"`,
  );
  assert.equal(run.status, 0, run.stderr);
  const paths = run.stdout.split("\n").filter((l) => l !== "");
  assert.ok(paths.length > 60, run.stdout);
  for (const path of paths) assert.ok(path.startsWith(`${fx.root}/`), `install.sh would touch ${path} outside ${fx.root}`);
}

async function calls(fx: Fixture, prefix = ""): Promise<string[]> {
  if (!existsSync(fx.log)) return [];
  return (await readFile(fx.log, "utf8")).split("\n").filter((l) => l !== "" && l.startsWith(prefix));
}

async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

async function runInstall(fx: Fixture, extra: Record<string, string> = {}): Promise<Run> {
  assertConfined(fx);
  return source(fx, "run_install", extra);
}

test("install.sh with an argument prints its usage, exits 64, and changes nothing", { skip }, async () => {
  const fx = await makeFixture();
  assertConfined(fx);
  const before = await tree(fx.home);
  const run = spawnSync("/bin/bash", [join(fx.src, "install.sh"), "now"], { cwd: fx.root, env: env(fx), encoding: "utf8" });
  assert.equal(run.status, 64, run.stderr);
  assert.match(run.stderr, /usage: install\.sh/);
  assert.deepEqual(await tree(fx.home), before);
  assert.deepEqual(await calls(fx), []);
});

test("install.sh refuses a pin in VERSIONS that is empty or holds other characters, before it does anything", { skip }, async () => {
  const fx = await makeFixture();
  const before = await tree(fx.home);
  for (const [versions, name] of [
    ["srt=9.9.9;touch x\nomp=1.2.3\n", "srt"],
    ["srt=\nomp=1.2.3\n", "srt"],
    ["omp=1.2.3\n", "srt"],
    ["srt=9.9.9\nomp=../1.2.3\n", "omp"],
    ["srt=9.9.9\nomp=1.2.3 x\n", "omp"],
  ]) {
    await writeFile(join(fx.src, "VERSIONS"), versions);
    const run = source(fx, "printf sourced");
    assert.equal(run.status, 1, versions);
    assert.match(run.stderr, new RegExp(`install: bad pin for ${name} in VERSIONS`), versions);
    assert.equal(run.stdout, "", versions);
  }
  assert.deepEqual(await tree(fx.home), before);
  assert.deepEqual(await calls(fx), []);
  await writeFile(join(fx.src, "VERSIONS"), "srt=9.9.9\nomp=1.2.3-rc.1+b\n");
  assert.equal(source(fx, "printf sourced").stdout, "sourced");
});

test("install_srt installs the pinned srt with npm only when that version is not there, and refuses without node, npm, or a working npm", { skip }, async () => {
  const fx = await makeFixture();
  assertConfined(fx);
  const npmLine = `npm install --prefix ${fx.srtDir} --ignore-scripts --no-audit --no-fund @anthropic-ai/sandbox-runtime@9.9.9|cwd=/`;
  const missing = source(fx, 'node_bin=/nonexistent/node; install_srt; printf done');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /install: missing \/nonexistent\/node/);
  assert.equal(missing.stdout, "");
  const noNpm = source(fx, 'npm_bin=/nonexistent/npm; install_srt; printf done');
  assert.equal(noNpm.status, 1);
  assert.match(noNpm.stderr, /install: missing \/nonexistent\/npm/);
  assert.equal(noNpm.stdout, "");
  const failed = source(fx, "install_srt; printf done", { FAKE_NPM_EXIT: "1" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, new RegExp(`install: npm install of @anthropic-ai/sandbox-runtime@9\\.9\\.9 into ${fx.srtDir} failed`));
  assert.equal(failed.stdout, "");
  assert.deepEqual(await calls(fx, "npm"), [npmLine]);

  await rm(join(fx.root, "calls.log"));
  const installed = source(fx, "install_srt; srt_version");
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout, "9.9.9\n");
  assert.deepEqual(await calls(fx, "npm"), [npmLine]);
  const again = source(fx, "install_srt; printf done");
  assert.equal(again.stdout, "done");
  assert.deepEqual(await calls(fx, "npm"), [npmLine], "srt already pinned: npm runs again");
  await writeFile(join(fx.srtDir, "node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js"), 'console.log("9.9.8");\n');
  assert.equal(source(fx, "install_srt; srt_version").stdout, "9.9.9\n");
  assert.deepEqual(await calls(fx, "npm"), [npmLine, npmLine], "another srt version: npm did not run");
});

test("check_deps passes with every dependency, and names each missing one: node, gh, git, srt or its version, the pinned omp", { skip }, async () => {
  const fx = await makeFixture();
  assertConfined(fx);
  assert.equal(source(fx, "install_srt").status, 0);
  const check = (before: string): Run => source(fx, `${before}\nif check_deps; then printf 'passed\\n'; else printf 'refused\\n'; fi`);
  assert.equal(check("").stdout, "passed\n");
  const refused = (run: Run, line: string, what: string): void => {
    assert.ok(run.stdout.split("\n").includes(line), `${what}: ${run.stdout}`);
    assert.match(run.stdout, /refused\n$/, what);
  };
  refused(check("node_bin=/nonexistent/node"), "missing: /nonexistent/node", "node");
  refused(check("gh_bin=/nonexistent/gh"), "missing: /nonexistent/gh", "gh");
  await rename(join(fx.stub, "git"), join(fx.root, "git"));
  refused(check(""), "missing: git", "git");
  await rename(join(fx.root, "git"), join(fx.stub, "git"));
  const cli = join(fx.srtDir, "node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js");
  await writeFile(cli, 'console.log("9.9.8");\n');
  refused(check(""), "srt version: have 9.9.8, want 9.9.9", "srt version");
  await rm(fx.srtDir, { recursive: true });
  refused(check(""), `missing: ${cli}`, "srt");
  assert.equal(source(fx, "install_srt").status, 0);
  await rename(fx.ompBin, `${fx.ompBin}.gone`);
  refused(check(""), `missing: ${fx.ompBin}`, "omp");
  await rename(`${fx.ompBin}.gone`, fx.ompBin);
  assert.equal(check("").stdout, "passed\n");
});

test("the test gate passes only a suite that exits 0 with no failed, skipped, or todo test", { skip }, async () => {
  const fx = await makeFixture();
  assertConfined(fx);
  const gate = (extra: Record<string, string>): Run => source(fx, "if run_tests; then printf 'passed\\n'; else printf 'refused\\n'; fi", extra);
  const passed = gate({});
  assert.equal(passed.stdout, "passed\n", passed.stderr);
  const suite = (await calls(fx, "node --test"))[0] ?? "";
  assert.ok(suite.includes(`${fx.src}/tests/broker/a.test.ts ${fx.src}/tests/host/a.test.ts`), suite);
  for (const [what, extra, summary] of [
    ["exit 1", { FAKE_TEST_EXIT: "1" }, "# fail 0"],
    ["# fail 1", { FAKE_TAP: PASSING_TAP.replace("# fail 0", "# fail 1") }, "# fail 1"],
    ["# skipped 1", { FAKE_TAP: PASSING_TAP.replace("# skipped 0", "# skipped 1") }, "# skipped 1"],
    ["# todo 1", { FAKE_TAP: PASSING_TAP.replace("# todo 0", "# todo 1") }, "# todo 1"],
    ["no summary", { FAKE_TAP: "TAP version 13\n" }, ""],
  ] as const) {
    const run = gate(extra);
    assert.equal(run.stdout, "refused\n", what);
    assert.match(run.stderr, /install: the test suite did not pass in full, so nothing is installed/, what);
    if (summary !== "") assert.ok(run.stderr.split("\n").includes(summary), `${what}: ${run.stderr}`);
  }
  assert.deepEqual(await readdir(fx.tmp), [], "a TAP file is left in TMPDIR");
});

test("run_install installs srt, passes the gate, installs every file, links the pinned omp, sets up the gateway, restarts the services, and writes the install record", { skip }, async () => {
  const fx = await makeFixture();
  await writeFile(join(fx.src, "INSTALL_SOURCE"), "git@github.com:example-owner/alternate-repo.git\n");
  await put(join(fx.home, ".zshrc"), "export KEEP=1\n");
  const run = await runInstall(fx);
  assert.equal(run.status, 0, run.stderr);
  const h = fx.home;
  assert.equal(await readFile(join(fx.srtDir, "node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js"), "utf8"), 'console.log("9.9.9");\n');
  assert.equal((await calls(fx, "node --test")).length, 1);
  assert.equal(await readFile(join(h, ".config/underground-broker/roles"), "utf8"), await readFile(join(SRC, "host/roles/roles"), "utf8"));
  assert.equal(await mode(join(h, ".config/underground-broker/roles")), 0o600);
  assert.equal(await readFile(join(h, ".agents/bin/omp"), "utf8"), `pin=1.2.3 srt=9.9.9 home=${h} gateway=100.64.0.1:4000\n`);
  assert.equal(await mode(join(h, ".agents/bin/omp")), 0o755);
  assert.equal(await readFile(join(h, ".agents/bin/ug-install"), "utf8"), await readFile(join(SRC, "host/bin/ug-install"), "utf8"));
  assert.equal(await mode(join(h, ".agents/bin/ug-install")), 0o755);
  assert.equal(await readFile(join(h, ".agents/install-source"), "utf8"), "git@github.com:example-owner/alternate-repo.git\n");
  assert.equal(await mode(join(h, ".agents/install-source")), 0o644);
  assert.equal(await readFile(join(h, ".agents/broker/server.ts"), "utf8"), await readFile(join(SRC, "host/broker/server.ts"), "utf8"));
  assert.equal(await mode(join(h, ".agents/broker/server.ts")), 0o644);
  assert.equal(await readlink(join(h, ".agents/bin/pinned/omp")), fx.ompBin);
  assert.equal(await readFile(join(h, ".zshrc"), "utf8"), 'export KEEP=1\n\nalias omp="$HOME/.agents/bin/omp"\n');
  assert.equal(await readFile(join(h, ".ug/omp/agent/policy.yml"), "utf8"), await readFile(join(SRC, "host/roles/policy.yml"), "utf8"));
  for (const role of ["author", "code-review", "security-review", "risk-review"]) {
    assert.match(run.stdout, new RegExp(`^gateway-setup: (?:.*, )?${role}(?:, .*)?: `, "m"), role);
  }
  const bootstraps = await calls(fx, "launchctl bootstrap");
  assert.deepEqual(bootstraps, LABELS.map((l) => `launchctl bootstrap gui/${UID} ${h}/Library/LaunchAgents/${l}.plist`));
  assert.deepEqual(await calls(fx, "omp"), ["omp --help"]);
  const record = await readFile(join(h, ".agents/install-manifest"), "utf8");
  for (const file of [".agents/bin/omp", ".agents/broker/server.ts", "Library/LaunchAgents/com.underground.broker.plist"]) {
    const hash = createHash("sha256").update(await readFile(join(h, file))).digest("hex");
    assert.match(record, new RegExp(`^file\\t\\d+\\t${hash}\\t${join(h, file).replaceAll(".", "\\.")}$`, "m"), file);
  }

  await writeFile(join(h, ".config/underground-broker/roles"), "author author\n");
  const again = await runInstall(fx);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /install: added to/);
  assert.equal(await readFile(join(h, ".zshrc"), "utf8"), 'export KEEP=1\n\nalias omp="$HOME/.agents/bin/omp"\n');
  assert.equal(await readFile(join(h, ".config/underground-broker/roles"), "utf8"), "author author\n");
});

test("run_install keeps an existing roles file, and gateway-setup sets up the roles it names", { skip }, async () => {
  const fx = await makeFixture();
  const roles = "author author\nsec2 security-review\n";
  await put(join(fx.home, ".config/underground-broker/roles"), roles, 0o600);
  const run = await runInstall(fx);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await readFile(join(fx.home, ".config/underground-broker/roles"), "utf8"), roles);
  assert.ok(existsSync(join(fx.home, ".ug/omp/agent/policy.yml")));
  assert.match(run.stdout, /^gateway-setup: author, sec2: /m);
  assert.doesNotMatch(run.stdout, /^gateway-setup: .*code-review/m);
});

async function assertNothingInstalled(fx: Fixture, what: string): Promise<void> {
  for (const path of [".agents/bin/omp", ".config/underground-broker/roles", ".zshrc", ".agents/install-manifest", ".ug/omp"]) {
    assert.equal(existsSync(join(fx.home, path)), false, `${what}: ${path} exists`);
  }
  assert.deepEqual(await calls(fx, "launchctl"), [], what);
  assert.deepEqual(await calls(fx, "omp"), [], what);
}

test("run_install installs nothing when a dependency is missing or the test gate refuses", { skip }, async () => {
  const fx = await makeFixture();
  const gate = await runInstall(fx, { FAKE_TEST_EXIT: "1" });
  assert.equal(gate.status, 1);
  assert.match(gate.stderr, /the test suite did not pass in full, so nothing is installed/);
  await assertNothingInstalled(fx, "gate");
  await rm(fx.log);
  await rename(fx.ompBin, `${fx.ompBin}.gone`);
  const deps = await runInstall(fx);
  assert.equal(deps.status, 1);
  assert.match(deps.stderr, /install: fix the dependencies above first/);
  assert.deepEqual(await calls(fx, "node --test"), [], "the suite ran without its dependencies");
  await assertNothingInstalled(fx, "deps");
});

test("run_install stops at a missing source file, before the gateway setup, the services, and the install record", { skip }, async () => {
  const fx = await makeFixture();
  await rm(join(fx.src, "host/broker/usage-broker.ts"));
  const run = await runInstall(fx);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /install: source file missing: host\/broker\/usage-broker\.ts/);
  assert.equal(existsSync(join(fx.home, ".agents/install-manifest")), false);
  assert.deepEqual(await calls(fx, "launchctl"), []);
  assert.deepEqual(await calls(fx, "omp"), []);
  assert.equal((await calls(fx, "node")).some((l) => l.endsWith("admin.ts gateway-setup")), false);
});

test("restart_service waits for launchd to drop a service, retries its bootstrap, and stops the install when bootstrap keeps failing", { skip }, async () => {
  const fx = await makeFixture();
  const run = await runInstall(fx, { LC_LOADED: "2", LC_BOOTSTRAP_FAIL: "2" });
  assert.equal(run.status, 0, run.stderr);
  for (const label of LABELS) {
    const lines = (await calls(fx, "launchctl")).filter((l) => l.includes(`/${label}`));
    const target = `gui/${UID}/${label}`;
    const bootstrap = `launchctl bootstrap gui/${UID} ${fx.home}/Library/LaunchAgents/${label}.plist`;
    assert.deepEqual(lines, [`launchctl bootout ${target}`, ...Array(3).fill(`launchctl print ${target}`), ...Array(3).fill(bootstrap)], label);
  }
  assert.ok(existsSync(join(fx.home, ".agents/install-manifest")));

  const failing = await makeFixture();
  const failed = await runInstall(failing, { LC_BOOTSTRAP_FAIL: "all" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Bootstrap failed: 5: Input\/output error\ninstall: launchctl bootstrap of com\.underground\.broker failed/);
  assert.equal((await calls(failing, "launchctl bootstrap")).length, 5);
  assert.deepEqual(await calls(failing, "omp"), []);
  assert.equal(existsSync(join(failing.home, ".agents/install-manifest")), false);
});

test("run_install stops when the pinned omp --help fails, and keeps the old install record", { skip }, async () => {
  const fx = await makeFixture();
  await put(join(fx.home, ".agents/install-manifest"), "old\n");
  const run = await runInstall(fx, { FAKE_OMP_EXIT: "1" });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes(`install: ${fx.ompBin} --help failed, so the omp native addon is not unpacked in ${fx.home}/.omp/natives/1.2.3`), run.stderr);
  assert.equal(await readFile(join(fx.home, ".agents/install-manifest"), "utf8"), "old\n");
});

test("install_file replaces the target with a copy or a rendered file with its mode, also for a HOME with & in it", { skip }, async () => {
  const fx = await makeFixture();
  const home = join(fx.root, "h&me");
  await put(join(home, "x"), "old", 0o600);
  await put(join(home, "y"), "old", 0o600);
  const run = spawnSync("/bin/bash", ["-c", `source "$1/install.sh"; gateway=G; install_file host/bin/omp "$HOME/x" 755 render; install_file host/broker/server.ts "$HOME/y" 644 copy`, "_", fx.src], {
    env: { ...env(fx), HOME: home },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await readFile(join(home, "x"), "utf8"), `pin=1.2.3 srt=9.9.9 home=${home} gateway=G\n`);
  assert.equal(await mode(join(home, "x")), 0o755);
  assert.equal(await readFile(join(home, "y"), "utf8"), await readFile(join(SRC, "host/broker/server.ts"), "utf8"));
  assert.equal(await mode(join(home, "y")), 0o644);
  assert.deepEqual((await readdir(home)).sort(), ["x", "y"]);
});

function ugInstall(fx: Fixture, args: string[], extra: Record<string, string> = {}): Run {
  assert.notEqual(fx.home, homedir());
  const run = spawnSync("/bin/bash", [join(fx.home, ".agents/bin/ug-install"), ...args], { cwd: fx.root, env: env(fx, extra), encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("ug-install with an argument prints its usage, exits 64, and clones nothing", { skip }, async () => {
  const fx = await makeFixture();
  const run = ugInstall(fx, ["main"]);
  assert.equal(run.status, 64);
  assert.match(run.stderr, /usage: ug-install/);
  assert.equal(existsSync(join(fx.home, ".agents/install-work")), false);
  assert.deepEqual(await calls(fx), []);
});

test("ug-install refuses a missing or empty installed source before cloning or creating a work folder", { skip }, async () => {
  const fx = await makeFixture();
  for (const contents of [null, "", " \t\n"]) {
    if (contents !== null) await put(join(fx.home, ".agents/install-source"), contents);
    const run = ugInstall(fx, []);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /ug-install: missing or empty installer source:/);
    assert.ok(run.stderr.includes(join(fx.home, ".agents/install-source")), run.stderr);
    assert.equal(existsSync(join(fx.home, ".agents/install-work")), false);
    assert.deepEqual(await calls(fx), []);
  }
});

test("standalone ug-install clones the installed alternate source outside any checkout, runs its installer without hooks, and removes the private clone", { skip }, async () => {
  const fx = await makeFixture();
  await put(join(fx.home, ".agents/install-source"), "git@github.com:example-owner/alternate-repo.git\n");
  await put(join(fx.root, "INSTALL_SOURCE"), "https://github.com/wrong-owner/wrong-repo.git\n");
  await rm(fx.src, { recursive: true });
  const run = ugInstall(fx, []);
  assert.equal(run.status, 0, run.stderr);
  const [git, install, ...rest] = await calls(fx);
  assert.deepEqual(rest, []);
  const work = /^git -c core\.hooksPath=\/dev\/null clone --quiet --depth 1 --branch main git@github\.com:example-owner\/alternate-repo\.git (.*)\/src\|cwd=\/$/.exec(git ?? "");
  assert.ok(work !== null, git);
  assert.match(work[1] ?? "", new RegExp(`^${join(fx.home, ".agents/install-work")}/ug-install\\.[A-Za-z0-9]+$`));
  assert.equal(install, `install.sh 0|cwd=${work[1]}/src`);
  assert.equal(await mode(join(fx.home, ".agents/install-work")), 0o700);
  assert.deepEqual(await readdir(join(fx.home, ".agents/install-work")), []);
});

test("ug-install stops when the clone fails, passes on the exit of a failed install, and removes the work folder", { skip }, async () => {
  const fx = await makeFixture();
  await put(join(fx.home, ".agents/install-source"), "https://github.com/example-owner/alternate-repo.git\n");
  const clone = ugInstall(fx, [], { FAKE_GIT_EXIT: "128" });
  assert.equal(clone.status, 128);
  assert.deepEqual(await calls(fx, "install.sh"), []);
  assert.deepEqual(await readdir(join(fx.home, ".agents/install-work")), []);
  const install = ugInstall(fx, [], { FAKE_INSTALL_EXIT: "3" });
  assert.equal(install.status, 3);
  assert.equal((await calls(fx, "install.sh")).length, 1);
  assert.deepEqual(await readdir(join(fx.home, ".agents/install-work")), []);
});
