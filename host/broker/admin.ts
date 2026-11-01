import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { renderSettings } from "../sandbox/render-settings.ts";
import { send } from "./client.ts";
import { isMap, parseAddresses, parseYaml, renderModels, roleModelsRefusal } from "./gateway.ts";
import type { Addresses, AgentFile, Yaml } from "./gateway.ts";
import { syncOwnerFiles } from "./owner-files.ts";
import {
  ADMIN_SOCKET_NAME,
  MAX_ROLE_NAME_CHARS,
  MAX_SOCKET_PATH_BYTES,
  githubRepoFromGitConfig,
  isRegisterReply,
  isRole,
  isRoleName,
  parseReposFile,
  parseRolesFile,
  validateAdminRequest,
} from "./protocol.ts";
import type { Checked, Role } from "./protocol.ts";

export const ADMIN_SOCKET_PATH = join(homedir(), ".agents/broker/run", ADMIN_SOCKET_NAME);
export const REPOS_FILE = join(homedir(), ".config/underground-broker/repos");
export const ROLES_FILE = join(homedir(), ".config/underground-broker/roles");

const EXIT_USAGE = 64;
const EXIT_REFUSED = 2;
const EXIT_UNAVAILABLE = 69;

const USAGE = `usage:
  admin.ts role <role-name>
  admin.ts start-session <role-name> <binding-role> <repo-folder> <repo-hash> <state-dir> <session-dir> <predict-socket>
  admin.ts addresses
  admin.ts gateway-setup
  admin.ts session <repo-folder> <role-name>
  admin.ts register <repo-id> <role-name> <owner/repo>
`;

const OMP_AGENT_DIR = join(homedir(), ".ug/omp/agent");
const ROLE_TEMPLATES = join(homedir(), ".agents/roles");
const GATEWAY_TOKEN_FILE = join(homedir(), ".omp/auth-gateway.token");
export const ADDRESSES_FILE = join(homedir(), ".config/underground-broker/addresses");

export type Files = { socketPath: string; reposFile: string; rolesFile: string };
const DEFAULT_FILES: Files = { socketPath: ADMIN_SOCKET_PATH, reposFile: REPOS_FILE, rolesFile: ROLES_FILE };

export async function sessionRepo(repoFolder: string, reposFile: string): Promise<string | undefined> {
  let config: string;
  let listed: Set<string>;
  try {
    config = await readFile(join(repoFolder, ".git/config"), "utf8");
    listed = parseReposFile(await readFile(reposFile, "utf8"));
  } catch {
    return undefined;
  }
  const origin = githubRepoFromGitConfig(config)?.toLowerCase();
  if (origin === undefined) return undefined;
  return [...listed].find((repo) => repo.toLowerCase() === origin);
}

export async function lookupRole(name: string, rolesFile: string): Promise<Checked<Role>> {
  if (!isRoleName(name)) return { ok: false, reason: `invalid role name ${JSON.stringify(name)}: use a-z, 0-9 and -, up to ${MAX_ROLE_NAME_CHARS} characters` };
  let text: string;
  try {
    text = await readFile(rolesFile, "utf8");
  } catch {
    return { ok: false, reason: `cannot read the roles file ${rolesFile}` };
  }
  const table = parseRolesFile(text);
  if (!table.ok) return { ok: false, reason: `${rolesFile}: ${table.reason}` };
  const role = table.value.get(name);
  if (role === undefined) return { ok: false, reason: `role name ${name} is not in the roles file ${rolesFile}` };
  return { ok: true, value: role };
}

export const PINNED_SETTINGS = [
  "memory.backend",
  "memories.enabled",
  "autolearn.enabled",
  "autolearn.autoContinue",
  "compaction.experimentalContextManagement",
  "compaction.handoffSaveToDisk",
  "autoResume",
  "plan.autosave",
  "plan.autosaveDir",
  "modelRoleStorage",
  "startup.setupWizard",
  "extensions",
  "disabledExtensions",
  "skills.enabled",
  "skills.customDirectories",
  "skills.ignoredSkills",
  "skills.includeSkills",
  "skills.enablePiUser",
  "skills.enablePiProject",
  "skills.enableAgentsUser",
  "skills.enableAgentsProject",
  "skills.enableClaudeUser",
  "skills.enableClaudeProject",
  "skills.enableCodexUser",
  "commands.enableClaudeUser",
  "commands.enableClaudeProject",
  "commands.enableOpencodeUser",
  "commands.enableOpencodeProject",
  "mcp.enableProjectConfig",
  "enabledProviders",
  "disabledProviders",
  "contextFiles.extra",
  "workspace.additionalDirectories",
  "task.disabledAgents",
  "bash.direnv",
  "bashInterceptor.enabled",
  "bashInterceptor.patterns",
  "shellPath",
  "shellCommandPrefix",
  "shellMinimizer.settingsPath",
  "python.interpreter",
  "ida.python",
  "ida.installDir",
  "images.urls.command",
  "github.enabled",
  "ttsr.builtinRules",
  "ttsr.disabledRules",
  "advisor.enabled",
] as const;

const settingAt = (policy: Yaml, path: string): Yaml | undefined => {
  let node: Yaml | undefined = policy;
  for (const key of path.split(".")) {
    if (!isMap(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
};

const missingPins = (policy: Yaml): string[] => PINNED_SETTINGS.filter((path) => settingAt(policy, path) === undefined);

export function rolePolicyRefusal(policy: Yaml): string | undefined {
  const missing = missingPins(policy);
  if (missing.length > 0) return `it must pin ${missing.join(", ")}`;
  const backend = settingAt(policy, "memory.backend");
  if (backend !== "off") return `it must set memory.backend: off, not ${JSON.stringify(backend)}`;
  const autolearn = settingAt(policy, "autolearn.enabled");
  if (autolearn !== "false") return `it must set autolearn.enabled: false, not ${JSON.stringify(autolearn)}`;
  return undefined;
}

async function agentFiles(agentDir: string): Promise<AgentFile[]> {
  let names: string[];
  try {
    names = (await readdir(join(agentDir, "agents"))).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(agentDir, "agents", name), "utf8") })));
}

export async function roleConfigRefusal(policyPath: string): Promise<string | undefined> {
  const agentDir = dirname(policyPath);
  const modelsPath = join(agentDir, "models.yml");
  let policyText: string;
  let modelsText: string;
  try {
    policyText = await readFile(policyPath, "utf8");
  } catch {
    return `cannot read ${policyPath}`;
  }
  try {
    modelsText = await readFile(modelsPath, "utf8");
  } catch {
    return `cannot read ${modelsPath}; run ug-install to write it`;
  }
  const policy = parseYaml(policyText);
  if (!policy.ok) return `${policyPath}: ${policy.reason}`;
  const pins = rolePolicyRefusal(policy.value);
  if (pins !== undefined) {
    const hint = missingPins(policy.value).length > 0 ? "; run ug-install to restore ~/.agents/roles/policy.yml" : "";
    return `${policyPath}: ${pins}${hint}`;
  }
  const models = parseYaml(modelsText);
  if (!models.ok) return `${modelsPath}: ${models.reason}`;
  const agents = await agentFiles(agentDir);
  const refusal = roleModelsRefusal(policy.value, models.value, agents);
  return refusal === undefined ? undefined : `${agentDir}: ${refusal}`;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

async function readOrCreate(path: string, make: () => string): Promise<string> {
  try {
    await writeFile(path, make(), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  return (await readFile(path, "utf8")).trim();
}

export async function readAddresses(): Promise<Checked<Addresses>> {
  let text: string;
  try {
    text = await readFile(ADDRESSES_FILE, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return { ok: false, reason: `${ADDRESSES_FILE} is missing; run ug-install to write it, or write it with the lines gateway=<ip>:<port> and engine=<ip>:<port>` };
  }
  const parsed = parseAddresses(text);
  return parsed.ok ? parsed : { ok: false, reason: `${ADDRESSES_FILE}: ${parsed.reason}` };
}

export async function gatewaySetup(rolesFile: string): Promise<string | undefined> {
  const addresses = await readAddresses();
  if (!addresses.ok) return addresses.reason;
  const table = parseRolesFile(await readFile(rolesFile, "utf8"));
  if (!table.ok) return `${rolesFile}: ${table.reason}`;
  const template = await readFile(join(ROLE_TEMPLATES, "models.yml"), "utf8");
  await mkdir(dirname(GATEWAY_TOKEN_FILE), { recursive: true, mode: 0o700 });
  const token = await readOrCreate(GATEWAY_TOKEN_FILE, () => randomBytes(32).toString("hex"));
  await mkdir(OMP_AGENT_DIR, { recursive: true, mode: 0o700 });
  const policyPath = join(OMP_AGENT_DIR, "policy.yml");
  await writeAtomic(policyPath, await readFile(join(ROLE_TEMPLATES, "policy.yml"), "utf8"));
  const rendered = renderModels(template, addresses.value, token);
  if (!rendered.ok) return `${join(ROLE_TEMPLATES, "models.yml")}: ${rendered.reason}`;
  await writeAtomic(join(OMP_AGENT_DIR, "models.yml"), rendered.value);
  const refusal = await roleConfigRefusal(policyPath);
  if (refusal !== undefined) return refusal;
  process.stdout.write(`gateway-setup: ${[...table.value.keys()].sort().join(", ")}: all gateway models, every account\n`);
  return undefined;
}

const MAX_BINDING_NAME_CHARS = 55;

export function bindingRepoId(repoFolder: string, runDir: string, hash: string): string {
  const room = MAX_SOCKET_PATH_BYTES - Buffer.byteLength(join(runDir, `-${hash}`, `${"x".repeat(MAX_ROLE_NAME_CHARS)}.sock`));
  const name = basename(repoFolder)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, Math.max(0, Math.min(room, MAX_BINDING_NAME_CHARS)));
  return name === "" ? hash : `${name}-${hash}`;
}

async function registerInput(argv: string[], files: Files, repoHash?: string): Promise<Record<string, unknown> | null | undefined> {
  const [verb, ...args] = argv;
  if (verb === "session" && args.length === 2) {
    const repo = await sessionRepo(args[0], files.reposFile);
    if (repo === undefined) return null;
    const hash = repoHash ?? createHash("sha256").update(args[0]).digest("hex").slice(0, 8);
    return { verb: "register", repo_id: bindingRepoId(args[0], dirname(files.socketPath), hash), role_name: args[1], repo };
  }
  if (verb === "register" && args.length === 3) {
    return { verb, repo_id: args[0], role_name: args[1], repo: args[2] };
  }
  return undefined;
}

type Registration = { kind: "registered"; socket: string } | { kind: "unlisted" } | { kind: "error"; exit: number; stderr: string };

async function register(argv: string[], files: Files, repoHash?: string): Promise<Registration> {
  const input = await registerInput(argv, files, repoHash);
  if (input === undefined) return { kind: "error", exit: EXIT_USAGE, stderr: USAGE };
  if (input === null) return { kind: "unlisted" };
  const checked = validateAdminRequest(input);
  if (!checked.ok) return { kind: "error", exit: EXIT_USAGE, stderr: `broker admin: ${checked.reason}\n` };
  let reply;
  try {
    reply = await send(files.socketPath, checked.value);
  } catch (error) {
    return { kind: "error", exit: EXIT_UNAVAILABLE, stderr: `broker admin: cannot reach broker: ${error instanceof Error ? error.message : String(error)}\n` };
  }
  if ("refused" in reply) return { kind: "error", exit: EXIT_REFUSED, stderr: `broker admin: refused: ${reply.refused}\n` };
  if (reply.exit !== 0) return { kind: "error", exit: reply.exit, stderr: reply.stderr };
  if (!isRegisterReply(reply)) return { kind: "error", exit: 1, stderr: "broker admin: register reply has no socket\n" };
  return { kind: "registered", socket: reply.socket };
}

// One Node process for the session start: owner files, policy check, broker registration, and sandbox settings.
// Prints the broker socket (empty when none) and the settings file, one per line.
async function startSession(args: string[], files: Files): Promise<number> {
  const [roleName, role, repo, repoHash, state, sessions, predictSocket] = args;
  if (args.length !== 7 || !isRoleName(roleName) || !isRole(role) || !/^[0-9a-f]{8}$/.test(repoHash)) {
    process.stderr.write(USAGE);
    return EXIT_USAGE;
  }
  try {
    syncOwnerFiles(dirname(OMP_AGENT_DIR));
    const refusal = await roleConfigRefusal(join(OMP_AGENT_DIR, "policy.yml"));
    if (refusal !== undefined) {
      process.stderr.write(`broker admin: ${refusal}\n`);
      return EXIT_REFUSED;
    }
    let brokerSocket = "";
    if (existsSync(join(repo, ".git/config"))) {
      const registration = await register(["session", repo, roleName], files, repoHash);
      if (registration.kind === "registered") brokerSocket = registration.socket;
      if (registration.kind === "error") process.stderr.write(`${registration.stderr}omp: the broker did not register this session; this session has no broker socket\n`);
    }
    const addresses = await readAddresses();
    if (!addresses.ok) {
      process.stderr.write(`broker admin: ${addresses.reason}\n`);
      return EXIT_REFUSED;
    }
    const settings = renderSettings({ home: homedir(), roleName, role, repo, repoHash, state, sessions, brokerSocket, predictSocket, addresses: addresses.value });
    process.stdout.write(`${brokerSocket}\n${settings}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function localVerb(argv: string[], files: Files): Promise<number | undefined> {
  const [verb, ...args] = argv;
  if (verb === "start-session") return startSession(args, files);
  if (verb === "role" && args.length === 1) {
    const role = await lookupRole(args[0], files.rolesFile);
    if (!role.ok) {
      process.stderr.write(`broker admin: ${role.reason}\n`);
      return EXIT_REFUSED;
    }
    process.stdout.write(`${role.value}\n`);
    return 0;
  }
  if (verb === "addresses" && args.length === 0) {
    const addresses = await readAddresses();
    if (addresses.ok) {
      process.stdout.write(`${addresses.value.gateway} ${addresses.value.engine}\n`);
      return 0;
    }
    process.stderr.write(`broker admin: ${addresses.reason}\n`);
    return EXIT_REFUSED;
  }
  if (verb === "gateway-setup" && args.length === 0) {
    const refusal = await gatewaySetup(files.rolesFile);
    if (refusal === undefined) return 0;
    process.stderr.write(`broker admin: gateway-setup: ${refusal}\n`);
    return EXIT_REFUSED;
  }
  return undefined;
}

export async function main(argv: string[], files: Files = DEFAULT_FILES): Promise<number> {
  const local = await localVerb(argv, files);
  if (local !== undefined) return local;
  const result = await register(argv, files);
  if (result.kind === "registered") process.stdout.write(`${result.socket}\n`);
  if (result.kind === "error") {
    process.stderr.write(result.stderr);
    return result.exit;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
