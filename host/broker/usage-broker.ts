import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAddresses } from "./gateway.ts";

export const USAGE_BROKER_HOST = "127.0.0.1";
export const USAGE_BROKER_PORT = 18765;
const GENERATION = 1;
const ETAG = `"${GENERATION}"`;
const MAX_WAIT_MS = 60_000;

export type UsageBrokerConfig = {
  addressesFile: string;
  gatewayTokenFile: string;
  fetchImpl: typeof fetch;
};

export type UsageRequest = { method: string; url: string; ifNoneMatch: string | undefined };
export type UsageReply = { status: number; etag?: string; body?: string };

export function defaultConfig(): UsageBrokerConfig {
  return {
    addressesFile: join(homedir(), ".config/underground-broker/addresses"),
    gatewayTokenFile: join(homedir(), ".ug/host/auth/auth-gateway.token"),
    fetchImpl: fetch,
  };
}

function json(status: number, value: unknown): UsageReply {
  return { status, body: JSON.stringify(value) };
}

async function gatewayUsage(config: UsageBrokerConfig): Promise<UsageReply> {
  const addresses = parseAddresses(await readFile(config.addressesFile, "utf8"));
  if (!addresses.ok) return json(502, { error: `addresses file: ${addresses.reason}` });
  const token = (await readFile(config.gatewayTokenFile, "utf8")).trim();
  // A token with a space or control character is not a valid header value, and fetch quotes the
  // whole value in its error, which reaches the 502 body.
  if (!/^[\x21-\x7e]+$/.test(token)) return json(502, { error: "gateway token file does not hold one printable token" });
  const reply = await config.fetchImpl(`http://${addresses.value.gateway}/v1/usage`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: reply.status, body: await reply.text() };
}

export async function respond(config: UsageBrokerConfig, req: UsageRequest, now: () => number = Date.now): Promise<UsageReply> {
  const url = new URL(req.url, "http://usage-broker");
  if (req.method === "GET" && url.pathname === "/v1/healthz") return json(200, { ok: true });
  if (req.method === "GET" && url.pathname === "/v1/snapshot") {
    if (req.ifNoneMatch === ETAG) {
      const wait = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), MAX_WAIT_MS);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, wait);
      await promise;
      return { status: 304, etag: ETAG };
    }
    const at = now();
    return {
      ...json(200, {
        generation: GENERATION,
        generatedAt: at,
        serverNowMs: at,
        refresher: { enabled: false, intervalMs: 60_000, skewMs: 0, nextSweepInMs: 60_000 },
        credentials: [],
      }),
      etag: ETAG,
    };
  }
  if (req.method === "GET" && url.pathname === "/v1/usage") {
    try {
      return await gatewayUsage(config);
    } catch (error) {
      return json(502, { error: `gateway usage failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (req.method === "POST" && url.pathname === "/v1/usage/observed") return { status: 204 };
  return json(404, { error: "the usage broker serves usage only" });
}

export function createUsageBroker(config: UsageBrokerConfig): Server {
  return createServer(async (req, res) => {
    req.resume();
    const header = req.headers["if-none-match"];
    const reply = await respond(config, { method: req.method ?? "GET", url: req.url ?? "/", ifNoneMatch: Array.isArray(header) ? header[0] : header });
    res.statusCode = reply.status;
    if (reply.etag !== undefined) res.setHeader("etag", reply.etag);
    if (reply.body !== undefined) res.setHeader("content-type", "application/json");
    res.end(reply.body);
  });
}

if (import.meta.main) {
  createUsageBroker(defaultConfig()).listen(USAGE_BROKER_PORT, USAGE_BROKER_HOST, () => {
    process.stdout.write(`usage-broker: listening on ${USAGE_BROKER_HOST}:${USAGE_BROKER_PORT}\n`);
  });
}
