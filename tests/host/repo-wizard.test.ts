import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const WIZARD = join(import.meta.dirname, "../../scripts/broker-github-app-wizard.sh");

function git(checkout: string, ...args: string[]): void {
  const run = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

function source(checkout: string, script = 'repo_from_checkout "$2"') {
  return spawnSync("/bin/bash", ["-c", `source "$1"; ${script}`, "_", WIZARD, checkout, process.execPath], {
    cwd: checkout,
    env: { ...process.env, HOME: checkout, ENV_FILE: join(checkout, "missing.env") },
    encoding: "utf8",
  });
}

for (const origin of ["git@github.com:Another-Owner/alternate_repo.git", "https://github.com/Another-Owner/alternate_repo.git", "https://github.com/Another-Owner/alternate_repo"]) {
  test(`wizard resolves checkout identity from ${origin}`, async (t) => {
    const checkout = await tempDir(join(tmpdir(), "repo-wizard-"));
    t.after(() => rm(checkout, { recursive: true, force: true }));
    git(checkout, "init", "--quiet");
    git(checkout, "remote", "add", "origin", origin);
    const run = source(checkout);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "Another-Owner/alternate_repo\n");
    assert.equal(run.stderr, "");
  });
}

for (const origin of [
  "git@gitlab.com:Another-Owner/alternate_repo.git",
  "https://gitlab.com/Another-Owner/alternate_repo.git",
  "https://github.com.evil.example/Another-Owner/alternate_repo.git",
  "ssh://git@github.com/Another-Owner/alternate_repo.git",
  "https://github.com/Another-Owner",
  "https://github.com//alternate_repo.git",
  "https://github.com/Another-Owner/",
  "https://github.com/-owner/repo.git",
  "https://github.com/owner-/repo.git",
  "https://github.com/owner/repo/extra.git",
  "https://github.com/owner/repo.git?query=value",
  "https://github.com/owner/.",
  "https://github.com/owner/..",
]) {
  test(`wizard rejects invalid or non-GitHub origin ${origin}`, async (t) => {
    const checkout = await tempDir(join(tmpdir(), "repo-wizard-"));
    t.after(() => rm(checkout, { recursive: true, force: true }));
    git(checkout, "init", "--quiet");
    git(checkout, "remote", "add", "origin", origin);
    const run = source(checkout);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /Origin must be a GitHub SSH or HTTPS URL:|Invalid GitHub repository in origin:/);
    assert.ok(run.stderr.includes(origin), run.stderr);
  });
}

test("wizard reports a checkout without origin", async (t) => {
  const checkout = await tempDir(join(tmpdir(), "repo-wizard-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  git(checkout, "init", "--quiet");
  const run = source(checkout);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, `Cannot read origin from checkout: ${checkout}\n`);
});

test("wizard asks for checkout before GitHub instructions and uses that checkout's identity", async (t) => {
  const checkout = await tempDir(join(tmpdir(), "repo-wizard-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  git(checkout, "init", "--quiet");
  git(checkout, "remote", "add", "origin", "git@github.com:Selected-Owner/selected-repo.git");
  const run = source(checkout, `
ask() {
  printf 'ask:%s\\n' "$1"
  [[ "$1" == CHECKOUT ]] || return 1
  printf -v "$1" '%s' "$CHECKOUT_SELECTED"
}
banner() { :; }
stage() { :; }
open_url() { printf 'open:%s\\n' "$1"; }
CHECKOUT_SELECTED="$2"
run_wizard
`);
  assert.equal(run.status, 1);
  assert.equal(run.stderr, "");
  assert.ok(run.stdout.startsWith("ask:CHECKOUT\n"), run.stdout);
  assert.match(run.stdout, /Homepage URL: https:\/\/github.com\/Selected-Owner\/selected-repo/);
  assert.equal(run.stdout.split("ask:CHECKOUT\n").length, 2);
  assert.ok(run.stdout.endsWith("ask:APP_CLIENT_ID\n"), run.stdout);
});

test("wizard finds the author binding without case sensitivity and returns its configured spelling", async (t) => {
  const checkout = await tempDir(join(tmpdir(), "repo-wizard-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await writeFile(join(checkout, "bindings.json"), JSON.stringify({
    reviewer: { repo: "Configured-Owner/Repo", role: "code-review" },
    other: { repo: "Different-Owner/Repo", role: "author" },
    author: { repo: "Configured-Owner/Repo", role: "author" },
  }));
  const run = source(checkout, 'author_binding "$3" "$2/bindings.json" "configured-owner/REPO" "$2/run"');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `Configured-Owner/Repo\n${checkout}/run/author.sock\n`);
  const missing = source(checkout, 'author_binding "$3" "$2/bindings.json" "absent-owner/repo" "$2/run"');
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, "");
});
