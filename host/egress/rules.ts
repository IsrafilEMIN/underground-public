import type { IncomingHttpHeaders } from "node:http";

export interface Mapped {
  address: string;
  port: number;
}

export interface EgressRules {
  names: Map<string, Mapped>;
  sites: Set<string>;
  gatewayName: string;
  gatewayToken: string;
}

export const GATEWAY_NAME = "gateway.internal";
export const USAGE_NAME = "usage.internal";
export const USAGE = { address: "127.0.0.1", port: 18765 };

export function readRules(addresses: string, allowlist: string, gatewayToken: string): EgressRules {
  const gateway = /^gateway=(.+):(\d+)$/m.exec(addresses);
  if (!gateway) throw new Error("the addresses file has no gateway=<address>:<port> line");
  if (gatewayToken.trim() === "") throw new Error("the gateway token is empty");
  const sites = allowlist
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((line) => line !== "" && line !== "@GATEWAY@");
  const odd = sites.find((s) => !/^[a-z0-9.-]+$/.test(s) || /^[0-9.]+$/.test(s) || s.endsWith(".internal"));
  if (odd) throw new Error(`the allowlist entry ${odd} is not a plain site name`);
  return {
    names: new Map([
      [GATEWAY_NAME, { address: gateway[1], port: Number(gateway[2]) }],
      [USAGE_NAME, USAGE],
    ]),
    sites: new Set(sites),
    gatewayName: GATEWAY_NAME,
    gatewayToken: gatewayToken.trim(),
  };
}

export function isAllowed(rules: EgressRules, port: number, host: string): boolean {
  const mapped = rules.names.get(host);
  if (mapped) return mapped.port === port;
  return port === 443 && rules.sites.has(host);
}

export function addGatewayBearer(rules: EgressRules, headers: IncomingHttpHeaders, destHost: string): void {
  if (destHost.replace(/:\d+$/, "") !== rules.gatewayName) return;
  headers.authorization = `Bearer ${rules.gatewayToken}`;
}
