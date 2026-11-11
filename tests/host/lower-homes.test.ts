import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const ROOT = join(import.meta.dirname, "../..");
const CHECK = join(ROOT, "scripts/check-lower-homes.mjs");

const FAILING: Array<[string, number[]]> = [
  ['auth_home=$(ug_fact auth_home)\ncat "$auth_home/.omp/token"', [2]],
  ['auth_home=$(ug_fact auth_home)\ncat "${auth_home}/x"', [2]],
  ['agent_home=$(ug_fact agent_home)\nssh=$agent_home/.ssh\nstat "$ssh"', [2, 3]],
  ['auth_home=$(ug_fact auth_home)\nug_die tool "$auth_home/.omp/token is missing"', [2]],
  ['cat "$(ug_fact auth_home)/x"', [1]],
];

const PASSING = [
  'auth_home=$(ug_fact auth_home)\nug_read_as "$auth_user" "$auth_home/.omp/token"',
  'auth_home=$(ug_fact auth_home)\nsudo -u "$auth_user" install -d "$auth_home/.omp"',
  'auth_home=$(ug_fact auth_home)\nsudo -n -u x ls "$auth_home/a"',
  'auth_home=$(ug_fact auth_home)\nls "$auth_home"',
  'agent_home=$(ug_fact agent_home)\nmake_user "$u" "$agent_home"',
  'owner_home=/Users/$owner\ncat "$owner_home/x"',
];

test("real repo has no path below a lower home outside a drop line", () => {
  const run = spawnSync(process.execPath, [CHECK], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

test("lower-home rule rejects paths below lower homes and accepts drop lines and bare homes", async (t) => {
  const root = await tempDir(join(tmpdir(), "lower-homes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "host/bin"), { recursive: true });
  await mkdir(join(root, "host/agent"), { recursive: true });
  await copyFile(CHECK, join(root, "scripts/check-lower-homes.mjs"));
  await writeFile(join(root, "host/facts"), "auth_home=/Users/x\nagent_home=/Users/y\n");
  await writeFile(join(root, "host/bin/tool"), "\n");
  await writeFile(join(root, "host/agent/agent-start"), 'echo "@AGENT_HOME@/logs"\n');
  for (const args of [["init", "--quiet"], ["add", "host/bin/tool", "host/agent/agent-start"]]) {
    const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  }
  for (const [text, lines] of FAILING) {
    await writeFile(join(root, "host/bin/tool"), `${text}\n`);
    const run = spawnSync(process.execPath, [join(root, "scripts/check-lower-homes.mjs")], { encoding: "utf8" });
    assert.equal(run.status, 1, text);
    for (const line of lines) {
      assert.ok(run.stderr.includes(`host/bin/tool:${line}: a path below the home of a user with fewer rights`), `${text}\n${run.stderr}`);
    }
  }
  for (const text of PASSING) {
    await writeFile(join(root, "host/bin/tool"), `${text}\n`);
    const run = spawnSync(process.execPath, [join(root, "scripts/check-lower-homes.mjs")], { encoding: "utf8" });
    assert.equal(run.status, 0, `${text}\n${run.stderr}`);
  }
});
