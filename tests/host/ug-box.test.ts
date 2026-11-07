import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";
import { inspectedBox } from "./fixtures/box-inspect.ts";

const UG_BOX = join(import.meta.dirname, "../../host/bin/ug-box");

const FAKE = `#!/bin/bash
echo "$*" >> "$FAKE/log"
case "$1 $2" in
  "list --quiet") cat "$FAKE/running" 2>/dev/null ;;
  "volume list") cat "$FAKE/volumes" 2>/dev/null ;;
  "volume create") echo "$3" >> "$FAKE/volumes" ;;
  "image list") cat "$FAKE/images" 2>/dev/null ;;
  "build -t") echo "docker.io/library/$3" >> "$FAKE/images" ;;
  "stop "*) grep -vxF "$2" "$FAKE/running" > "$FAKE/r" || true; mv "$FAKE/r" "$FAKE/running" ;;
  "run "*) while [ "$1" != --name ]; do shift; done; echo "$2" >> "$FAKE/running" ;;
  "exec "*) case "$*" in *ug-session*) echo "SESSION";; *models.yml*) cat > "$FAKE/models.yml";; esac ;;
  "inspect "*) sed -e "s|__NAME__|$2|g" -e "s|__REF__|$(tail -n 1 "$FAKE/images")|g" "$FAKE/inspect.json" ;;
esac
`;

async function setup(built = true) {
  const root = await tempDir(join(tmpdir(), "ug-box-"));
  const bin = join(root, "bin");
  const fake = join(root, "fake");
  const repo = join(root, "app");
  await mkdir(bin, { recursive: true });
  await mkdir(fake);
  await writeFile(join(bin, "container"), FAKE);
  await chmod(join(bin, "container"), 0o755);
  spawnSync("git", ["init", "-q", repo]);
  const ug = join(root, "ug");
  await mkdir(join(ug, "host"), { recursive: true });
  await mkdir(join(root, "cfg"));
  await writeFile(join(root, "cfg/models.yml"), 'providers:\n  gw:\n    baseUrl: "http://@GATEWAY@"\n    apiKey: "@GATEWAY_TOKEN@"\n');
  await writeFile(join(ug, "host/config-repo"), "~/cfg\n");
  await writeFile(join(ug, "host/addresses"), "gateway=100.64.0.1:4000\n");
  await writeFile(join(bin, "fake-egress"), `#!/bin/sh\nexec "${process.execPath}" -e 'require("net").createServer().listen(process.argv[1])' "$1"\n`);
  await chmod(join(bin, "fake-egress"), 0o755);
  const env = { HOME: root, PATH: `${bin}:/usr/bin:/bin`, FAKE: fake, UG_DIR: ug, UG_BOX_STATE: join(root, "state"), UG_BOX_LOCK_WAIT: "1", UG_BOX_NODE: process.execPath, UG_BOX_EGRESS: join(bin, "fake-egress") };
  await writeFile(join(fake, "inspect.json"), JSON.stringify([inspectedBox("__NAME__", repo, "__REF__", join(root, "state/egress.sock"))]));
  const run = (cwd = repo, ...args: string[]) => spawnSync("bash", [UG_BOX, ...args], { cwd, env, encoding: "utf8" });
  const log = async () => (await readFile(join(fake, "log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  if (built) {
    assert.equal(run(repo, "build").status, 0);
    await writeFile(join(fake, "log"), "");
  }
  const cleanup = async () => {
    const pid = Number(await readFile(join(root, "state/egress.pid"), "utf8").catch(() => ""));
    if (pid) spawnSync("kill", [String(pid)]);
    await rm(root, { recursive: true, force: true });
  };
  return { root, fake, repo, run, log, cleanup };
}

interface Box {
  root: string;
  log(): Promise<string[]>;
}

async function bootedName(s: Box) {
  const args = (await s.log()).find((c) => c.startsWith("run "))?.split(" ") ?? [];
  return args[args.indexOf("--name") + 1];
}

async function liveOtherSession(s: Box, name: string, t: { after(fn: () => void): void }) {
  const other = spawn("sleep", ["30"]);
  t.after(() => other.kill());
  await writeFile(join(s.root, "state", name, "sessions", String(other.pid)), "");
}

test("the first session boots a box with no network, a read-only root, and only the repo and home mounted, and stops it at exit", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SESSION/);
  const calls = await s.log();
  const boot = calls.find((c) => c.startsWith("run ")) ?? "";
  const args = boot.split(" ");
  assert.equal(args[args.indexOf("--network") + 1], "none", boot);
  assert.ok(args.includes("--read-only"), boot);
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "--mount"), [`type=bind,source=${s.repo},target=/repo,readonly`]);
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "--volume").map((v) => v.split(":")[1]), ["/home/agent", "/tmp/ug-egress.sock"], boot);
  const session = calls.find((c) => c.includes("ug-session")) ?? "";
  assert.match(session, /PI_PROXY=http:\/\/127\.0\.0\.1:3128/);
  const models = await readFile(join(s.fake, "models.yml"), "utf8");
  assert.match(models, /baseUrl: "http:\/\/gateway\.internal:4000"/);
  assert.match(models, /apiKey: "ug-placeholder"/);
  assert.ok(!args.some((a) => ["--ssh", "--cap-add", "-p", "--publish", "--publish-socket"].includes(a)), boot);
  assert.equal(calls.at(-1), `stop ${await bootedName(s)}`, "the box ran on after its last session");
});

test("a second session joins the running box, and the box stays up while another session runs", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(s.run().status, 0);
  const name = await bootedName(s);
  await writeFile(join(s.fake, "running"), `${name}\n`);
  await writeFile(join(s.fake, "log"), "");
  await liveOtherSession(s, name, t);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const calls = await s.log();
  assert.ok(!calls.some((c) => c.startsWith("run ")), "a second box was booted");
  assert.ok(!calls.some((c) => c.startsWith("stop ")), "the box stopped under a live session");
});

test("a box on an older image is not replaced while a session runs: the start refuses", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(s.run().status, 0);
  const name = await bootedName(s);
  await writeFile(join(s.fake, "running"), `${name}\n`);
  await writeFile(join(s.root, "state", name, "image"), "ugbox:old\n");
  await writeFile(join(s.fake, "log"), "");
  await liveOtherSession(s, name, t);
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /update waiting/);
  const calls = await s.log();
  assert.ok(!calls.some((c) => c.startsWith("stop ") || c.startsWith("run ") || c.includes("ug-session")), calls.join("\n"));
});

test("ug-box refuses outside a git repo, so no box ever mounts a folder that is not a repo", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const plain = join(s.root, "plain");
  await mkdir(plain);
  const r = s.run(plain);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not in a git repo/);
  assert.deepEqual(await s.log(), []);
});

test("ug-box refuses when the image for the current pins is not built, and boots nothing", async (t) => {
  const s = await setup(false);
  t.after(s.cleanup);
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not built[\s\S]*ug-box build/);
  assert.ok(!(await s.log()).some((c) => c.startsWith("run ") || c.startsWith("exec ")));
});

test("a box whose real settings fail the check gets no session, and is stopped", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const weak = inspectedBox("__NAME__", s.repo, "__REF__", join(s.root, "state/egress.sock"));
  weak.configuration.networks.push({ network: "default" });
  await writeFile(join(s.fake, "inspect.json"), JSON.stringify([weak]));
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /has a network[\s\S]*failed its check/);
  const calls = await s.log();
  assert.ok(!calls.some((c) => c.includes("ug-session")), "a session started in a box that failed its check");
  assert.equal(calls.at(-1), `stop ${await bootedName(s)}`);
});
