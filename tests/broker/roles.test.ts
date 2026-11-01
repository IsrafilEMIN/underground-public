import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PINNED_SETTINGS, rolePolicyRefusal } from "../../host/broker/admin.ts";
import { isMap, parseYaml } from "../../host/broker/gateway.ts";
import type { Yaml } from "../../host/broker/gateway.ts";
import { send } from "../../host/broker/client.ts";
import { ROLE_VERBS, bindingRefusal, isRegisterReply, parseRolesFile, validateAdminRequest } from "../../host/broker/protocol.ts";
import { adminSocketPath, defaultConfig, startServer, stopServer } from "../../host/broker/server.ts";
import { tempDir } from "../temp.ts";

const ROLES = "# <role name> <role>\nauthor author\nsecurity-review security-review\nsec2 security-review\n";
const ADMIN = join(import.meta.dirname, "../../host/broker/admin.ts");

test("the roles file maps each role name to author or one reviewer role", () => {
  const table = parseRolesFile(ROLES);
  assert.ok(table.ok);
  assert.deepEqual([...table.value], [
    ["author", "author"],
    ["security-review", "security-review"],
    ["sec2", "security-review"],
  ]);
});

test("the roles file refuses an unknown role, a bad name, and a name listed twice", () => {
  for (const text of ["x review\n", "x security-reveiw\n", "X author\n", "../x author\n", "x author extra\n", "x author\nx code-review\n"]) {
    assert.equal(parseRolesFile(text).ok, false, text);
  }
});

test("a reviewer role cannot push, open, or merge a PR", () => {
  for (const role of ["code-review", "security-review", "risk-review"] as const) {
    assert.deepEqual(ROLE_VERBS[role], ["sync", "pr-status", "review"]);
  }
  const binding = { repo: "o/r", role_name: "sec2", role: "security-review" } as const;
  assert.match(bindingRefusal(binding, { verb: "merge", repo: "o/r", number: 1 }) ?? "", /sec2 sessions \(role security-review\) cannot use merge/);
  assert.equal(bindingRefusal(binding, { verb: "sync", repo: "o/r" }), undefined);
});

test("an admin register request carries a role name, not a role", () => {
  assert.equal(validateAdminRequest({ verb: "register", repo_id: "r-1", role_name: "Bad", repo: "o/r" }).ok, false);
  assert.deepEqual(validateAdminRequest({ verb: "register", repo_id: "r-1", role_name: "sec2", repo: "o/r", role: "author" }), {
    ok: true,
    value: { verb: "register", repo_id: "r-1", role_name: "sec2", repo: "o/r" },
  });
});

test("the policy of a role pins every pinned setting, with memory.backend off and autolearn.enabled false", async () => {
  const parse = (text: string): Yaml => {
    const parsed = parseYaml(text);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
    return parsed.value;
  };
  const text = await readFile(join(import.meta.dirname, "../../host/roles/policy.yml"), "utf8");
  const template = parse(text);
  assert.equal(rolePolicyRefusal(template), undefined);
  assert.ok(isMap(template));
  const listed = Object.keys(template).filter((key) => key !== "modelRoles" && key !== "retry");
  for (const key of listed) assert.ok(PINNED_SETTINGS.some((path) => path === key || path.startsWith(`${key}.`)), `${key} is in the policy but not pinned`);
  for (const path of PINNED_SETTINGS) {
    const policy = parse(text);
    const keys = path.split(".");
    let parent: Yaml = policy;
    for (const key of keys.slice(0, -1)) {
      assert.ok(isMap(parent));
      parent = parent[key];
    }
    assert.ok(isMap(parent));
    delete parent[keys[keys.length - 1]];
    assert.equal(rolePolicyRefusal(policy), `it must pin ${path}`);
  }
  assert.match(rolePolicyRefusal({}) ?? "", /^it must pin memory\.backend, memories\.enabled, /);
  assert.equal(rolePolicyRefusal(parse(text.replace("  backend: off", "  backend: local"))), 'it must set memory.backend: off, not "local"');
  assert.equal(rolePolicyRefusal(parse(text.replace("autolearn:\n  enabled: false", "autolearn:\n  enabled: true"))), 'it must set autolearn.enabled: false, not "true"');
  assert.equal(parseYaml("memory: {backend: off}\n").ok, false);
});

test("admin role prints the role of a name in the table and refuses any other name", async () => {
  const home = await tempDir(join(tmpdir(), "ug-roles-"));
  await mkdir(join(home, ".config/underground-broker"), { recursive: true });
  await writeFile(join(home, ".config/underground-broker/roles"), ROLES);
  const run = (name: string) => spawnSync(process.execPath, [ADMIN, "role", name], { env: { HOME: home }, encoding: "utf8" });
  const known = run("sec2");
  assert.equal(known.status, 0, known.stderr);
  assert.equal(known.stdout, "security-review\n");
  const unknown = run("security-reveiw");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /role name security-reveiw is not in the roles file/);
});

test("the broker refuses to register a name not in the table, and binds a known name to its role", async () => {
  const root = await tempDir(join(process.env.XDG_STATE_HOME ?? tmpdir(), "ugt-"));
  const config = {
    ...defaultConfig(),
    runDir: join(root, "run"),
    bindingsFile: join(root, "bindings.json"),
    reposFile: join(root, "repos"),
    rolesFile: join(root, "roles"),
  };
  await writeFile(config.reposFile, "o/r\n");
  await writeFile(config.rolesFile, ROLES);
  const broker = await startServer(config);
  try {
    const refused = await send(adminSocketPath(config), { verb: "register", repo_id: "r-1", role_name: "security-reveiw", repo: "o/r" });
    assert.deepEqual(refused, { exit: 2, refused: "role name security-reveiw is not in the roles file" });
    const ok = await send(adminSocketPath(config), { verb: "register", repo_id: "r-1", role_name: "sec2", repo: "o/r" });
    assert.ok(isRegisterReply(ok));
    assert.equal(ok.socket, join(config.runDir, "r-1/sec2.sock"));
    assert.deepEqual(JSON.parse(await readFile(config.bindingsFile, "utf8")), {
      "r-1/sec2": { repo: "o/r", role_name: "sec2", role: "security-review" },
    });
  } finally {
    await stopServer(broker);
  }
});

test("a binding whose name left the table, or whose name maps to another role, is refused per request and not restored after a restart", async () => {
  const root = await tempDir(join(process.env.XDG_STATE_HOME ?? tmpdir(), "ugt-"));
  const config = {
    ...defaultConfig(),
    runDir: join(root, "run"),
    bindingsFile: join(root, "bindings.json"),
    reposFile: join(root, "repos"),
    rolesFile: join(root, "roles"),
  };
  await writeFile(config.reposFile, "o/r\n");
  await writeFile(config.rolesFile, `${ROLES}sec3 security-review\n`);
  const push = { verb: "push", repo: "o/r", branch: "agent/x", sha: "a".repeat(40), bundle_b64: "AAAA" };
  let broker = await startServer(config);
  try {
    for (const name of ["author", "sec2", "sec3"]) {
      assert.ok(isRegisterReply(await send(adminSocketPath(config), { verb: "register", repo_id: "r-1", role_name: name, repo: "o/r" })));
    }
    const sec2 = join(config.runDir, "r-1/sec2.sock");
    const sec3 = join(config.runDir, "r-1/sec3.sock");
    assert.deepEqual(await send(sec2, push), { exit: 2, refused: "sec2 sessions (role security-review) cannot use push" });
    await writeFile(config.rolesFile, "author author\nsec3 author\n");
    assert.deepEqual(await send(sec2, push), { exit: 2, refused: "role name sec2 is not in the roles file" });
    assert.deepEqual(await send(sec3, push), { exit: 2, refused: "role name sec3 maps to author in the roles file, not to security-review as when this broker socket was made" });
  } finally {
    await stopServer(broker);
  }
  broker = await startServer(config);
  try {
    assert.deepEqual([...broker.bindings.keys()], ["r-1/author"]);
    assert.deepEqual([...broker.servers.keys()], ["r-1/author"]);
    for (const name of ["sec2", "sec3"]) await assert.rejects(send(join(config.runDir, `r-1/${name}.sock`), push));
  } finally {
    await stopServer(broker);
  }
});
