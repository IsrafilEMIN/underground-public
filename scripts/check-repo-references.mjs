import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "-z", "--", "AGENTS.md", "host", "scripts", ".github/workflows"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const slug = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
const patterns = [
  new RegExp(`\\bbroker\\s+(?:sync|push|pr-create|pr-status|ci-log|merge|delete-branch|review)\\s+${slug}\\b`),
  new RegExp(`\\b(?:REPO|repo_url)=["']?(?:git@github\\.com:|https://github\\.com/)?${slug}\\b`),
  new RegExp(`git@github\\.com:${slug}\\b`),
  new RegExp(`https://github\\.com/(?!settings/)${slug}\\b`),
  new RegExp(`from\\s+[A-Za-z0-9_.-]+/agent/`),
];
let failed = false;
for (const file of files) {
  const lines = readFileSync(resolve(root, file), "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (patterns.some((pattern) => pattern.test(line))) {
      console.error(`${file}:${index + 1}: fixed repository identity; derive it from origin`);
      failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
else console.log("repository reference check passed");
