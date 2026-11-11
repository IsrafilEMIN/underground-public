import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const homeKeys = [...readFileSync(resolve(root, "host/facts"), "utf8").matchAll(/^([A-Za-z_]\w*_home)=/gm)].map((match) => match[1]);
if (homeKeys.length === 0) {
  console.error("host/facts: no *_home key");
  process.exit(1);
}
const keys = homeKeys.join("|");
const uppers = homeKeys.map((key) => key.toUpperCase()).join("|");
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((file) => file.startsWith("host/bin/") || file.startsWith("host/lib/") || /^scripts\/[^/]+\.sh$/.test(file));

const assignment = /(?<![\w$.-])([A-Za-z_]\w*)=("(?:[^"\\]|\\.)*"|'[^']*'|(?:\$\([^)]*\)|[^\s;&|"'])*)/g;
const homeValue = new RegExp(`^"?\\$\\(ug_fact\\s+(?:${keys})\\)"?$`);
const factSlash = `\\$\\(ug_fact\\s+(?:${keys})\\)"?/`;
const drop = /\b(?:ug_as|ug_read_as|ug_write_as)\b|\bsudo\s+(?:-n\s+)?-u\b/;
const names = (set) => (set.size ? [...set].join("|") : "(?!)");
const varUse = (set) => `\\$(?:\\{(?:${names(set)})\\}|(?:${names(set)})(?!\\w))`;

function findings(text) {
  const lines = text.split("\n");
  const found = lines.map((line) => (drop.test(line) ? [] : [...line.matchAll(assignment)].map((match) => ({ name: match[1], value: match[2] }))));
  const all = found.flat();
  const homeVars = new Set(all.filter((item) => homeValue.test(item.value)).map((item) => item.name));
  const belowVars = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    const refs = new RegExp(`${varUse(new Set([...homeVars, ...belowVars]))}|${factSlash}`);
    for (const { name, value } of all) {
      if (homeVars.has(name) || belowVars.has(name) || !refs.test(value)) continue;
      belowVars.add(name);
      grew = true;
    }
  }
  const homeUse = new RegExp(`${varUse(homeVars)}"?/|${factSlash}|@(?:${uppers})@/`);
  const belowUse = new RegExp(varUse(belowVars));
  return lines.flatMap((line, index) => {
    if (drop.test(line)) return [];
    const defines = found[index].some((item) => belowVars.has(item.name));
    return defines || homeUse.test(line) || belowUse.test(line) ? [index + 1] : [];
  });
}

let failed = false;
for (const file of files) {
  const text = readFileSync(resolve(root, file), "utf8");
  for (const line of findings(text)) {
    console.error(`${file}:${line}: a path below the home of a user with fewer rights; run the command as that user with ug_as (docs/adr/0027-enforce-least-rights.md)`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log("lower-homes check passed");
