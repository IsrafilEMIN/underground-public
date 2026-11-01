import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, join, normalize } from "node:path";
import type { Addresses } from "../broker/gateway.ts";
import { isRoleName } from "../broker/protocol.ts";
import type { Role } from "../broker/protocol.ts";

export type SettingsInput = {
  home: string;
  roleName: string;
  role: Role;
  repo: string;
  repoHash: string;
  state: string;
  sessions: string;
  brokerSocket: string;
  predictSocket: string;
  addresses: Addresses;
};

type Json = string | number | boolean | null | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };

const DAY_MS = 24 * 60 * 60 * 1000;

const GIT_WRITE_PATHS = ["objects", "refs", "logs", "packed-refs", "packed-refs.lock", "packed-refs.new", "worktrees"];

const OWNER_AGENT_PATHS = [
  "AGENTS.md",
  "RULES.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "SYSTEM_TEMPLATE.md",
  "PERSONALITY.md",
  "WATCHDOG.md",
  "TITLE_SYSTEM.md",
  "policy.yml",
  "prefs.yml",
  "models.yml",
  "models.yaml",
  "models.container.yml",
  "settings.json",
  "mcp.json",
  ".mcp.json",
  ".env",
  "secrets.yml",
  "lsp.json",
  "keybindings.*",
  "extensions",
  "skills",
  "managed-skills",
  "rules",
  "commands",
  "hooks",
  "agents",
  "tools",
  "themes",
  "memories",
  "prompts",
];

const OWNER_OMP_PATHS = ["plugins", "marketplaces.json", ".env", "profiles", "browser-relay"];

const DESTINATION = /^(?:(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*(?::\d{1,5})?|\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})$/;

function refuse(reason: string): Error {
  return new Error(`render-settings: ${reason}`);
}

const isObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

const trimmed = (p: string): string => normalize(p).replace(/\/+$/, "");

function lstatOrUndefined(p: string): Stats | undefined {
  return lstatSync(p, { throwIfNoEntry: false });
}

function realDir(dir: string): string {
  const real = realpathSync(dir);
  if (!statSync(real).isDirectory()) throw refuse(`not a folder: ${dir}`);
  return real;
}

function placedDir(given: string, root: string, what: string): string {
  const dir = given.replace(/\/+$/, "");
  if (lstatOrUndefined(dir)?.isSymbolicLink() === true) throw refuse(`${what} is a symlink: ${dir}`);
  mkdirSync(dir, { recursive: true });
  const real = realDir(dir);
  if (real !== join(root, basename(dir))) throw refuse(`${what} is not directly in ${root}: ${dir}`);
  return real;
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function fillJson(value: unknown, values: Readonly<Record<string, string>>): Json {
  if (typeof value === "string") {
    return value.replace(/@[A-Z]+@/g, (m) => {
      if (!Object.hasOwn(values, m)) throw refuse(`unknown placeholder ${m}`);
      return values[m];
    });
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => fillJson(item, values));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]: [string, unknown]) => [key, fillJson(item, values)]));
  }
  throw refuse("template is not JSON");
}

function objectAt(owner: JsonObject, key: string, where: string): JsonObject {
  const value = owner[key];
  if (!isObject(value)) throw refuse(`template ${where} is not an object`);
  return value;
}

function stringsAt(owner: JsonObject, key: string, where: string): string[] {
  const value = owner[key];
  if (!Array.isArray(value)) throw refuse(`template ${where} is not a list`);
  if (!value.every((item): item is string => typeof item === "string")) throw refuse(`template ${where} has a non-string entry`);
  return value;
}

function removeStaleJson(dir: string, now: number): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      removeStaleJson(p, now);
    } else if (entry.isFile() && entry.name.endsWith(".json") && now - lstatSync(p).mtimeMs >= DAY_MS) {
      unlinkSync(p);
    }
  }
}

function gatewayIsLocal(gatewayIp: string): boolean {
  let interfaces: string;
  try {
    interfaces = execFileSync("ifconfig", { encoding: "utf8" });
  } catch {
    throw refuse("ifconfig failed, so render-settings cannot check that the gateway address is on this mac");
  }
  return interfaces.split("\n").some((line) => {
    const [word, ip] = line.trim().split(/\s+/);
    return word === "inet" && ip === gatewayIp;
  });
}

const ownerPattern = (p: string): RegExp => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*") + "(?:/.*)?$");

export function renderSettings(input: SettingsInput): string {
  const { home, roleName, role, repoHash, brokerSocket, predictSocket, addresses } = input;
  const sandboxDir = join(home, ".agents/sandbox");
  const template = join(sandboxDir, "srt-settings.template.json");
  const runDir = join(sandboxDir, "run");
  const addressesFile = join(home, ".config/underground-broker/addresses");
  const author = role === "author";

  if (!isRoleName(roleName)) throw refuse(`invalid role name: ${roleName}`);
  if (input.sessions === "") throw refuse("session folder is empty");
  if (statSync(input.repo, { throwIfNoEntry: false })?.isDirectory() !== true) throw refuse(`repo folder not found: ${input.repo}`);
  if (statSync(template, { throwIfNoEntry: false })?.isFile() !== true) throw refuse(`template not found: ${template}`);
  const givenOmpRoot = join(home, ".ug/omp");
  const ompRootStat = lstatOrUndefined(givenOmpRoot);
  if (ompRootStat === undefined || ompRootStat.isSymbolicLink() || !ompRootStat.isDirectory()) throw refuse(`omp root is not a folder: ${givenOmpRoot}`);
  const ompRoot = realDir(givenOmpRoot);
  const roleTemplates = join(home, ".agents/roles", role);
  const allowlist = join(roleTemplates, "network-allowlist");
  const allowlistStat = lstatOrUndefined(allowlist);
  if (allowlistStat === undefined || allowlistStat.isSymbolicLink() || !allowlistStat.isFile()) {
    throw refuse(`no network allowlist for role ${role}: ${allowlist}; install.sh puts it there`);
  }
  const rulesFile = join(roleTemplates, "AGENTS.md");
  const rules = statSync(rulesFile, { throwIfNoEntry: false })?.isFile() === true ? [rulesFile] : [];
  const store: string[] = [];
  if (!author) {
    const givenStore = join(home, ".ug/git", roleName);
    const storeStat = lstatOrUndefined(givenStore);
    if (storeStat === undefined || storeStat.isSymbolicLink() || !storeStat.isDirectory()) throw refuse(`reviewer store folder is not a folder: ${givenStore}`);
    store.push(realDir(givenStore));
  }

  const gatewayIp = addresses.gateway.replace(/:[^:]*$/, "");
  if (!gatewayIsLocal(gatewayIp)) {
    throw refuse(`the gateway address ${gatewayIp} in ${addressesFile} is on no interface of this mac; set gateway= to the address that tailscale ip -4 prints`);
  }

  mkdirSync(join(home, ".omp/wt"), { recursive: true });
  mkdirSync(join(ompRoot, "agent/sessions", roleName), { recursive: true });
  const wtRoot = realDir(join(home, ".omp/wt"));
  const sessionsRoot = realDir(join(ompRoot, "agent/sessions", roleName));
  const stateRoot = realDir(join(ompRoot, "underground/state", roleName));
  const repo = realDir(input.repo);
  const gitDir = join(repo, ".git");
  const gitDirStat = lstatOrUndefined(gitDir);
  if (gitDirStat === undefined || gitDirStat.isSymbolicLink() || !gitDirStat.isDirectory()) throw refuse(`repo folder has no .git folder: ${repo}`);
  const gitPaths: string[] = [];
  const authorWt: string[] = [];
  if (author) {
    for (const p of GIT_WRITE_PATHS) {
      const gitPath = join(gitDir, p);
      if (lstatOrUndefined(gitPath)?.isSymbolicLink() === true) throw refuse(`git path is a symlink: ${gitPath}`);
      gitPaths.push(gitPath);
    }
    mkdirSync(join(gitDir, "worktrees"), { recursive: true });
    authorWt.push(placedDir(join(wtRoot, `${basename(repo)}-${repoHash}`), wtRoot, "worktree folder"));
  }
  const state = placedDir(input.state, stateRoot, "state folder");
  const sessions = placedDir(input.sessions, sessionsRoot, "session folder");

  mkdirSync(runDir, { recursive: true });
  chmodSync(runDir, 0o700);
  removeStaleJson(runDir, Date.now());

  const placeholders: Record<string, string> = { "@HOME@": home, "@SESSIONS@": sessions, "@ROLE@": ompRoot };
  const parsed: unknown = JSON.parse(readFileSync(template, "utf8"));
  const settings = fillJson(parsed, placeholders);
  if (!isObject(settings)) throw refuse(`template is not an object: ${template}`);
  const filesystem = objectAt(settings, "filesystem", "filesystem");
  const network = objectAt(settings, "network", "network");
  const allowRead = stringsAt(filesystem, "allowRead", "filesystem.allowRead");
  const allowWrite = stringsAt(filesystem, "allowWrite", "filesystem.allowWrite");
  const templateDenyWrite = stringsAt(filesystem, "denyWrite", "filesystem.denyWrite");
  const allowUnixSockets = stringsAt(network, "allowUnixSockets", "network.allowUnixSockets");
  const skillLinkRoots = settings.skillLinkRoots === undefined || settings.skillLinkRoots === null ? [] : stringsAt(settings, "skillLinkRoots", "skillLinkRoots");
  delete settings.skillLinkRoots;

  allowRead.push(...(author ? [repo, ...authorWt] : []), state, ...store, ...rules);
  const skillRoots = skillLinkRoots.map(realOrNull).filter((r): r is string => r !== null);
  const skillsDir = join(home, ".agents/skills");
  const skillEntries = existsSync(skillsDir) ? readdirSync(skillsDir, { withFileTypes: true }) : [];
  for (const entry of skillEntries) {
    if (!entry.isSymbolicLink()) continue;
    const link = join(skillsDir, entry.name);
    const target = realOrNull(link);
    if (target === null || !statSync(target).isDirectory()) {
      process.stderr.write(`render-settings: skill link has no folder target, skipped: ${link}\n`);
      continue;
    }
    if (!skillRoots.some((root) => target === root || target.startsWith(`${root}/`))) {
      process.stderr.write(`render-settings: skill link target is not under an approved root, skipped: ${link} -> ${target}\n`);
      continue;
    }
    allowRead.push(target);
  }
  allowWrite.push(...(author ? authorWt : store), ...gitPaths, state, predictSocket, `${predictSocket}.bind.lock`);
  const unixSockets = [...(brokerSocket === "" ? [] : [brokerSocket]), state, predictSocket, ...allowUnixSockets];

  const allowlistText = readFileSync(allowlist, "utf8").replaceAll("@GATEWAY@", addresses.gateway).replaceAll("@ENGINE@", addresses.engine);
  const allowedDomains = allowlistText
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => l !== "");
  for (const d of allowedDomains) {
    const placeholder = /@[A-Z_]+@/.exec(d);
    if (placeholder !== null) throw refuse(`${allowlist}: unknown placeholder ${placeholder[0]}`);
    if (!DESTINATION.test(d)) throw refuse(`${allowlist}: not a domain, or an address without a port: ${d}`);
  }

  if (allowWrite.some((p) => trimmed(p) === gitDir)) throw refuse(`allowWrite grants the .git folder ${gitDir}`);
  const ownerPart = join(ompRoot, "agent");
  const ownerPaths = [...OWNER_AGENT_PATHS.map((p) => join(ownerPart, p)), ...OWNER_OMP_PATHS.map((p) => join(ompRoot, p))];
  const ownerPatterns = ownerPaths.map(ownerPattern);
  const ownerGrant = allowWrite.find((p) => {
    const q = trimmed(p);
    return ownerPatterns.some((o) => o.test(q));
  });
  if (ownerGrant !== undefined) throw refuse(`allowWrite grants an owner path of the omp root: ${ownerGrant}`);
  if (!author) {
    const repoGrant = [...allowRead, ...allowWrite].find((p) => {
      const q = trimmed(p);
      return repo === q || repo.startsWith(`${q}/`) || q.startsWith(`${repo}/`);
    });
    if (repoGrant !== undefined) throw refuse(`a reviewer role gets a grant on the repo folder ${repo}: ${repoGrant}`);
  }
  const denyRoots = [repo, ...authorWt];
  const denyWrite = templateDenyWrite.flatMap((p) => (p.startsWith("/") ? [p] : denyRoots.map((root) => `${root}/${p}`)));
  denyWrite.push(...ownerPaths);
  for (const dir of store) denyWrite.push(join(dir, "*.git/config"), join(dir, "*.git/hooks"));

  filesystem.allowRead = allowRead;
  filesystem.allowWrite = allowWrite;
  filesystem.denyWrite = denyWrite;
  network.allowUnixSockets = unixSockets;
  network.allowedDomains = allowedDomains;

  const file = join(runDir, `${randomBytes(12).toString("hex")}.json`);
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return file;
}
