import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

export async function factTokens(): Promise<string[]> {
  const text = await readFile(join(ROOT, "host/facts"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => `@${line.slice(0, line.indexOf("=")).toUpperCase()}@`);
}

export async function render(dir: string, template: string, facts: Record<string, string> = {}, out = join(dir, basename(template))): Promise<string> {
  const lib = join(dir, "render/host/lib");
  await mkdir(lib, { recursive: true });
  await copyFile(join(ROOT, "host/lib/ug.bash"), join(lib, "ug.bash"));
  const lines = (await readFile(join(ROOT, "host/facts"), "utf8")).split("\n").filter((line) => line.includes("="));
  const merged = lines.map((line) => {
    const key = line.slice(0, line.indexOf("="));
    return key in facts ? `${key}=${facts[key]}` : line;
  });
  await writeFile(join(dir, "render/host/facts"), `${merged.join("\n")}\n`);
  const run = spawnSync("bash", ["-c", 'source "$1"; ug_render "$2" "$3" "$3"', "_", join(lib, "ug.bash"), out, join(ROOT, template)], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return out;
}
