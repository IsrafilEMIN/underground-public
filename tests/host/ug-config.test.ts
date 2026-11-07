import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const UG_CONFIG = join(import.meta.dirname, "../../box/ug-config");
const NAMES = join(import.meta.dirname, "../../box/config-names");

test("ug-config replaces only the config names, keeps omp's own data, and follows no planted link", { skip: process.platform !== "linux" && "ug-config runs in the Linux box (GNU mv -T)" }, async (t) => {
  const home = await tempDir(join(tmpdir(), "ug-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agent = join(home, ".omp/agent");
  const outside = join(home, "outside");
  await mkdir(join(agent, "sessions/--work--"), { recursive: true });
  await mkdir(join(agent, "skills/planted"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(agent, "sessions/--work--/s.jsonl"), "transcript\n");
  await writeFile(join(agent, "agent.db"), "db\n");
  await writeFile(join(agent, "skills/planted/SKILL.md"), "planted\n");
  await writeFile(join(agent, "RULES.md"), "agent's own rules\n");
  await symlink(outside, join(agent, "hooks"));

  const src = join(home, "src");
  await mkdir(join(src, "skills/fix-bug"), { recursive: true });
  await mkdir(join(src, "hooks/pre"), { recursive: true });
  await writeFile(join(src, "AGENTS.md"), "# owner rules\n");
  await writeFile(join(src, "skills/fix-bug/SKILL.md"), "fix the bug\n");
  await writeFile(join(src, "hooks/pre/h.ts"), "export default () => {};\n");
  const tar = spawnSync("tar", ["-c", "-C", src, "."]);
  const r = spawnSync("sh", [UG_CONFIG], { input: tar.stdout, env: { HOME: home, PATH: "/usr/bin:/bin", UG_CONFIG_NAMES: NAMES }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);

  assert.equal(await readFile(join(agent, "AGENTS.md"), "utf8"), "# owner rules\n");
  assert.equal(await readFile(join(agent, "skills/fix-bug/SKILL.md"), "utf8"), "fix the bug\n");
  await assert.rejects(lstat(join(agent, "skills/planted")), "a planted skill stayed");
  await assert.rejects(lstat(join(agent, "RULES.md")), "a config file the repo lacks stayed");
  assert.ok((await lstat(join(agent, "hooks"))).isDirectory(), "hooks is still the planted link");
  assert.deepEqual(await readdir(outside), [], "the new hooks went through the planted link");
  assert.equal(await readFile(join(agent, "sessions/--work--/s.jsonl"), "utf8"), "transcript\n");
  assert.equal(await readFile(join(agent, "agent.db"), "utf8"), "db\n");
  assert.deepEqual((await readdir(agent)).filter((n) => n.startsWith(".ug-config")), [], "the staging folder stayed");
});
