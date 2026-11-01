import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { syncOwnerFiles } from "../../host/broker/owner-files.ts";

const savedHome = process.env.HOME;
let root = "";
let templates = "";
let agent = "";
function sync(): void {
  syncOwnerFiles(join(root, ".ug/omp"));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "owner-files-"));
  process.env.HOME = root;
  templates = join(root, ".agents/roles");
  await mkdir(join(templates, "hooks/pre"), { recursive: true });
  await writeFile(join(templates, "policy.yml"), "policy: 1\n");
  await writeFile(join(templates, "hooks/pre/concise-reply.ts"), "export {};\n");
  await writeFile(join(templates, "hooks/pre/role-rules.ts"), "export {};\n");
  agent = join(root, ".ug/omp/agent");
  await mkdir(join(agent, "hooks/pre"), { recursive: true });
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

test("a compliant unchanged owner file keeps its identity and content", async () => {
  sync();
  const before = await stat(join(agent, "policy.yml"));
  sync();
  const after = await stat(join(agent, "policy.yml"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(join(agent, "policy.yml"), "utf8"), "policy: 1\n");
});

test("a template change reaches the omp root with mode 0644", async () => {
  sync();
  await writeFile(join(templates, "hooks/pre/role-rules.ts"), "export const x = 1;\n");
  await chmod(join(templates, "hooks/pre/role-rules.ts"), 0o600);
  sync();
  assert.equal(await readFile(join(agent, "hooks/pre/role-rules.ts"), "utf8"), "export const x = 1;\n");
  assert.equal((await stat(join(agent, "hooks/pre/role-rules.ts"))).mode & 0o7777, 0o644);
});

test("matching bytes with the wrong mode are repaired to 0644", async () => {
  sync();
  await chmod(join(agent, "policy.yml"), 0o666);
  sync();
  assert.equal((await stat(join(agent, "policy.yml"))).mode & 0o7777, 0o644);
  assert.equal(await readFile(join(agent, "policy.yml"), "utf8"), "policy: 1\n");
});

test("a destination symlink is refused and its target is left alone", async () => {
  const target = join(root, "elsewhere.yml");
  await writeFile(target, "precious\n");
  await chmod(target, 0o600);
  await symlink(target, join(agent, "policy.yml"));
  assert.throws(sync, /^Error: omp: .*policy\.yml must be a file, not a symlink or a folder/);
  assert.ok((await lstat(join(agent, "policy.yml"))).isSymbolicLink());
  assert.equal(await readFile(target, "utf8"), "precious\n");
  assert.equal((await stat(target)).mode & 0o7777, 0o600);
});

test("a destination folder is refused and its content is left alone", async () => {
  await mkdir(join(agent, "hooks/pre/role-rules.ts"));
  await writeFile(join(agent, "hooks/pre/role-rules.ts/keep"), "keep\n");
  assert.throws(sync, /^Error: omp: .*role-rules\.ts must be a file, not a symlink or a folder/);
  assert.deepEqual(await readdir(join(agent, "hooks/pre/role-rules.ts")), ["keep"]);
});
