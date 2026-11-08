import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const DIR = join(import.meta.dirname, "../../host/launchd");
const LIB = join(import.meta.dirname, "../../host/lib/ug.bash");
const AGENT_DIR = join(import.meta.dirname, "../../host/agent");
const FILLED = new Set(["@HOME@", "@DATA@"]);
const DAEMON_FILLED = new Set(["@OMP@", "@GATEWAY@", "@ENGINE@"]);
const DAEMONS = ["com.underground.auth-broker", "com.underground.auth-gateway", "com.underground.usage-broker"];

const programArguments = (text: string): string[] => {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
};

test("every owner launchd template uses only the placeholders that setup fills, so none can name the checkout", async () => {
  const files = (await readdir(DIR)).filter((n) => n.endsWith(".plist"));
  assert.deepEqual(files.sort(), ["com.underground.backup.plist", "com.underground.gh-broker.plist"]);
  for (const file of files) {
    const text = await readFile(join(DIR, file), "utf8");
    for (const placeholder of text.match(/@[A-Z_]+@/g) ?? []) assert.ok(FILLED.has(placeholder), `${file}: ${placeholder}`);
    assert.doesNotMatch(text, /Tern/, `${file} names Tern's omp`);
  }
});

test("the gh-broker and the backup run setup's copy as the owner, never the checkout", async () => {
  const args = async (label: string) => programArguments(await readFile(join(DIR, `${label}.plist`), "utf8"));
  assert.deepEqual(await args("com.underground.gh-broker"), ["/opt/homebrew/bin/node", "@DATA@/services/host/gh-broker/server.ts"]);
  assert.deepEqual(await args("com.underground.backup"), ["/bin/bash", "@DATA@/services/host/bin/ug-backup"]);
});

test("the login services run as ugauth from root-owned code, with no profile or config dir that the owner's omp could share", async () => {
  const args = async (label: string) => programArguments(await readFile(join(AGENT_DIR, `${label}.plist`), "utf8"));
  assert.deepEqual((await args("com.underground.auth-broker")).slice(0, 3), ["@OMP@", "auth-broker", "serve"]);
  assert.deepEqual((await args("com.underground.auth-gateway")).slice(0, 3), ["@OMP@", "auth-gateway", "serve"]);
  assert.deepEqual(await args("com.underground.usage-broker"), ["/opt/homebrew/bin/node", "/Library/Underground/usage-broker/usage-broker.ts"]);
  for (const label of DAEMONS) {
    const text = await readFile(join(AGENT_DIR, `${label}.plist`), "utf8");
    assert.match(text, /<key>UserName<\/key>\s*<string>ugauth<\/string>/, label);
    assert.match(text, /<key>HOME<\/key>\s*<string>\/Users\/ugauth<\/string>/, label);
    assert.doesNotMatch(text, /OMP_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|\/Users\/kutluk|@HOME@|@DATA@/, label);
    for (const placeholder of text.match(/@[A-Z_]+@/g) ?? []) assert.ok(DAEMON_FILLED.has(placeholder), `${label}: ${placeholder}`);
  }
});

test("the backup job runs once a day at 20:00, not at load, and logs in the data folder", async () => {
  const text = await readFile(join(DIR, "com.underground.backup.plist"), "utf8");
  assert.match(text, /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>20<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>\s*<\/dict>/);
  assert.doesNotMatch(text, /<key>(RunAtLoad|KeepAlive|StartInterval)<\/key>/, "it would wake the other machine at each setup or all day");
  assert.match(text, /<key>StandardErrorPath<\/key>\s*<string>@DATA@\/backup\/backup\.log<\/string>/);
});

async function fakeLaunchd(t: { after: (fn: () => unknown) => void }, pollsLoaded: number) {
  const dir = await tempDir(join(tmpdir(), "ug-launchd-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(dir, "left"), `${pollsLoaded}\n`);
  const script = [
    "#!/bin/sh",
    `s=${dir}`,
    'n=$(cat "$s/left")',
    'echo "$1" >>"$s/log"',
    "case $1 in",
    '  print) if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$s/left"; exit 0; fi; exit 113 ;;',
    '  bootstrap) if [ "$n" -gt 0 ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi ;;',
    "esac",
  ].join("\n");
  await writeFile(join(bin, "launchctl"), `${script}\n`);
  await writeFile(join(bin, "sleep"), "#!/bin/sh\n");
  await chmod(join(bin, "launchctl"), 0o755);
  await chmod(join(bin, "sleep"), 0o755);
  const run = () =>
    spawnSync("bash", ["-c", `source ${LIB}; ug_restart_service system com.underground.x /Library/LaunchDaemons/com.underground.x.plist`], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
  const calls = async () => (await readFile(join(dir, "log"), "utf8")).trim().split("\n").filter((c) => c !== "print");
  return { run, calls };
}

test("a restart loads the new service only after launchd has let the old one go, since a bootstrap before that fails", async (t) => {
  const launchd = await fakeLaunchd(t, 3);
  const r = launchd.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(await launchd.calls(), ["bootout", "bootstrap"]);
});

test("a restart whose old service never unloads fails and names it, and loads nothing", async (t) => {
  const launchd = await fakeLaunchd(t, 1000);
  const r = launchd.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /com\.underground\.x is still loaded 30 s after launchctl bootout/);
  assert.deepEqual(await launchd.calls(), ["bootout"]);
});
