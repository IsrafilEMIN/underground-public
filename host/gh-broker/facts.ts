import { readFileSync } from "node:fs";
import { join } from "node:path";

export type HostFacts = { root: string; ownerData: string; ghBrokerSocket: string; usageBrokerPort: number };

export const FACTS_FILE = join(import.meta.dirname, "../facts");

export function readHostFacts(file: string = FACTS_FILE): HostFacts {
  const values = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1));
  }
  const need = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value === "") throw new Error(`${file} has no ${key}`);
    return value;
  };
  const port = Number(need("usage_broker_port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${file} has usage_broker_port ${need("usage_broker_port")}, which is not a port`);
  const root = need("root");
  return { root, ownerData: need("owner_data"), ghBrokerSocket: join(root, need("gh_broker_socket")), usageBrokerPort: port };
}
