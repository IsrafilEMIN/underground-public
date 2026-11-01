import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PINNED_SETTINGS } from "../../host/broker/admin.ts";
import { displayPrefs } from "../../host/broker/display-prefs.ts";
import { tempDir } from "../temp.ts";

const SRC = join(import.meta.dirname, "../..");
const pin = /^omp=(.+)$/m.exec(await readFile(join(SRC, "VERSIONS"), "utf8"))?.[1] ?? "";
const OMP = join(homedir(), "Library/Application Support/Tern/omp/versions", pin);
const skip = existsSync(OMP) ? false : `needs the pinned omp ${pin} at ${OMP}`;

type Value = boolean | string | string[] | { pattern: string; tool: string; message: string }[];

const PLANTED: Record<(typeof PINNED_SETTINGS)[number], Value> = {
  "memory.backend": "local",
  "memories.enabled": true,
  "autolearn.enabled": true,
  "autolearn.autoContinue": true,
  "compaction.experimentalContextManagement": true,
  "compaction.handoffSaveToDisk": true,
  autoResume: true,
  "plan.autosave": true,
  "plan.autosaveDir": "/tmp/planted",
  modelRoleStorage: "project",
  "startup.setupWizard": true,
  extensions: ["/tmp/planted/x.ts"],
  disabledExtensions: ["underground-guard"],
  "skills.enabled": false,
  "skills.customDirectories": ["/tmp/planted"],
  "skills.ignoredSkills": ["x"],
  "skills.includeSkills": ["x"],
  "skills.enablePiUser": false,
  "skills.enablePiProject": false,
  "skills.enableAgentsUser": false,
  "skills.enableAgentsProject": false,
  "skills.enableClaudeUser": true,
  "skills.enableClaudeProject": false,
  "skills.enableCodexUser": true,
  "commands.enableClaudeUser": true,
  "commands.enableClaudeProject": false,
  "commands.enableOpencodeUser": true,
  "commands.enableOpencodeProject": false,
  "mcp.enableProjectConfig": false,
  enabledProviders: ["claude"],
  disabledProviders: ["native"],
  "contextFiles.extra": ["PLANTED.md"],
  "workspace.additionalDirectories": ["/tmp/planted"],
  "task.disabledAgents": ["task"],
  "bash.direnv": "off",
  "bashInterceptor.enabled": false,
  "bashInterceptor.patterns": [{ pattern: "^\\s*ls\\b", tool: "read", message: "planted" }],
  shellPath: "/tmp/planted/sh",
  shellCommandPrefix: "/tmp/planted/prefix",
  "shellMinimizer.settingsPath": "/tmp/planted/minimizer.json",
  "python.interpreter": "/tmp/planted/python",
  "ida.python": "/tmp/planted/python",
  "ida.installDir": "/tmp/planted",
  "images.urls.command": "/tmp/planted/upload {file}",
  "github.enabled": true,
  "ttsr.builtinRules": false,
  "ttsr.disabledRules": ["x"],
  "advisor.enabled": false,
};

type Effective = Record<string, { value?: unknown }>;

test("a config.yml that the role writes does not change any pinned setting under the policy overlay", { skip, timeout: 60_000 }, async () => {
  assert.deepEqual(Object.keys(PLANTED).sort(), [...PINNED_SETTINGS].sort());
  const home = await tempDir(join(tmpdir(), "ugp-"));
  const agent = join(home, ".ug/omp/agent");
  await mkdir(agent, { recursive: true });
  const policy = join(agent, "policy.yml");
  await writeFile(policy, await readFile(join(SRC, "host/roles/policy.yml"), "utf8"));
  const planted: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(PLANTED)) {
    const keys = path.split(".");
    let node = planted;
    for (const key of keys.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
    node[keys[keys.length - 1]] = value;
  }
  const config = join(agent, "config.yml");
  const effective = async (files: { config: boolean; policy: boolean }): Promise<Effective> => {
    if (files.config) await writeFile(config, `${JSON.stringify(planted, null, 2)}\n`);
    else await writeFile(config, "");
    const env: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin", PI_CONFIG_DIR: ".ug/omp", PI_NATIVES_DIR: join(homedir(), ".omp/natives") };
    if (files.policy) env.PI_CONFIG_FILES = policy;
    const run = spawnSync(OMP, ["config", "list", "--json"], { cwd: home, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  const policyOnly = await effective({ config: false, policy: true });
  const plantedOnly = await effective({ config: true, policy: false });
  const both = await effective({ config: true, policy: true });
  for (const path of PINNED_SETTINGS) {
    assert.ok(path in policyOnly, `omp has no setting ${path}`);
    assert.notDeepEqual(plantedOnly[path].value, policyOnly[path].value, `the planted ${path} does not change the setting without the overlay`);
    assert.deepEqual(both[path].value, policyOnly[path].value, path);
  }
  assert.equal(policyOnly["memory.backend"].value, "off");
  assert.equal(policyOnly["autolearn.enabled"].value, false);
  assert.equal(policyOnly["startup.setupWizard"].value, false);
});

test("the owner's display settings reach a role, typed as written, but none of the owner's model or safety settings do", { skip, timeout: 60_000 }, async () => {
  const owner = [
    "statusLine:",
    "  preset: custom",
    "  transparent: false",
    "  leftSegments: [model, cache_hit, usage, cost]",
    "symbolPreset: nerd",
    "display: {pinnedAgents: \"full\"}",
    "tui:",
    "  mouse: true",
    "memory:",
    "  backend: local",
    "modelRoles: {default: openai/gpt-4.1-mini}",
    "advisor:",
    "  model: \"007\"",
    "",
  ].join("\n");
  const home = await tempDir(join(tmpdir(), "ugd-"));
  const agent = join(home, ".ug/omp/agent");
  await mkdir(agent, { recursive: true });
  const ownerConfig = join(home, "owner-config.yml");
  const prefs = join(agent, "prefs.yml");
  const policy = join(agent, "policy.yml");
  await writeFile(ownerConfig, owner);
  await writeFile(policy, await readFile(join(SRC, "host/roles/policy.yml"), "utf8"));
  await writeFile(join(agent, "config.yml"), "");
  const make = spawnSync(OMP, [join(SRC, "host/broker/display-prefs.ts"), ownerConfig, prefs], { cwd: "/", env: { ...process.env, BUN_BE_BUN: "1" }, encoding: "utf8" });
  assert.equal(make.status, 0, make.stderr);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(prefs, "utf8"))).sort(), ["display", "statusLine", "symbolPreset", "tui"]);
  const env = { HOME: home, PATH: "/usr/bin:/bin", PI_CONFIG_DIR: ".ug/omp", PI_NATIVES_DIR: join(homedir(), ".omp/natives"), PI_CONFIG_FILES: `${prefs}:${policy}` };
  const run = spawnSync(OMP, ["config", "list", "--json"], { cwd: home, env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const effective: Record<string, { value?: unknown }> = JSON.parse(run.stdout);
  assert.equal(effective["statusLine.preset"].value, "custom");
  assert.equal(effective["statusLine.transparent"].value, false);
  assert.deepEqual(effective["statusLine.leftSegments"].value, ["model", "cache_hit", "usage", "cost"]);
  assert.equal(effective.symbolPreset.value, "nerd");
  assert.equal(effective["display.pinnedAgents"].value, "full");
  assert.equal(effective["tui.mouse"].value, true);
  assert.equal(effective["memory.backend"].value, "off");
});

test("display prefs keep only display keys, with their values as parsed", () => {
  assert.deepEqual(displayPrefs({ modelRoles: { default: "x" }, retry: { maxRetries: 3 } }), {});
  assert.deepEqual(displayPrefs("not a map"), {});
  assert.deepEqual(displayPrefs({ theme: { dark: "dark" }, statusLine: { transparent: false }, advisor: { model: "007" } }), { theme: { dark: "dark" }, statusLine: { transparent: false } });
});
