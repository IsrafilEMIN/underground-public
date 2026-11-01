import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { frontmatter, isMap, modelProviders, parseAddresses, parseYaml, renderModels, roleModelsRefusal } from "../../host/broker/gateway.ts";
import type { AgentFile, Yaml } from "../../host/broker/gateway.ts";
import { tempDir } from "../temp.ts";

const SRC = join(import.meta.dirname, "../..");
const ADDRESSES = { gateway: "100.64.0.1:4000", engine: "100.64.0.2:8081" };
const GATEWAY_URL = `http://${ADDRESSES.gateway}`;

const yaml = (text: string): Yaml => {
  const parsed = parseYaml(text);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return parsed.value;
};

async function templates(): Promise<{ policy: Yaml; models: Yaml; policyText: string }> {
  const policyText = await readFile(join(SRC, "host/roles/policy.yml"), "utf8");
  const rendered = renderModels(await readFile(join(SRC, "host/roles/models.yml"), "utf8"), ADDRESSES, "t0ken");
  assert.ok(rendered.ok);
  return { policy: yaml(policyText), models: yaml(rendered.value), policyText };
}

const withTask = (policyText: string, body: string): string => policyText.replace(/^task:\n/m, `task:\n${body}`);

test("parseAddresses reads the gateway and the engine address, and refuses anything else", () => {
  assert.deepEqual(parseAddresses("# owner\ngateway=100.64.0.1:4000\n\nengine=100.64.0.2:8081\n"), { ok: true, value: ADDRESSES });
  const bad: [string, RegExp][] = [
    ["", /no gateway= line/],
    ["gateway=100.64.0.1:4000\n", /no engine= line/],
    ["gateway=100.64.0.1:4000\nengine=100.64.0.2:8081\ngateway=100.64.0.3:4000\n", /gateway= is given twice/],
    ["gateway=100.64.0.1\nengine=100.64.0.2:8081\n", /gateway=100\.64\.0\.1 is not <ip>:<port>/],
    ["gateway=100.64.0.1:4000\nengine=v100-server:8081\n", /engine=v100-server:8081 is not <ip>:<port>/],
    ["gateway=100.64.0.1:4000\nengine=100.64.0.256:8081\n", /is not <ip>:<port>/],
    ["gateway=100.64.0.1:0\nengine=100.64.0.2:8081\n", /is not <ip>:<port>/],
    ["gateway=100.64.0.1:4000\nengine=100.64.0.2:65536\n", /is not <ip>:<port>/],
    ["gateway=100.64.0.1:4000\nengine=100.64.0.2:8081\nproxy=1.2.3.4:5\n", /unknown line proxy=1\.2\.3\.4:5/],
  ];
  for (const [text, reason] of bad) {
    const parsed = parseAddresses(text);
    assert.equal(parsed.ok, false, text);
    if (!parsed.ok) assert.match(parsed.reason, reason, text);
  }
});

test("parseYaml reads block mappings, block and flow lists, quotes, and comments", () => {
  assert.deepEqual(yaml('a:\n  b: "@x" # note\n  c:\n    - one\n    - two:three\n  d: [x, y]\nlist:\n- k: v\n  w: z\n'), {
    a: { b: "@x", c: ["one", "two:three"], d: ["x", "y"] },
    list: [{ k: "v", w: "z" }],
  });
  for (const bad of ["a: {b: c}\n", "a: &anchor x\n", "a: !cmd\n", "a: b\na: c\n", "a:\n\tb: c\n", "a: |\n  x\n"]) {
    assert.equal(parseYaml(bad).ok, false, bad);
  }
});

test("a model setting outside the gateway providers and the inference engine is refused, wherever it is", async () => {
  const { policyText, models } = await templates();
  const cases: [string, AgentFile[], RegExp][] = [
    [policyText.replace("web: openai-codex/gpt-6-luna:high", "web: web/perplexity"), [], /modelRoles\.web: web\/perplexity/],
    [policyText.replace("  default: anthropic/claude-opus-5-5:medium", "  default: claude-opus-5-5"), [], /modelRoles\.default: claude-opus-5-5/],
    [policyText.replace("    web:\n      - openai-codex/gpt-6.1-sol:medium", "    web:\n      - web/duckduckgo"), [], /retry\.fallbackChains\.web\[0\]: web\/duckduckgo/],
    [withTask(policyText, "  agentModelOverrides:\n    scout: openrouter/x\n"), [], /task\.agentModelOverrides\.scout: openrouter\/x/],
    [`${policyText}modelPresets:\n  deep:\n    modelRoles:\n      default: anthropic-direct/x\n`, [], /modelPresets\.deep\.modelRoles\.default/],
    [policyText, [{ name: "scout.md", text: "---\nname: scout\nmodel: google/gemini-x, anthropic/claude-haiku-5-5\n---\nbody\n" }], /agents\/scout\.md model: google\/gemini-x/],
    [policyText.replace('  plan: "@slow"\n', ""), [], /policy\.yml must set modelRoles plan/],
    [policyText.replace('  commit: "@smol"', '  commit: "@reviewer"'), [], /@reviewer names a role that modelRoles does not set/],
  ];
  for (const [text, agents, reason] of cases) {
    assert.match(roleModelsRefusal(yaml(text), models, agents) ?? "accepted", reason);
  }
  assert.equal(roleModelsRefusal(yaml(policyText), models, [{ name: "ok.md", text: "---\nmodel: [\"@smol\", lm-studio/qwen3.8-flash-next-ud-q4_k_xl]\n---\n" }]), undefined);
});

test("models.yml may hold only gateway providers on one baseUrl and keyless providers", async () => {
  const { policy } = await templates();
  const gw = (url: string) => `    transport: pi-native\n    baseUrl: ${url}\n    apiKey: t\n`;
  const cases: [string, RegExp][] = [
    [`providers:\n  anthropic:\n${gw(GATEWAY_URL)}  openai:\n    apiKey: sk-real\n`, /provider openai must be a gateway provider/],
    [`providers:\n  anthropic:\n${gw(GATEWAY_URL)}  ollama:\n    auth: none\n    apiKey: x\n`, /provider ollama must be/],
    [`providers:\n  anthropic:\n${gw(GATEWAY_URL)}  openai-codex:\n${gw("http://evil:4000")}`, /one baseUrl, found 2/],
    [`providers:\n  anthropic:\n    transport: pi-native\n    baseUrl: ${GATEWAY_URL}\n`, /anthropic has no apiKey/],
    ["providers: {}\n", /one baseUrl, found 0/],
  ];
  for (const [text, reason] of cases) {
    assert.match(roleModelsRefusal(policy, yaml(text), []) ?? "accepted", reason);
  }
});

test("auxiliary advisor and prewalk selectors accept gateway models and on/off controls", async () => {
  const { policyText, models } = await templates();
  const settings = withTask(policyText, '  agentAdvisor:\n    scout: anthropic/claude-sonnet-aux-1:high\n    task: "on"\n    sonic: "off"\n  agentPrewalk:\n    scout: "openai-codex/gpt-aux-2"\n    task: "off"\n');
  const agents: AgentFile[] = [
    { name: "a.md", text: "---\nname: a\nadvisor: opencode-go/aux-3\nprewalk: true\n---\n" },
    { name: "b.md", text: "---\nname: b\nadvisor: true\nprewalk: \"@smol\"\n---\n" },
    { name: "c.md", text: "---\nname: c\nadvisor: false\nprewalk: anthropic/claude-aux-4\n---\n" },
  ];
  assert.equal(roleModelsRefusal(yaml(settings), models, agents), undefined);
});

test("an auxiliary advisor or prewalk selector outside the gateway is refused", async () => {
  const { policyText, models } = await templates();
  const cases: [string, AgentFile[], RegExp][] = [
    [withTask(policyText, "  agentAdvisor:\n    scout: openrouter/x\n"), [], /task\.agentAdvisor\.scout: openrouter\/x/],
    [withTask(policyText, "  agentPrewalk:\n    task: web/perplexity\n"), [], /task\.agentPrewalk\.task: web\/perplexity/],
    [policyText, [{ name: "a.md", text: "---\nname: a\nadvisor: google/gemini-x:high\n---\n" }], /agents\/a\.md advisor: google\/gemini-x:high/],
    [policyText, [{ name: "b.md", text: "---\nname: b\nprewalk: \"@reviewer\"\n---\n" }], /agents\/b\.md prewalk: @reviewer names a role/],
  ];
  for (const [text, agents, reason] of cases) {
    assert.match(roleModelsRefusal(yaml(text), models, agents) ?? "accepted", reason);
  }
});

const refusal = (text: string): string => {
  const parsed = parseYaml(text);
  assert.equal(parsed.ok, false, `accepted: ${JSON.stringify(text)}`);
  return parsed.ok ? "" : parsed.reason;
};

test("parseYaml starts a comment only at a # after whitespace and outside quotes", () => {
  assert.deepEqual(yaml("a: x#y\nb: \"x #y\" # note\nc: 'p #q'\n"), { a: "x#y", b: "x #y", c: "p #q" });
});

test("parseYaml unescapes \\\" and \\\\ in double quotes and '' in single quotes", () => {
  assert.deepEqual(yaml('a: "say \\"hi\\" \\\\ ok"\nb: \'it\'\'s\'\n'), { a: 'say "hi" \\ ok', b: "it's" });
});

test("parseYaml refuses an unclosed quote", () => {
  assert.match(refusal('a: b\nc: "open\n'), /^line 2: unclosed quote/);
  assert.match(refusal("a: 'open\n"), /^line 1: unclosed quote/);
});

test("parseYaml reads [] as an empty list and {} as an empty map", () => {
  assert.deepEqual(yaml("a: []\nb: {}\n"), { a: [], b: {} });
});

test("parseYaml refuses a nested or unterminated flow list", () => {
  assert.match(refusal("a: [x, [y]]\n"), /^line 1: write the list in block style/);
  assert.match(refusal("a: [x, {y: z}]\n"), /^line 1: write the list in block style/);
  assert.match(refusal("a: b\nc: [x, y\n"), /^line 2: write the list in block style/);
});

test("parseYaml skips a --- line and reads an empty or comment-only document as an empty map", () => {
  assert.deepEqual(yaml("---\na: b\n"), { a: "b" });
  assert.deepEqual(yaml(""), {});
  assert.deepEqual(yaml("# only a comment\n\n"), {});
});

test("parseYaml reads a key with no value and no block as an empty string", () => {
  assert.deepEqual(yaml("a:\nb: c\n"), { a: "", b: "c" });
});

test("parseYaml refuses a line that is not key: value", () => {
  assert.match(refusal("a: b\njust text\n"), /^line 2: expected "key: value"/);
});

test("parseYaml refuses an unexpected indent in a mapping or a list, and a dedent below the first line", () => {
  assert.match(refusal("a: b\n  c: d\n"), /^line 2: unexpected indent/);
  assert.match(refusal("- x\n  - y\n"), /^line 2: unexpected indent/);
  assert.match(refusal("  a: b\nc: d\n"), /^line 2: unexpected dedent/);
});

test("parseYaml gives a bare - item the block under it", () => {
  assert.deepEqual(yaml("a:\n  -\n    k: v\n    w: z\n  - x\n"), { a: [{ k: "v", w: "z" }, "x"] });
});

test("parseYaml keeps a quoted list item with a colon as a scalar", () => {
  assert.deepEqual(yaml('- "a\\": b"\n- \'k: v\'\n'), ['a": b', "k: v"]);
});

test("models.yml without a providers mapping, or with a provider that is not a mapping, is refused", async () => {
  const { policy } = await templates();
  const cases: [string, RegExp][] = [
    ["other: x\n", /^models\.yml has no providers mapping$/],
    ["providers: x\n", /^models\.yml has no providers mapping$/],
    [`providers:\n  anthropic:\n    transport: pi-native\n    baseUrl: ${GATEWAY_URL}\n    apiKey: t\n  openai: x\n`, /^provider openai is not a mapping$/],
  ];
  for (const [text, reason] of cases) {
    assert.match(roleModelsRefusal(policy, yaml(text), []) ?? "accepted", reason, text);
  }
});

test("a gateway provider without a baseUrl is refused", async () => {
  const { policy } = await templates();
  for (const text of ["providers:\n  anthropic:\n    transport: pi-native\n    apiKey: t\n", 'providers:\n  anthropic:\n    transport: pi-native\n    baseUrl: ""\n    apiKey: t\n']) {
    assert.match(roleModelsRefusal(policy, yaml(text), []) ?? "accepted", /^gateway provider anthropic has no baseUrl$/, text);
  }
});

test("a trailing / on a gateway baseUrl names the same gateway", async () => {
  const { policy } = await templates();
  const rendered = renderModels(await readFile(join(SRC, "host/roles/models.yml"), "utf8"), ADDRESSES, "t0ken");
  assert.ok(rendered.ok);
  const slashed = rendered.value.replace(`baseUrl: "${GATEWAY_URL}"`, `baseUrl: "${GATEWAY_URL}/"`);
  assert.notEqual(slashed, rendered.value);
  const models = yaml(slashed);
  assert.equal(roleModelsRefusal(policy, models, []), undefined);
  const providers = modelProviders(models);
  assert.ok(providers.ok);
  assert.equal(providers.value.gatewayUrl, GATEWAY_URL);
});

test("a provider with auth: none and a transport of its own is refused", async () => {
  const { policy } = await templates();
  const text = `providers:\n  anthropic:\n    transport: pi-native\n    baseUrl: ${GATEWAY_URL}\n    apiKey: t\n  ollama:\n    auth: none\n    transport: openai\n`;
  assert.match(roleModelsRefusal(policy, yaml(text), []) ?? "accepted", /^provider ollama must be a gateway provider/);
});

test("every item of a comma-separated selector is checked, not only the first", async () => {
  const { policyText, models } = await templates();
  const agents: AgentFile[] = [{ name: "s.md", text: "---\nmodel: anthropic/claude-haiku-5-5, google/gemini-x\n---\n" }];
  assert.match(roleModelsRefusal(yaml(policyText), models, agents) ?? "accepted", /^agents\/s\.md model: google\/gemini-x is not a model/);
  const policy = policyText.replace("  default: anthropic/claude-opus-5-5:medium", "  default: anthropic/claude-opus-5-5:medium, openrouter/x");
  assert.match(roleModelsRefusal(yaml(policy), models, []) ?? "accepted", /^modelRoles\.default: openrouter\/x is not a model/);
});

test("a mapping where a model selector belongs is refused", async () => {
  const { policyText, models } = await templates();
  const policy = policyText.replace("  default: anthropic/claude-opus-5-5:medium", "  default:\n    id: anthropic/claude-opus-5-5");
  assert.match(roleModelsRefusal(yaml(policy), models, []) ?? "accepted", /^modelRoles\.default: <mapping> is not a model/);
  const agents: AgentFile[] = [{ name: "m.md", text: "---\nmodel:\n  id: anthropic/claude-haiku-5-5\n---\n" }];
  assert.match(roleModelsRefusal(yaml(policyText), models, agents) ?? "accepted", /^agents\/m\.md model: <mapping> is not a model/);
});

test("a policy.yml that is not a mapping is refused as such", async () => {
  const { models } = await templates();
  assert.equal(roleModelsRefusal(yaml("- default\n- smol\n"), models, []), "policy.yml is not a mapping");
});

test("an agent file whose frontmatter does not parse, or is not a mapping, is refused with its name", async () => {
  const { policyText, models } = await templates();
  const policy = yaml(policyText);
  const cases: [AgentFile, RegExp][] = [
    [{ name: "bad.md", text: "---\nname: bad\nmodel: [x\n---\nbody\n" }, /^agents\/bad\.md: line 2: write the list in block style/],
    [{ name: "list.md", text: "---\n- openrouter/x\n---\nbody\n" }, /^agents\/list\.md: frontmatter is not a mapping$/],
  ];
  for (const [agent, reason] of cases) {
    assert.match(roleModelsRefusal(policy, models, [agent]) ?? "accepted", reason, agent.name);
  }
});

test("an agent file without frontmatter selects no model", async () => {
  assert.deepEqual(frontmatter("model: openrouter/x\n"), { ok: true, value: {} });
  const { policyText, models } = await templates();
  assert.equal(roleModelsRefusal(yaml(policyText), models, [{ name: "plain.md", text: "model: openrouter/x\n" }]), undefined);
});

test("@role:level names the role, and an unknown level is part of the name", async () => {
  const { policyText, models } = await templates();
  const with_ = (selector: string) => yaml(policyText.replace('  commit: "@smol"', `  commit: "${selector}"`));
  assert.equal(roleModelsRefusal(with_("@smol:low"), models, []), undefined);
  assert.match(roleModelsRefusal(with_("@reviewer:high"), models, []) ?? "accepted", /^modelRoles\.commit: @reviewer:high names a role that modelRoles does not set$/);
  assert.match(roleModelsRefusal(with_("@smol:fast"), models, []) ?? "accepted", /^modelRoles\.commit: @smol:fast names a role that modelRoles does not set$/);
});

test("a * selector is accepted", async () => {
  const { policyText, models } = await templates();
  assert.equal(roleModelsRefusal(yaml(policyText), models, [{ name: "any.md", text: '---\nmodel: "*"\n---\n' }]), undefined);
});

test("renderModels fills the gateway, the engine and the bearer, and refuses any other placeholder", () => {
  assert.deepEqual(renderModels("g=@GATEWAY@ e=@ENGINE@ k=@GATEWAY_TOKEN@", ADDRESSES, "t0ken"), {
    ok: true,
    value: "g=100.64.0.1:4000 e=100.64.0.2:8081 k=t0ken",
  });
  assert.deepEqual(renderModels("baseUrl: http://@GATEWAY@\nproxy: @PROXY_HOST@\n", ADDRESSES, "t0ken"), { ok: false, reason: "unknown placeholder @PROXY_HOST@" });
});

async function put(home: string, rel: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(join(home, rel)), { recursive: true });
  await writeFile(join(home, rel), text, { mode });
}

async function setupHome(roles: string): Promise<string> {
  const home = await tempDir(join(tmpdir(), "ugg-"));
  for (const file of ["admin.ts", "client.ts", "protocol.ts", "gateway.ts", "owner-files.ts"]) {
    await put(home, `.agents/broker/${file}`, await readFile(join(SRC, "host/broker", file), "utf8"));
  }
  await put(home, ".agents/sandbox/render-settings.ts", await readFile(join(SRC, "host/sandbox/render-settings.ts"), "utf8"));
  for (const file of ["policy.yml", "models.yml"]) {
    await put(home, `.agents/roles/${file}`, await readFile(join(SRC, "host/roles", file), "utf8"));
  }
  await put(home, ".config/underground-broker/roles", roles, 0o600);
  await put(home, ".config/underground-broker/addresses", `gateway=${ADDRESSES.gateway}\nengine=${ADDRESSES.engine}\n`, 0o600);
  return home;
}

const setup = (home: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(home, ".agents/broker/admin.ts"), "gateway-setup", ...args], { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" });

test("gateway-setup creates a private gateway bearer and preserves it across repeated setup", async () => {
  const roles = ["author", "code-review", "security-review", "risk-review"];
  const home = await setupHome(roles.map((name) => `${name} ${name}\n`).join(""));
  const first = setup(home);
  assert.equal(first.status, 0, first.stderr);
  const tokenPath = join(home, ".omp/auth-gateway.token");
  const token = (await readFile(tokenPath, "utf8")).trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);

  const second = setup(home);
  assert.equal(second.status, 0, second.stderr);
  assert.equal((await readFile(tokenPath, "utf8")).trim(), token, "setup must not rotate the shared bearer");
});

test("gateway-setup preserves an existing gateway bearer byte-for-byte", async () => {
  const home = await setupHome("author author\nsecurity-review security-review\n");
  const token = "existing-host-gateway-bearer";
  await put(home, ".omp/auth-gateway.token", `${token}\n`, 0o600);
  const run = setup(home);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await readFile(join(home, ".omp/auth-gateway.token"), "utf8"), `${token}\n`);
});

test("gateway-setup writes the installed policy.yml into the one omp root, and refuses one that selects a model outside the gateway or misses a pin", async () => {
  const home = await setupHome("author author\n");
  const template = await readFile(join(SRC, "host/roles/policy.yml"), "utf8");
  await put(home, ".ug/omp/agent/policy.yml", "stale: copy\n");
  await put(home, ".agents/roles/policy.yml", template.replace("web: openai-codex/gpt-6-luna:high", "web: web/perplexity"));
  const run = setup(home);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /modelRoles\.web: web\/perplexity is not a model of a gateway provider/);
  await put(home, ".agents/roles/policy.yml", template);
  await put(home, ".config/underground-broker/addresses", "gateway=100.64.0.1\n", 0o600);
  const malformed = setup(home);
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /addresses: gateway=100\.64\.0\.1 is not <ip>:<port>/);
  await put(home, ".config/underground-broker/addresses", `gateway=${ADDRESSES.gateway}\nengine=${ADDRESSES.engine}\n`, 0o600);
  await put(home, ".agents/roles/policy.yml", template.replace("shellPath: null\n", ""));
  const unpinned = setup(home);
  assert.equal(unpinned.status, 2);
  assert.match(unpinned.stderr, /\S+policy\.yml: it must pin shellPath; run ug-install to restore ~\/\.agents\/roles\/policy\.yml$/m);
  await put(home, ".agents/roles/policy.yml", template);
  assert.equal(setup(home).status, 0);
  assert.equal(await readFile(join(home, ".ug/omp/agent/policy.yml"), "utf8"), template);
});

test("gateway-setup writes the policy for every role, and the one models.yml points at the gateway with the bearer from the token file", async () => {
  const roles = ["author", "code-review", "security-review"];
  const home = await setupHome(roles.map((name) => `${name} ${name}\n`).join(""));
  const token = "existing-host-gateway-bearer";
  await put(home, ".omp/auth-gateway.token", `${token}\n`, 0o600);
  await put(home, ".ug/omp/agent/policy.yml", "stale: copy\n");
  await put(home, ".ug/omp/agent/models.yml", "stale: copy\n");
  const run = setup(home);
  assert.equal(run.status, 0, run.stderr);
  const template = await readFile(join(SRC, "host/roles/policy.yml"), "utf8");
  for (const role of roles) {
    const agentDir = join(home, ".ug/omp/agent");
    assert.equal(await readFile(join(agentDir, "policy.yml"), "utf8"), template, role);
    const models = yaml(await readFile(join(agentDir, "models.yml"), "utf8"));
    const providers = isMap(models) ? models.providers : undefined;
    assert.ok(isMap(providers), role);
    for (const name of ["anthropic", "openai-codex", "opencode-go", "lm-studio"]) {
      const provider = providers[name];
      assert.ok(isMap(provider), `${role} ${name}`);
      assert.equal(provider.baseUrl, GATEWAY_URL, `${role} ${name}`);
      assert.equal(provider.apiKey, token, `${role} ${name}`);
    }
  }
});
