import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

const SETUP = join(import.meta.dirname, "../../host/bin/ug-setup");

async function copyAt(root: string): Promise<string> {
  await mkdir(join(root, "host/bin"), { recursive: true });
  await mkdir(join(root, "host/lib"), { recursive: true });
  await copyFile(SETUP, join(root, "host/bin/ug-setup"));
  await copyFile(join(import.meta.dirname, "../../host/lib/ug.bash"), join(root, "host/lib/ug.bash"));
  await copyFile(join(import.meta.dirname, "../../host/facts"), join(root, "host/facts"));
  return join(root, "host/bin/ug-setup");
}

const GITHUB_ORIGIN = "https://github.com/o/underground.git";
const PULL_REQUEST = { required_approving_review_count: 1, require_code_owner_review: true, require_last_push_approval: true, dismiss_stale_reviews_on_push: true };
const RULESET = {
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "checks", integration_id: 15368 }] } },
    { type: "pull_request", parameters: PULL_REQUEST },
  ],
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
};
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
"api user") echo '{"login":"owner"}' ;;
"api repos/o/underground/rulesets?per_page=100") cat "$HOME/rulesets.json" ;;
"api repos/o/underground/rulesets/1") cat "$HOME/ruleset.json" ;;
*) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;

type Wall = { ruleset?: unknown; rulesets?: unknown; codeowners?: string };

async function github(home: string, checkout: string, wall: Wall = {}): Promise<Record<string, string>> {
  await mkdir(join(home, "bin"), { recursive: true });
  await writeFile(join(home, "bin/gh"), FAKE_GH, { mode: 0o755 });
  await writeFile(join(home, "rulesets.json"), JSON.stringify(wall.rulesets ?? [{ id: 1, enforcement: "active", target: "branch" }]));
  await writeFile(join(home, "ruleset.json"), JSON.stringify(wall.ruleset ?? RULESET));
  await mkdir(join(checkout, ".github"), { recursive: true });
  await writeFile(join(checkout, ".github/CODEOWNERS"), wall.codeowners ?? "* @owner\n");
  return { HOME: home, PATH: `${join(home, "bin")}:/usr/bin:/bin` };
}

async function behindOrigin(home: string, wall: Wall = {}) {
  const checkout = join(home, "code/underground");
  const origin = join(home, "origin.git");
  const other = join(home, "other");
  const setup = await copyAt(checkout);
  const env = await github(home, checkout, wall);
  const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.email=o@x", "-c", "user.name=o", ...args], { encoding: "utf8" });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "one");
  git(home, "clone", "-q", "--bare", checkout, origin);
  git(checkout, "remote", "add", "origin", GITHUB_ORIGIN);
  git(checkout, "config", `url.${origin}.insteadOf`, GITHUB_ORIGIN);
  git(checkout, "fetch", "-q", "origin");
  git(home, "clone", "-q", origin, other);
  await writeFile(join(other, "host/bin/ug-setup"), 'printf "new setup pulled=%s\\n" "$UG_SETUP_PULLED"\n');
  git(other, "commit", "-q", "-am", "two");
  git(other, "push", "-q", "origin", "main");
  return { checkout, origin, setup, env, git };
}

test("ug-setup refuses to run from a checkout inside the folder that setup writes, and writes nothing", async (t) => {
  for (const dir of [".local/share/underground"]) {
    const home = await tempDir(join(tmpdir(), "ug-setup-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const setup = await copyAt(join(home, dir, "checkout"));
    const r = spawnSync("bash", [setup], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /which setup itself writes/);
    assert.deepEqual((await readdir(join(home, dir))).sort(), ["checkout"]);
  }
});

test("ug-setup from a checkout outside those folders gets past that guard", async (t) => {
  const home = await tempDir(join(tmpdir(), "ug-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const setup = await copyAt(join(home, "code/underground"));
  const r = spawnSync("bash", [setup], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.notEqual(r.status, 64, r.stderr);
  assert.doesNotMatch(r.stderr, /which setup itself writes/);
  assert.match(r.stderr, /is not a git checkout/);
});

test("ug-setup refuses a checkout that is not at origin/main or has local changes, so only what CI proved is installed", async (t) => {
  const home = await tempDir(join(tmpdir(), "ug-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const checkout = join(home, "code/underground");
  const setup = await copyAt(checkout);
  const git = (...args: string[]) => spawnSync("git", ["-C", checkout, "-c", "user.email=o@x", "-c", "user.name=o", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  git("commit", "-q", "--allow-empty", "-m", "two");
  const ahead = spawnSync("bash", [setup], { env, encoding: "utf8" });
  assert.notEqual(ahead.status, 0);
  assert.match(ahead.stderr, /not origin\/main/);
  git("reset", "-q", "--hard", "origin/main");
  await copyFile(SETUP, join(checkout, "host/bin/ug-setup.bak"));
  const dirty = spawnSync("bash", [setup], { env, encoding: "utf8" });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /not committed/);
});

test("ug-setup fast-forwards main from origin, then runs the setup that the pull brought", async (t) => {
  const home = await tempDir(join(tmpdir(), "ug-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { checkout, origin, setup, env, git } = await behindOrigin(home);
  const r = spawnSync("bash", [setup], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /checkout: pulled main from/);
  assert.match(r.stdout, /new setup pulled=1/);
  assert.equal(git(checkout, "rev-parse", "HEAD").stdout, git(origin, "rev-parse", "main").stdout);
});

test("ug-setup pulls nothing when GitHub lets a change reach main without the owner's approval", async (t) => {
  const without = (type: string) => ({ ...RULESET, rules: RULESET.rules.filter((rule) => rule.type !== type) });
  const pullRequest = (parameters: object) => ({ ...without("pull_request"), rules: [...without("pull_request").rules, { type: "pull_request", parameters }] });
  const cases: [Wall, RegExp][] = [
    [{ rulesets: [] }, /has no active branch ruleset/],
    [{ rulesets: [{ id: 1, enforcement: "disabled", target: "branch" }] }, /has no active branch ruleset/],
    [{ ruleset: without("pull_request") }, /does not require a pull request/],
    [{ ruleset: pullRequest({ ...PULL_REQUEST, require_code_owner_review: false }) }, /review from code owners/],
    [{ ruleset: pullRequest({ ...PULL_REQUEST, require_last_push_approval: false }) }, /approval of the most recent push/],
    [{ ruleset: pullRequest({ ...PULL_REQUEST, required_approving_review_count: 0 }) }, /needs 1 approval/],
    [{ ruleset: without("non_fast_forward") }, /does not block force pushes/],
    [{ ruleset: { ...RULESET, conditions: { ref_name: { include: ["refs/heads/release"], exclude: [] } } } }, /does not target main/],
    [{ ruleset: { ...without("required_status_checks"), rules: [...without("required_status_checks").rules, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "checks", integration_id: 7 }] } }] } }, /no status check from GitHub Actions/],
    [{ ruleset: { ...RULESET, bypass_actors: [...RULESET.bypass_actors, { actor_id: 7, actor_type: "Integration", bypass_mode: "always" }] } }, /bypass list holds Integration 7/],
    [{ ruleset: { ...RULESET, bypass_actors: undefined } }, /bypass list is not readable/],
    [{ codeowners: "* @owner\nhost/ @bot\n" }, /each line must name only @owner/],
    [{ codeowners: "docs/ @owner\n" }, /has no line "\* @owner"/],
  ];
  for (const [wall, message] of cases) {
    const home = await tempDir(join(tmpdir(), "ug-setup-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const { checkout, setup, env, git } = await behindOrigin(home, wall);
    const before = git(checkout, "rev-parse", "HEAD", "origin/main").stdout;
    const r = spawnSync("bash", [setup], { env, encoding: "utf8" });
    assert.equal(r.status, 1, `${message}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /a wall is open/);
    assert.match(r.stderr, message);
    assert.equal(git(checkout, "rev-parse", "HEAD", "origin/main").stdout, before, `${message}: setup fetched or pulled`);
  }
});

test("ug-setup stops on another branch or a failed fetch, and leaves HEAD where it was", async (t) => {
  const home = await tempDir(join(tmpdir(), "ug-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const checkout = join(home, "code/underground");
  const setup = await copyAt(checkout);
  const env = await github(home, checkout);
  const git = (...args: string[]) => spawnSync("git", ["-C", checkout, "-c", "user.email=o@x", "-c", "user.name=o", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  git("remote", "add", "origin", GITHUB_ORIGIN);
  git("config", `url.${join(home, "missing.git")}.insteadOf`, GITHUB_ORIGIN);
  const head = git("rev-parse", "HEAD").stdout;
  const fetch = spawnSync("bash", [setup], { env, encoding: "utf8" });
  assert.equal(fetch.status, 1);
  assert.match(fetch.stderr, /cannot fetch main from origin/);
  assert.equal(git("rev-parse", "HEAD").stdout, head);
  git("checkout", "-q", "-b", "feature");
  const branch = spawnSync("bash", [setup], { env, encoding: "utf8" });
  assert.equal(branch.status, 1);
  assert.match(branch.stderr, /is on feature, not main/);
  assert.equal(git("rev-parse", "HEAD").stdout, head);
});
