import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const docs = tracked.filter((file) => file.endsWith(".md"));
const names = new Set(tracked.map((file) => basename(file)));
const CODE_DIRS = new RegExp("^(host|scripts|tests|\\.github)/");
const LINE = /^(.+?):\d+(?:[-,]\s?:?\d+)*$/;
const BARE_LINE = /^:\d+(?:[-,]\s?:?\d+)*$/;
const FILE = /^[\w.@-]*(?:\/[\w.@<>-]+)*\.?[\w-]+$/;
const NAME = /^[A-Za-z_$@-][\w$.@-]*(?:\(\))?$/;
const CITE = /(?<!`,\s*)`([^`\n]+)`,\s+`([^`\n]+)`(?!,\s*`|\s+(?:and|or)\s+`)/g;

function clean(path) {
  let rest = path;
  while (rest.startsWith("../") || rest.startsWith("./")) rest = rest.slice(rest.indexOf("/") + 1);
  return rest;
}

function trackedFile(path) {
  const rest = clean(path);
  return tracked.find((file) => file === rest || file.endsWith(`/${rest}`));
}

function isRepoFile(path) {
  const rest = clean(path);
  return CODE_DIRS.test(rest) || (!rest.includes("/") && names.has(rest)) || trackedFile(rest) !== undefined;
}

function looksLikeFile(token) {
  return FILE.test(token) && (token.includes("/") || token.includes("."));
}

const problems = [];
for (const doc of docs) {
  const lines = readFileSync(resolve(root, doc), "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const where = `${doc}:${index + 1}`;
    let last;
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1];
      if (BARE_LINE.test(token)) {
        if (last !== undefined && isRepoFile(last)) problems.push(`${where}: \`${token}\` cites a line of ${last}; name the function, value, or section instead`);
        continue;
      }
      const lined = LINE.exec(token);
      const path = lined ? lined[1] : token;
      if (!looksLikeFile(path)) continue;
      last = path;
      if (lined && isRepoFile(path)) problems.push(`${where}: \`${token}\` cites a line of a repo file; name the function, value, or section instead`);
    }
    for (const match of line.matchAll(CITE)) {
      const [, name, path] = match;
      if (!NAME.test(name) || looksLikeFile(name) || !looksLikeFile(path)) continue;
      const file = trackedFile(path);
      if (file === undefined || !existsSync(resolve(root, file))) continue;
      const word = name.replace(/\(\)$/, "");
      if (!readFileSync(resolve(root, file), "utf8").includes(word)) problems.push(`${where}: \`${word}\` is not in ${file}`);
    }
  }
}
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exitCode = 1;
else console.log("doc citation check passed");
