import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const docs = tracked.filter((file) => file.endsWith(".md"));
const names = new Set(tracked.map((file) => basename(file)));
const CODE_DIRS = new RegExp("^(host|scripts|tests|\\.github)/");
const SCRIPT_DIRS = new RegExp("^(host|scripts)/");
const LINE = /^(.+?):\d+(?:[-,]\s?:?\d+)*$/;
const BARE_LINE = /^:\d+(?:[-,]\s?:?\d+)*$/;
const FILE = /^[\w.@-]*(?:\/[\w.@<>-]+)*\.?[\w-]+$/;
const NAME = /^[A-Za-z_$@-][\w$.@-]*(?:\(\))?$/;
const CITE = /(?<!`,\s*)`([^`\n]+)`,\s+`([^`\n]+)`(?!,\s*`|\s+(?:and|or)\s+`)/g;
const SECTION = /`([^`\n]+\.md)`,\s+(?!`|and\s|or\s)(?=([^\n]*))/g;
const SCRIPT_SECTION = /(?<![\w./-])((?:\.\.\/)*[\w./-]+\.md),\s+(?=([^\n]*))/g;
const LABEL = /^\\?"([^"\\\n]+)\\?"/;
const ID = /^([A-Z]\d+)\b/;
const LOOSE_ID = /\b[A-Z]\d+\b/g;
const FORM = '`doc.md`, "Heading" or `doc.md`, U1';

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

function anchors(file) {
  const labels = new Set();
  const ids = new Set();
  for (const line of readFileSync(resolve(root, file), "utf8").split("\n")) {
    const heading = /^#+\s+(.+?)\s*$/.exec(line);
    if (heading) labels.add(heading[1]);
    const bold = /^\s*(?:[-*]\s+|\d+\.\s+)?\*\*([^*\n]+?)[.:]?\*\*/.exec(line);
    if (bold) labels.add(bold[1]);
    const id = /^\s*(?:\|\s*|-\s+)([A-Z]\d+)(?:\s*\||:)/.exec(line);
    if (id) ids.add(id[1]);
  }
  return { labels, ids };
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, anchors(file));
  return anchorCache.get(file);
}

const definedIds = new Set(docs.flatMap((file) => [...anchorsOf(file).ids]));

function checkSection(where, path, rest) {
  const file = trackedFile(path);
  if (file === undefined || !file.endsWith(".md") || !existsSync(resolve(root, file))) return;
  const { labels, ids } = anchorsOf(file);
  const label = LABEL.exec(rest);
  if (label) {
    if (!labels.has(label[1])) problems.push(`${where}: "${label[1]}" is not a heading or bold label in ${file}`);
    return;
  }
  const id = ID.exec(rest);
  if (id) {
    if (!ids.has(id[1])) problems.push(`${where}: ${id[1]} is not a row of ${file}`);
    return;
  }
  problems.push(`${where}: after ${path}, cite a section as ${FORM}`);
}

function withoutCode(line) {
  return line.replace(/`[^`\n]*`/g, "``").replace(/\]\([^)\n]*\)/g, "]()");
}

const problems = [];
for (const file of tracked.filter((file) => SCRIPT_DIRS.test(file) && file !== "scripts/check-doc-citations.mjs")) {
  const lines = readFileSync(resolve(root, file), "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(SCRIPT_SECTION)) checkSection(`${file}:${index + 1}`, match[1], match[2]);
  }
}
for (const doc of docs) {
  const lines = readFileSync(resolve(root, doc), "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const where = `${doc}:${index + 1}`;
    for (const match of line.matchAll(SECTION)) checkSection(where, match[1], match[2]);
    for (const [id] of withoutCode(line).matchAll(LOOSE_ID)) {
      if (!definedIds.has(id)) problems.push(`${where}: ${id} is not a row id of any doc; cite the section as ${FORM}`);
    }
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
