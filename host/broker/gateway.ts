import type { Checked } from "./protocol.ts";

export type Yaml = string | Yaml[] | { [key: string]: Yaml };
export type YamlMap = { [key: string]: Yaml };

type Line = { indent: number; text: string; no: number };

class YamlRefusal extends Error {}

const refuse = (line: Line | undefined, reason: string): never => {
  throw new YamlRefusal(line === undefined ? reason : `line ${line.no}: ${reason}`);
};

const stripComment = (raw: string): string => {
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
};

const scalar = (line: Line, text: string): string => {
  const quoted = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^']|'')*)'$/.exec(text);
  if (quoted !== null) {
    if (quoted[1] !== undefined) return quoted[1].replace(/\\(["\\])/g, "$1");
    return quoted[2].replace(/''/g, "'");
  }
  if (/^["']/.test(text)) refuse(line, `unclosed quote: ${text}`);
  if (/^[&*!|>%@`{]/.test(text)) refuse(line, `quote the value or write it in block style: ${text}`);
  return text;
};

const value = (line: Line, text: string): Yaml => {
  if (text === "{}") return {};
  if (text === "[]") return [];
  if (text.startsWith("[")) {
    if (!text.endsWith("]") || /[[\]{}]/.test(text.slice(1, -1))) refuse(line, `write the list in block style: ${text}`);
    return text
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map((item) => scalar(line, item));
  }
  return scalar(line, text);
};

const KEY = /^((?:"[^"]*")|(?:'[^']*')|[^\s:#"'][^:]*?)\s*:(?:\s+(.*))?$/;

export function parseYaml(text: string): Checked<Yaml> {
  const lines: Line[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const body = stripComment(raw).trimEnd();
    if (body.trim() === "" || body === "---") continue;
    if (/^\s*\t/.test(body)) return { ok: false, reason: `line ${i + 1}: indent with spaces, not tabs` };
    const indent = body.length - body.trimStart().length;
    lines.push({ indent, text: body.trimStart(), no: i + 1 });
  }
  let at = 0;

  const block = (indent: number): Yaml => {
    const first = lines[at];
    if (first.text === "-" || first.text.startsWith("- ")) return sequence(indent);
    return mapping(indent);
  };

  const child = (parent: Line): Yaml => {
    const next = lines[at];
    if (next !== undefined && next.indent > parent.indent) return block(next.indent);
    if (next !== undefined && next.indent === parent.indent && (next.text === "-" || next.text.startsWith("- "))) return sequence(next.indent);
    return "";
  };

  const entry = (line: Line, text: string, into: YamlMap): void => {
    const match = KEY.exec(text);
    if (match === null) return refuse(line, `expected "key: value", got ${text}`);
    const key = scalar(line, match[1]);
    if (Object.hasOwn(into, key)) refuse(line, `duplicate key ${key}`);
    into[key] = match[2] === undefined ? child(line) : value(line, match[2]);
  };

  const mapping = (indent: number): YamlMap => {
    const out: YamlMap = {};
    while (at < lines.length && lines[at].indent === indent && !(lines[at].text === "-" || lines[at].text.startsWith("- "))) {
      const line = lines[at++];
      entry(line, line.text, out);
    }
    if (at < lines.length && lines[at].indent > indent) refuse(lines[at], "unexpected indent");
    return out;
  };

  const sequence = (indent: number): Yaml[] => {
    const out: Yaml[] = [];
    while (at < lines.length && lines[at].indent === indent && (lines[at].text === "-" || lines[at].text.startsWith("- "))) {
      const line = lines[at++];
      const rest = line.text.slice(1).trimStart();
      if (rest === "") {
        out.push(child(line));
      } else if (KEY.test(rest) && !/^["']/.test(rest)) {
        const itemIndent = indent + line.text.length - rest.length;
        const item: YamlMap = {};
        entry({ ...line, indent: itemIndent }, rest, item);
        while (at < lines.length && lines[at].indent === itemIndent && !lines[at].text.startsWith("- ")) {
          const more = lines[at++];
          entry(more, more.text, item);
        }
        out.push(item);
      } else {
        out.push(value(line, rest));
      }
    }
    if (at < lines.length && lines[at].indent > indent) refuse(lines[at], "unexpected indent");
    return out;
  };

  try {
    if (lines.length === 0) return { ok: true, value: {} };
    const root = block(lines[0].indent);
    if (at < lines.length) refuse(lines[at], "unexpected dedent");
    return { ok: true, value: root };
  } catch (error) {
    if (error instanceof YamlRefusal) return { ok: false, reason: error.message };
    throw error;
  }
}

export const isMap = (v: Yaml | undefined): v is YamlMap => typeof v === "object" && !Array.isArray(v);

export const REQUIRED_MODEL_ROLES = ["default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor", "web"] as const;

const THINKING: Record<string, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true, auto: true, inherit: true };

export type ModelProviders = { gateway: ReadonlySet<string>; keyless: ReadonlySet<string>; gatewayUrl: string };

export function modelProviders(models: Yaml): Checked<ModelProviders> {
  const providers = isMap(models) ? models.providers : undefined;
  if (!isMap(providers)) return { ok: false, reason: "models.yml has no providers mapping" };
  const gateway = new Set<string>();
  const keyless = new Set<string>();
  const urls = new Set<string>();
  for (const [name, entry] of Object.entries(providers)) {
    if (!isMap(entry)) return { ok: false, reason: `provider ${name} is not a mapping` };
    if (entry.transport === "pi-native") {
      if (typeof entry.baseUrl !== "string" || entry.baseUrl === "") return { ok: false, reason: `gateway provider ${name} has no baseUrl` };
      if (typeof entry.apiKey !== "string" || entry.apiKey === "") return { ok: false, reason: `gateway provider ${name} has no apiKey` };
      urls.add(entry.baseUrl.replace(/\/+$/, ""));
      gateway.add(name);
    } else if (entry.auth === "none" && entry.apiKey === undefined && entry.transport === undefined) {
      keyless.add(name);
    } else {
      return { ok: false, reason: `provider ${name} must be a gateway provider (transport: pi-native) or keyless (auth: none, no apiKey)` };
    }
  }
  if (urls.size !== 1) return { ok: false, reason: `models.yml must have gateway providers with one baseUrl, found ${urls.size}` };
  return { ok: true, value: { gateway, keyless, gatewayUrl: [...urls][0] } };
}

export type Selection = { where: string; selector: string };

const selectorsOf = (where: string, v: Yaml | undefined): Selection[] => {
  if (v === undefined) return [];
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((selector) => ({ where, selector }));
  }
  if (Array.isArray(v)) return v.flatMap((item, i) => selectorsOf(`${where}[${i}]`, item));
  return [{ where, selector: "<mapping>" }];
};

const entriesOf = (where: string, v: Yaml | undefined): Selection[] =>
  isMap(v) ? Object.entries(v).flatMap(([key, item]) => selectorsOf(`${where}.${key}`, item)) : selectorsOf(where, v);

const AUXILIARY_CONTROLS: Record<string, true> = { true: true, false: true, on: true, off: true, default: true };

export type AgentFile = { name: string; text: string };

export function frontmatter(text: string): Checked<YamlMap> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return { ok: true, value: {} };
  const parsed = parseYaml(match[1]);
  if (!parsed.ok) return parsed;
  return isMap(parsed.value) ? { ok: true, value: parsed.value } : { ok: false, reason: "frontmatter is not a mapping" };
}

export function modelSelections(policy: Yaml, agents: readonly AgentFile[]): Checked<Selection[]> {
  if (!isMap(policy)) return { ok: false, reason: "policy.yml is not a mapping" };
  const out: Selection[] = [...entriesOf("modelRoles", policy.modelRoles)];
  const retry = policy.retry;
  if (isMap(retry)) out.push(...entriesOf("retry.fallbackChains", retry.fallbackChains));
  const task = policy.task;
  if (isMap(task)) {
    out.push(...entriesOf("task.agentModelOverrides", task.agentModelOverrides));
    for (const key of ["agentAdvisor", "agentPrewalk"]) {
      out.push(...entriesOf(`task.${key}`, task[key]).filter(({ selector }) => !Object.hasOwn(AUXILIARY_CONTROLS, selector.toLowerCase())));
    }
  }
  const presets = policy.modelPresets;
  if (isMap(presets)) {
    for (const [name, preset] of Object.entries(presets)) {
      if (isMap(preset)) out.push(...entriesOf(`modelPresets.${name}.modelRoles`, preset.modelRoles));
    }
  }
  for (const agent of agents) {
    const fm = frontmatter(agent.text);
    if (!fm.ok) return { ok: false, reason: `agents/${agent.name}: ${fm.reason}` };
    out.push(...selectorsOf(`agents/${agent.name} model`, fm.value.model));
    for (const key of ["advisor", "prewalk"]) {
      out.push(...selectorsOf(`agents/${agent.name} ${key}`, fm.value[key]).filter(({ selector }) => !Object.hasOwn(AUXILIARY_CONTROLS, selector.toLowerCase())));
    }
  }
  return { ok: true, value: out };
}

const withoutThinking = (selector: string): string => {
  const cut = selector.lastIndexOf(":");
  return cut > 0 && Object.hasOwn(THINKING, selector.slice(cut + 1)) ? selector.slice(0, cut) : selector;
};

export function roleModelsRefusal(policy: Yaml, models: Yaml, agents: readonly AgentFile[]): string | undefined {
  const providers = modelProviders(models);
  if (!providers.ok) return providers.reason;
  const selections = modelSelections(policy, agents);
  if (!selections.ok) return selections.reason;
  const roles = isMap(policy) && isMap(policy.modelRoles) ? policy.modelRoles : {};
  const missing = REQUIRED_MODEL_ROLES.filter((role) => roles[role] === undefined);
  if (missing.length > 0) return `policy.yml must set modelRoles ${missing.join(", ")}`;
  for (const { where, selector } of selections.value) {
    if (selector === "*") continue;
    if (selector.startsWith("@")) {
      const target = withoutThinking(selector.slice(1));
      if (roles[target] === undefined) return `${where}: ${selector} names a role that modelRoles does not set`;
      continue;
    }
    const slash = withoutThinking(selector).indexOf("/");
    const provider = slash > 0 ? selector.slice(0, slash) : "";
    if (!providers.value.gateway.has(provider) && !providers.value.keyless.has(provider)) {
      return `${where}: ${selector} is not a model of a gateway provider or a keyless provider in models.yml; write it as <provider>/<model>`;
    }
  }
  return undefined;
}

export type Addresses = { gateway: string; engine: string };

const IP_PORT = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/;

function isIpPort(value: string): boolean {
  const match = IP_PORT.exec(value);
  if (match === null) return false;
  const [a, b, c, d, port] = match.slice(1).map(Number);
  return [a, b, c, d].every((octet) => octet <= 255) && port >= 1 && port <= 65535;
}

export function parseAddresses(text: string): Checked<Addresses> {
  const found: Partial<Addresses> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq < 0 ? line : line.slice(0, eq);
    if (key !== "gateway" && key !== "engine") return { ok: false, reason: `unknown line ${line}; want gateway=<ip>:<port> and engine=<ip>:<port>` };
    if (found[key] !== undefined) return { ok: false, reason: `${key}= is given twice` };
    const value = line.slice(eq + 1);
    if (!isIpPort(value)) return { ok: false, reason: `${line} is not <ip>:<port>` };
    found[key] = value;
  }
  if (found.gateway === undefined) return { ok: false, reason: "no gateway= line" };
  if (found.engine === undefined) return { ok: false, reason: "no engine= line" };
  return { ok: true, value: { gateway: found.gateway, engine: found.engine } };
}

export function renderModels(template: string, addresses: Addresses, token: string): Checked<string> {
  const out = template.replaceAll("@GATEWAY@", addresses.gateway).replaceAll("@ENGINE@", addresses.engine).replaceAll("@GATEWAY_TOKEN@", token);
  const left = /@[A-Z_]+@/.exec(out);
  if (left !== null) return { ok: false, reason: `unknown placeholder ${left[0]}` };
  return { ok: true, value: out };
}
