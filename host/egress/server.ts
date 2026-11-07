import { lookup } from "node:dns";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { LookupFunction } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { addGatewayBearer, isAllowed, readRules } from "./rules.ts";

interface SrtProxy {
  createHttpProxyServer(options: {
    filter(port: number, host: string): boolean;
    lookupFor(port: number): LookupFunction;
    mutateHeadersPlaintext(headers: IncomingHttpHeaders, destHost: string): void;
    requireHostMatch: boolean;
    requireAsciiHost: boolean;
  }): Server;
}

const [socketPath, src] = process.argv.slice(2);
if (!socketPath || !src) {
  console.error("usage: server.ts <socket> <underground checkout>");
  process.exit(64);
}

const ug = process.env.UG_DIR ?? join(homedir(), ".ug");
const srtPin = /^srt=(.+)$/m.exec(readFileSync(join(src, "VERSIONS"), "utf8"))?.[1];
const srt = join(ug, "sys/srt", String(srtPin), "node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js");
const { createHttpProxyServer } = (await import(pathToFileURL(srt).href)) as SrtProxy;

const rules = readRules(
  readFileSync(join(ug, "host/addresses"), "utf8"),
  readFileSync(join(src, "host/network-allowlist"), "utf8"),
  readFileSync(join(ug, "host/auth/auth-gateway.token"), "utf8"),
);

const lookupFor = (): LookupFunction => (hostname, options, callback) => {
  const mapped = rules.names.get(hostname);
  if (!mapped) return lookup(hostname, options, callback);
  if (options.all) return callback(null, [{ address: mapped.address, family: 4 }]);
  return callback(null, mapped.address, 4);
};

const server = createHttpProxyServer({
  filter: (port, host) => {
    const ok = isAllowed(rules, port, host);
    if (!ok) console.error(`refused ${host}:${port}`);
    return ok;
  },
  lookupFor,
  mutateHeadersPlaintext: (headers, destHost) => addGatewayBearer(rules, headers, destHost),
  requireHostMatch: true,
  requireAsciiHost: true,
});

rmSync(socketPath, { force: true });
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  console.error(`egress door on ${socketPath}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
