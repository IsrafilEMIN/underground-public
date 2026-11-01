import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { REQUIRED_MODEL_ROLES } from "../../host/broker/gateway.ts";
import { tempDir } from "../temp.ts";

const SRC = join(import.meta.dirname, "../..");
const pin = /^omp=(.+)$/m.exec(await readFile(join(SRC, "VERSIONS"), "utf8"))?.[1] ?? "";
const OMP = join(homedir(), "Library/Application Support/Tern/omp/versions", pin);
const skip = existsSync(OMP) ? false : `needs the pinned omp ${pin} at ${OMP}`;
const GATEWAY_PROVIDERS = ["anthropic", "openai-codex", "opencode-go", "openai"];

async function freePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

type Service = { child: ChildProcess; log: () => string };

function start(args: string[], env: NodeJS.ProcessEnv): Service {
  const child = spawn(OMP, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  return { child, log: () => out };
}

async function waitHealthy(url: string, service: Service): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (service.child.exitCode !== null) throw new Error(`exited ${service.child.exitCode}: ${service.log()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error(`not healthy: ${url}: ${service.log()}`);
}

async function put(home: string, rel: string, text: string): Promise<void> {
  await mkdir(dirname(join(home, rel)), { recursive: true });
  await writeFile(join(home, rel), text);
}

test("a reviewer can access the full gateway catalog and usage, but not provider credentials", { skip, timeout: 120_000 }, async (t) => {
  const home = await tempDir(join(tmpdir(), "uga-"));
  for (const file of ["admin.ts", "client.ts", "protocol.ts", "gateway.ts", "owner-files.ts"]) {
    await put(home, `.agents/broker/${file}`, await readFile(join(SRC, "host/broker", file), "utf8"));
  }
  await put(home, ".agents/sandbox/render-settings.ts", await readFile(join(SRC, "host/sandbox/render-settings.ts"), "utf8"));
  const policyTemplate = await readFile(join(SRC, "host/roles/policy.yml"), "utf8");
  await put(home, ".agents/roles/policy.yml", policyTemplate);
  await put(home, ".agents/roles/models.yml", await readFile(join(SRC, "host/roles/models.yml"), "utf8"));
  await put(home, ".config/underground-broker/roles", "author author\ncode-review code-review\nsecurity-review security-review\nrisk-review risk-review\n");
  const haikuRoles = REQUIRED_MODEL_ROLES.map((r) => `  ${r}: anthropic/claude-haiku-5-5`).join("\n");
  const haikuPolicy = policyTemplate.replace(/^modelRoles:\n(?: {2}.*\n)+/m, `modelRoles:\n${haikuRoles}\n`).replace(/^retry:\n(?: {2}.*\n)+/m, "");


  const brokerPort = await freePort();
  const gatewayPort = await freePort();
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  await put(home, ".config/underground-broker/addresses", `gateway=127.0.0.1:${gatewayPort}\nengine=127.0.0.1:8081\n`);
  const setup = spawnSync(process.execPath, [join(home, ".agents/broker/admin.ts"), "gateway-setup"], { env: { HOME: home }, encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);
  await put(home, ".ug/omp/agent/policy.yml", haikuPolicy);

  const env = { HOME: home, PATH: "/usr/bin:/bin", PI_NATIVES_DIR: join(homedir(), ".omp/natives") };
  const broker = start(["auth-broker", "serve", `--bind=127.0.0.1:${brokerPort}`], env);
  t.after(() => broker.child.kill());
  await waitHealthy(`http://127.0.0.1:${brokerPort}/v1/healthz`, broker);
  const brokerToken = (await readFile(join(home, ".omp/auth-broker.token"), "utf8")).trim();
  for (const provider of GATEWAY_PROVIDERS) {
    const res = await fetch(`http://127.0.0.1:${brokerPort}/v1/credential`, {
      method: "POST",
      headers: { authorization: `Bearer ${brokerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ provider, credential: { type: "api_key", key: `fake-${provider}` } }),
    });
    assert.equal(res.status, 200, await res.text());
  }

  const gateway = start(["auth-gateway", "serve", `--bind=127.0.0.1:${gatewayPort}`], {
    ...env,
    OMP_AUTH_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
  });
  t.after(() => gateway.child.kill());
  await waitHealthy(`${gatewayUrl}/healthz`, gateway);

  const roleModels = await readFile(join(home, ".ug/omp/agent/models.yml"), "utf8");
  const match = /^\s+apiKey: "([^"]+)"$/m.exec(roleModels);
  assert.ok(match, "the reviewer has a gateway bearer");
  const reviewer = match[1];
  const call = async (token: string | undefined, modelId: string): Promise<number> => {
    const res = await fetch(`${gatewayUrl}/v1/pi/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ modelId, context: { messages: [] }, stream: false }),
    });
    await res.body?.cancel();
    return res.status;
  };
  const listed = async (token: string): Promise<string[]> => {
    const res = await fetch(`${gatewayUrl}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body: { data: { id: string }[] } = await res.json();
    return body.data.map((m) => m.id).sort();
  };

  assert.equal(await call(undefined, "anthropic/claude-haiku-5-5"), 401);
  assert.equal(await call("not-a-client-token", "anthropic/claude-haiku-5-5"), 401);
  assert.equal(await readFile(join(home, ".ug/omp/agent/policy.yml"), "utf8"), haikuPolicy, "the policy is haiku-only");
  const models = await listed(reviewer);
  assert.ok(models.includes("anthropic/claude-opus-5-5"), "a haiku-only policy does not restrict gateway access");
  assert.ok(models.includes("openai/gpt-4.1-mini"), "gateway access includes providers outside the role's selected models");
  const usage = await fetch(`${gatewayUrl}/v1/usage`, { headers: { authorization: `Bearer ${reviewer}` } });
  assert.equal(usage.status, 200);
  for (const [method, route] of [["GET", "/v1/snapshot"], ["POST", "/v1/credential"]]) {
    const response = await fetch(`${gatewayUrl}${route}`, { method, headers: { authorization: `Bearer ${reviewer}` } });
    assert.equal(response.status, 404, "gateway access does not expose auth-broker credential APIs");
  }
});
