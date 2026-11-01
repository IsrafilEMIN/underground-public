import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { USAGE_BROKER_PORT, createUsageBroker, respond } from "../../host/broker/usage-broker.ts";
import type { UsageBrokerConfig, UsageReply } from "../../host/broker/usage-broker.ts";
import { tempDir } from "../temp.ts";

type Call = { url: string; auth: string | null };

const TOKEN = "gateway-secret";
const okGateway = async (): Promise<Response> => new Response('[{"id":"r"}]', { status: 200 });

async function broker(
  addresses: string,
  gateway: typeof fetch = okGateway,
  token: string | null = `${TOKEN}\n`,
): Promise<{ call: (method: string, url: string, ifNoneMatch?: string) => Promise<UsageReply>; calls: Call[] }> {
  const dir = await tempDir(join(tmpdir(), "ugub-"));
  await writeFile(join(dir, "addresses"), addresses);
  if (token !== null) await writeFile(join(dir, "token"), token);
  const calls: Call[] = [];
  const config: UsageBrokerConfig = {
    addressesFile: join(dir, "addresses"),
    gatewayTokenFile: join(dir, "token"),
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return gateway(input, init);
    },
  };
  return { call: (method, url, ifNoneMatch) => respond(config, { method, url, ifNoneMatch }, () => 1000), calls };
}

const ADDRESSES = "gateway=100.64.0.1:4000\nengine=100.64.0.2:8081\n";

test("the snapshot has no credentials and only the keys that omp's broker client accepts", async () => {
  const reply = await (await broker(ADDRESSES)).call("GET", "/v1/snapshot");
  assert.equal(reply.status, 200);
  assert.equal(reply.etag, '"1"');
  assert.deepEqual(JSON.parse(reply.body ?? ""), {
    generation: 1,
    generatedAt: 1000,
    serverNowMs: 1000,
    refresher: { enabled: false, intervalMs: 60000, skewMs: 0, nextSweepInMs: 60000 },
    credentials: [],
  });
});

// One macrotask: every microtask queued by a timer that has fired runs before it.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("a long poll on the current generation waits for its wait time, at most a minute, then answers 304", async (t) => {
  const b = await broker(ADDRESSES);
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let short: UsageReply | undefined;
  void b.call("GET", "/v1/snapshot?wait=200", '"1"').then((r) => (short = r));
  mock.timers.tick(199);
  await flush();
  assert.equal(short, undefined, "the reply came before the wait");
  mock.timers.tick(1);
  await flush();
  assert.equal(short?.status, 304);
  assert.equal(short?.etag, '"1"', "a 304 names the generation it confirms");
  let huge: UsageReply | undefined;
  void b.call("GET", "/v1/snapshot?wait=999999999", '"1"').then((r) => (huge = r));
  mock.timers.tick(59_999);
  await flush();
  assert.equal(huge, undefined, "the reply came before a minute");
  mock.timers.tick(1);
  await flush();
  assert.equal(huge?.status, 304, "the wait is capped at a minute");
});

test("usage comes from the gateway in the addresses file, with the gateway token", async () => {
  const b = await broker(ADDRESSES);
  const reply = await b.call("GET", "/v1/usage");
  assert.equal(reply.status, 200);
  assert.equal(reply.body, '[{"id":"r"}]');
  assert.deepEqual(b.calls, [{ url: "http://100.64.0.1:4000/v1/usage", auth: "Bearer gateway-secret" }]);
});

test("a broken addresses file answers 502 and never sends or prints the token", async () => {
  const b = await broker("gateway=nowhere\n");
  const reply = await b.call("GET", "/v1/usage");
  assert.equal(reply.status, 502);
  assert.doesNotMatch(reply.body ?? "", /gateway-secret/);
  assert.deepEqual(b.calls, []);
});

test("observed usage is accepted, and the stream and every credential route answer 404", async () => {
  const b = await broker(ADDRESSES);
  assert.equal((await b.call("POST", "/v1/usage/observed")).status, 204);
  for (const [method, url] of [["GET", "/v1/snapshot/stream"], ["POST", "/v1/credential"], ["POST", "/v1/credential/1/refresh"], ["POST", "/v1/credential/1/disable"], ["GET", "/v1/usage/history"]]) {
    assert.equal((await b.call(method, url)).status, 404, `${method} ${url}`);
  }
  assert.deepEqual(b.calls, []);
});

test("the health check answers 200 and asks nothing of the gateway", async () => {
  const b = await broker(ADDRESSES);
  const reply = await b.call("GET", "/v1/healthz");
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body ?? ""), { ok: true });
  assert.deepEqual(b.calls, []);
});

test("a long poll with a negative, non-numeric or empty wait answers 304 at once", async (t) => {
  const b = await broker(ADDRESSES);
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  for (const wait of ["-5000", "soon", ""]) {
    let reply: UsageReply | undefined;
    void b.call("GET", `/v1/snapshot?wait=${wait}`, '"1"').then((r) => (reply = r));
    mock.timers.tick(0);
    await flush();
    assert.equal(reply?.status, 304, `wait=${wait}`);
  }
});

test("a long poll on another generation gets the snapshot at once, not a wait", async (t) => {
  const b = await broker(ADDRESSES);
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let reply: UsageReply | undefined;
  void b.call("GET", "/v1/snapshot?wait=1000", '"0"').then((r) => (reply = r));
  await flush();
  assert.equal(reply?.status, 200);
  assert.equal(reply?.etag, '"1"');
  assert.deepEqual(JSON.parse(reply?.body ?? "").credentials, []);
});

test("the snapshot and usage routes answer 404 to any method but GET, and never call the gateway", async () => {
  const b = await broker(ADDRESSES);
  for (const method of ["POST", "PUT", "DELETE"]) {
    for (const url of ["/v1/snapshot", "/v1/usage"]) {
      assert.equal((await b.call(method, url)).status, 404, `${method} ${url}`);
    }
  }
  assert.deepEqual(b.calls, []);
});

test("the gateway's status and body pass through unchanged", async () => {
  const b = await broker(ADDRESSES, async () => new Response('{"error":"rate limited"}', { status: 429 }));
  const reply = await b.call("GET", "/v1/usage");
  assert.equal(reply.status, 429);
  assert.equal(reply.body, '{"error":"rate limited"}');
  assert.equal(b.calls.length, 1);
});

test("an unreachable gateway answers 502 with the cause and without the token", async () => {
  const b = await broker(ADDRESSES, async () => {
    throw new TypeError("connect ECONNREFUSED 100.64.0.1:4000");
  });
  const reply = await b.call("GET", "/v1/usage");
  assert.equal(reply.status, 502);
  const error: unknown = JSON.parse(reply.body ?? "").error;
  assert.equal(typeof error, "string");
  assert.match(String(error), /ECONNREFUSED/);
  assert.doesNotMatch(String(error), /gateway-secret/);
  assert.equal(b.calls.length, 1, "the gateway was asked once");
});

test("an unreadable gateway token answers 502 and sends nothing", async () => {
  const b = await broker(ADDRESSES, okGateway, null);
  const reply = await b.call("GET", "/v1/usage");
  assert.equal(reply.status, 502);
  assert.match(JSON.parse(reply.body ?? "").error, /gateway usage failed/);
  assert.deepEqual(b.calls, []);
});

test("a gateway token that fetch refuses as a header answers 502 without any part of the token", async () => {
  const b = await broker("gateway=127.0.0.1:9\nengine=127.0.0.1:9\n", fetch, "gateway\nsecret-part\n");
  const reply = await b.call("GET", "/v1/usage");
  assert.equal(reply.status, 502);
  assert.doesNotMatch(JSON.parse(reply.body ?? "").error, /secret-part/);
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("over HTTP, omp's broker client gets health, the snapshot, a 304 long poll, and gateway usage with the gateway token", async (t) => {
  const seen: { url: string | undefined; headers: IncomingHttpHeaders }[] = [];
  let gatewayStatus = 200;
  const gateway = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.statusCode = gatewayStatus;
    res.end('[{"id":"acct"}]');
  });
  const gatewayAt = await listen(gateway);
  t.after(() => gateway.close());
  const dir = await tempDir(join(tmpdir(), "ugub-"));
  await writeFile(join(dir, "addresses"), `gateway=${gatewayAt}\nengine=127.0.0.1:9\n`);
  await writeFile(join(dir, "token"), `${TOKEN}\n`);
  const server = createUsageBroker({ addressesFile: join(dir, "addresses"), gatewayTokenFile: join(dir, "token"), fetchImpl: fetch });
  const base = `http://${await listen(server)}`;
  t.after(() => server.close());

  const health = await fetch(`${base}/v1/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("content-type"), "application/json");
  assert.deepEqual(await health.json(), { ok: true });

  const snapshot = await fetch(`${base}/v1/snapshot`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers.get("etag"), '"1"');
  assert.equal(snapshot.headers.get("content-type"), "application/json");
  assert.deepEqual((await snapshot.json()).credentials, []);

  const current = await fetch(`${base}/v1/snapshot?wait=0`, { headers: { "if-none-match": '"1"' } });
  assert.equal(current.status, 304);
  assert.equal(current.headers.get("etag"), '"1"');
  const stale = await fetch(`${base}/v1/snapshot?wait=0`, { headers: { "if-none-match": '"0"' } });
  assert.equal(stale.status, 200);
  await stale.body?.cancel();

  const usage = await fetch(`${base}/v1/usage`);
  assert.equal(usage.status, 200);
  assert.equal(await usage.text(), '[{"id":"acct"}]');
  assert.deepEqual(
    seen.map((s) => [s.url, s.headers.authorization]),
    [["/v1/usage", `Bearer ${TOKEN}`]],
  );
  gatewayStatus = 503;
  assert.equal((await fetch(`${base}/v1/usage`)).status, 503);

  const observed = await fetch(`${base}/v1/usage/observed`, { method: "POST", body: "{}" });
  assert.equal(observed.status, 204);
  assert.equal(observed.headers.get("content-type"), null);
  const credential = await fetch(`${base}/v1/credential`, { method: "POST", body: "{}" });
  assert.equal(credential.status, 404);
  await credential.body?.cancel();
  assert.equal(seen.length, 2, "only the two usage calls reached the gateway");
});

function lanAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((i) => i !== undefined && i.family === "IPv4" && !i.internal)?.address;
}

function reachable(host: string, port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ host, port, timeout: 2000 });
  socket.on("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.on("timeout", () => {
    socket.destroy();
    resolve(false);
  });
  socket.on("error", () => resolve(false));
  return promise;
}

// The entry point listens on a fixed port, which the installed usage broker holds on the owner's
// mac. A preload moves only that port to a free one, keeps the host the entry point passes, and
// reports the address the server really bound.
const FREE_PORT_PRELOAD = `
import net from "node:net";
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, ...rest) {
  this.once("listening", () => process.stdout.write("BOUND " + JSON.stringify(this.address()) + "\\n"));
  return listen.call(this, port === ${USAGE_BROKER_PORT} ? 0 : port, ...rest);
};
`;

test("the usage broker service listens on loopback only", async (t) => {
  const home = await tempDir(join(tmpdir(), "ugub-home-"));
  const preload = join(home, "free-port.mjs");
  await writeFile(preload, FREE_PORT_PRELOAD);
  const child = spawn(process.execPath, ["--import", preload, join(import.meta.dirname, "../../host/broker/usage-broker.ts")], {
    env: { HOME: home, PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const { promise: bound, resolve } = Promise.withResolvers<AddressInfo | undefined>();
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const line = /^BOUND (.*)$/m.exec(stdout);
    if (line !== null) resolve(JSON.parse(line[1]));
  });
  child.on("exit", () => resolve(undefined));
  const address = await bound;
  assert.ok(address !== undefined, `the usage broker did not start: ${stderr}`);
  assert.equal(address.address, "127.0.0.1", "bound address");
  assert.equal(await reachable("127.0.0.1", address.port), true, "not listening on loopback");
  const lan = lanAddress();
  if (lan !== undefined) assert.equal(await reachable(lan, address.port), false, `reachable on ${lan}`);
});
