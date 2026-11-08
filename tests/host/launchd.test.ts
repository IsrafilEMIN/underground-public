import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const DIR = join(import.meta.dirname, "../../host/launchd");
const FILLED = new Set(["@HOME@", "@OMP@", "@DATA@", "@GATEWAY@", "@ENGINE@"]);

const programArguments = (text: string): string[] => {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
};

test("every launchd template uses only the placeholders that setup fills, so none can name the checkout", async () => {
  const files = (await readdir(DIR)).filter((n) => n.endsWith(".plist"));
  assert.equal(files.length, 5, files.join(" "));
  for (const file of files) {
    const text = await readFile(join(DIR, file), "utf8");
    for (const placeholder of text.match(/@[A-Z_]+@/g) ?? []) assert.ok(FILLED.has(placeholder), `${file}: ${placeholder}`);
    assert.doesNotMatch(text, /Tern/, `${file} names Tern's omp`);
    assert.doesNotMatch(text, /\.agents\/broker\/[a-z-]+\.ts/, `${file} runs code from ~/.agents`);
  }
});

test("the auth services run the pinned omp, and the brokers and the backup run setup's copy, never the checkout", async () => {
  const args = async (label: string) => programArguments(await readFile(join(DIR, `${label}.plist`), "utf8"));
  assert.deepEqual((await args("com.underground.auth-broker")).slice(0, 3), ["@OMP@", "auth-broker", "serve"]);
  assert.deepEqual((await args("com.underground.auth-gateway")).slice(0, 3), ["@OMP@", "auth-gateway", "serve"]);
  assert.deepEqual(await args("com.underground.gh-broker"), ["/opt/homebrew/bin/node", "@DATA@/services/host/gh-broker/server.ts"]);
  assert.deepEqual(await args("com.underground.usage-broker"), ["/opt/homebrew/bin/node", "@DATA@/services/host/gh-broker/usage-broker.ts"]);
  assert.deepEqual(await args("com.underground.backup"), ["/bin/bash", "@DATA@/services/host/bin/ug-backup"]);
});

test("the auth services keep their logins in omp's profile ug-auth, never in the default profile that a plain omp reads", async () => {
  for (const label of ["com.underground.auth-broker", "com.underground.auth-gateway"]) {
    const text = await readFile(join(DIR, `${label}.plist`), "utf8");
    assert.match(text, /<key>OMP_PROFILE<\/key>\s*<string>ug-auth<\/string>/, label);
    assert.doesNotMatch(text, /PI_CONFIG_DIR|PI_CODING_AGENT_DIR/, label);
  }
});

test("the backup job runs once a day at 20:00, not at load, and logs in the data folder", async () => {
  const text = await readFile(join(DIR, "com.underground.backup.plist"), "utf8");
  assert.match(text, /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>20<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>\s*<\/dict>/);
  assert.doesNotMatch(text, /<key>(RunAtLoad|KeepAlive|StartInterval)<\/key>/, "it would wake the other machine at each setup or all day");
  assert.match(text, /<key>StandardErrorPath<\/key>\s*<string>@DATA@\/backup\/backup\.log<\/string>/);
});
