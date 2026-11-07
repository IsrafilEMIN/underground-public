import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Mount {
  destination: string;
  source: string;
  options: string[];
  type: Record<string, { name?: string }>;
}

export interface Inspected {
  configuration: {
    capAdd: string[];
    image: { reference: string };
    initProcess: { executable: string };
    mounts: Mount[];
    networks: unknown[];
    publishedPorts: unknown[];
    publishedSockets: unknown[];
    readOnly: boolean;
    ssh: boolean;
    sysctls: Record<string, string>;
    virtualization: boolean;
  };
  status: { networks: unknown[]; state: string };
}

export function boxProblems(box: Inspected, want: { name: string; repo: string; tag: string }): string[] {
  const c = box.configuration;
  const problems: string[] = [];
  const empty = (v: unknown[] | Record<string, unknown>) => (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
  if (box.status.state !== "running") problems.push(`state is ${box.status.state}, not running`);
  if (!empty(c.networks) || !empty(box.status.networks)) problems.push("the box has a network");
  if (c.readOnly !== true) problems.push("the root is writable");
  if (!empty(c.capAdd)) problems.push(`added capabilities: ${c.capAdd.join(", ")}`);
  if (c.ssh !== false) problems.push("the ssh agent is forwarded");
  if (c.virtualization !== false) problems.push("virtualization is exposed");
  if (!empty(c.publishedPorts) || !empty(c.publishedSockets)) problems.push("ports or sockets are published to the mac");
  if (!empty(c.sysctls)) problems.push("sysctls are set");
  if (c.image.reference !== want.tag && !c.image.reference.endsWith(`/${want.tag}`)) problems.push(`image is ${c.image.reference}, not ${want.tag}`);
  if (c.initProcess.executable !== "/usr/local/bin/ug-init") problems.push(`first process is ${c.initProcess.executable}`);
  const mounts = new Map(c.mounts.map((m) => [m.destination, m]));
  const tmp = mounts.get("/tmp");
  const home = mounts.get("/home/agent");
  const repo = mounts.get("/repo");
  if (c.mounts.length !== 3) problems.push(`${c.mounts.length} mounts, not 3: ${c.mounts.map((m) => m.destination).join(", ")}`);
  if (!tmp?.type.tmpfs) problems.push("/tmp is not a tmpfs");
  if (home?.type.volume?.name !== `${want.name}-home`) problems.push("/home/agent is not the box's own volume");
  if (!repo?.type.virtiofs || repo.source !== want.repo || !repo.options.includes("ro")) problems.push(`/repo is not ${want.repo}, read-only`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, repo, tag] = process.argv.slice(2);
  const boxes = JSON.parse(readFileSync(0, "utf8")) as Inspected[];
  const problems = boxes.length === 1 ? boxProblems(boxes[0], { name, repo, tag }) : [`inspect returned ${boxes.length} boxes`];
  for (const p of problems) console.error(`- ${p}`);
  process.exit(problems.length ? 1 : 0);
}
