import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const DISPLAY_KEYS = ["statusLine", "theme", "symbolPreset", "display", "tui", "composer", "personality", "stt", "terminal", "colorBlindMode", "hideThinkingBlock", "inlineToolDescriptors", "doubleEscapeAction"] as const;

export function displayPrefs(config: unknown): Record<string, unknown> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return {};
  const source = config as Record<string, unknown>;
  return Object.fromEntries(DISPLAY_KEYS.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
}

if (import.meta.main) {
  const [ownerConfig, out] = process.argv.slice(2);
  let parsed: unknown = {};
  try {
    parsed = Bun.YAML.parse(readFileSync(ownerConfig, "utf8"));
  } catch (error) {
    process.stderr.write(`display-prefs: ${ownerConfig}: ${error instanceof Error ? error.message : String(error)}; roles keep omp's default look\n`);
  }
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(displayPrefs(parsed), null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, out);
}
