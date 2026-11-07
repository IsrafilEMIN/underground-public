import type { Checked } from "./protocol.ts";

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
