import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
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
  "exec "*) case "$*" in *ug-session*) echo "SESSION";; *ug-config*) rm -rf "$FAKE/config"; mkdir "$FAKE/config"; tar -x -C "$FAKE/config" -f - ;; esac ;;
  "inspect "*) sed -e "s|__NAME__|$2|g" -e "s|__REF__|$(tail -n 1 "$FAKE/images")|g" "$FAKE/inspect.json" ;;
esac
`;

function commit(repo: string) {
  spawnSync("git", ["-C", repo, "add", "-A"]);
  spawnSync("git", ["-C", repo, "-c", "user.email=o@x", "-c", "user.name=o", "commit", "-q", "-m", "c"]);
}

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
  spawnSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:owner/app.git"]);
  const ug = join(root, "ug");
  await mkdir(join(ug, "host"), { recursive: true });
  const cfg = join(root, "cfg");
  spawnSync("git", ["init", "-q", cfg]);
  await mkdir(join(cfg, "skills/fix-bug"), { recursive: true });
  await writeFile(join(cfg, "models.yml"), 'providers:\n  gw:\n    baseUrl: "http://@GATEWAY@"\n    apiKey: "@GATEWAY_TOKEN@"\n');
  await writeFile(join(cfg, "AGENTS.md"), "# owner rules\n");
  await writeFile(join(cfg, "skills/fix-bug/SKILL.md"), "fix the bug\n");
  await writeFile(join(cfg, "notes.txt"), "not a config name\n");
  commit(cfg);
  await writeFile(join(ug, "host/config-repo"), "~/cfg\n");
  await writeFile(join(ug, "host/addresses"), "gateway=100.64.0.1:4000\n");
  const broker = join(root, "broker.sock");
  const brokerServer = createServer().listen(broker);
  await once(brokerServer, "listening");
  const egress = join(root, "egress.sock");
  const egressServer = createServer().listen(egress);
  await once(egressServer, "listening");
  const env = {
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    FAKE: fake,
    UG_DIR: ug,
    UG_BOX_STATE: join(root, "state"),
    UG_BOX_LOCK_WAIT: "1",
    UG_BOX_NODE: process.execPath,
    UG_BOX_EGRESS_SOCKET: egress,
    UG_BOX_READY_WAIT: "1",
    UG_BOX_BROKER: broker,
  };
  await writeFile(join(fake, "inspect.json"), JSON.stringify([inspectedBox("__NAME__", "__REF__", egress, broker)]));
  const run = (cwd = repo, ...args: string[]) => spawnSync("bash", [UG_BOX, ...args], { cwd, env, encoding: "utf8" });
  const log = async () => (await readFile(join(fake, "log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  if (built) {
    assert.equal(run(repo, "build").status, 0);
    await writeFile(join(fake, "log"), "");
  }
  const cleanup = async () => {
    for (const server of [brokerServer, egressServer]) {
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
    }
    await rm(root, { recursive: true, force: true });
  };
  return { root, fake, repo, cfg, egress, broker, brokerServer, egressServer, run, log, cleanup };
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

test("the first session boots a box with no network, a read-only root, and only its home and the two doors, and stops it at exit", async (t) => {
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
  assert.ok(!args.includes("--mount"), `a mac folder is mounted: ${boot}`);
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "--volume"), ["ug-box-home:/home/agent", `${s.egress}:/tmp/ug-egress.sock`, `${s.broker}:/tmp/ug-broker.sock`], boot);
  assert.ok(!args.some((a) => ["--ssh", "--cap-add", "-p", "--publish", "--publish-socket"].includes(a)), boot);
  const session = calls.find((c) => c.includes("ug-session")) ?? "";
  assert.match(session, /UG_REPO=owner\/app /);
  assert.match(session, /PI_PROXY=http:\/\/127\.0\.0\.1:3128/);
  const models = await readFile(join(s.fake, "config/models.yml"), "utf8");
  assert.match(models, /baseUrl: "http:\/\/gateway\.internal:4000"/);
  assert.match(models, /apiKey: "ug-placeholder"/);
  assert.equal(calls.at(-1), "stop ug-box", "the box ran on after its last session");
});

test("the box gets the config repo's last commit, only the config names, and none of its uncommitted work", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await writeFile(join(s.cfg, "AGENTS.md"), "# half-done edit\n");
  await writeFile(join(s.cfg, "RULES.md"), "untracked\n");
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not committed; the box gets its last commit/);
  assert.equal(await readFile(join(s.fake, "config/AGENTS.md"), "utf8"), "# owner rules\n");
  assert.equal(await readFile(join(s.fake, "config/skills/fix-bug/SKILL.md"), "utf8"), "fix the bug\n");
  for (const absent of ["RULES.md", "notes.txt", ".git"]) {
    await assert.rejects(readFile(join(s.fake, "config", absent)), `${absent} reached the box`);
  }
});

test("a committed link, token, or auth bearer in the config repo stops the start before any session", async (t) => {
  for (const [label, plant, why] of [
    ["a link", (cfg: string) => symlink("/etc/passwd", join(cfg, "skills/fix-bug/key")), /link or a special file/],
    ["a GitHub token", (cfg: string) => writeFile(join(cfg, "AGENTS.md"), `token: ghp_${"b".repeat(36)}\n`), /holds a token/],
    ["the gateway bearer", (cfg: string) => writeFile(join(cfg, "models.yml"), 'providers:\n  gw:\n    baseUrl: "http://@GATEWAY@"\n    apiKey: "gateway-bearer-1234567890"\n'), /holds a token/],
    ["the auth broker's bearer", (cfg: string) => writeFile(join(cfg, "skills/fix-bug/SKILL.md"), "use broker-bearer-1234567890\n"), /holds a token/],
  ] as const) {
    const s = await setup();
    t.after(s.cleanup);
    await mkdir(join(s.root, "ug/host/auth"), { recursive: true });
    await writeFile(join(s.root, "ug/host/auth/auth-gateway.token"), "gateway-bearer-1234567890\n");
    await writeFile(join(s.root, "ug/host/auth/auth-broker.token"), "broker-bearer-1234567890\n");
    await plant(s.cfg);
    commit(s.cfg);
    const r = s.run();
    assert.notEqual(r.status, 0, label);
    assert.match(r.stderr, why, label);
    assert.ok(!(await s.log()).some((c) => c.includes("ug-session") || c.includes("ug-config")), label);
  }
});

test("outside a repo the session starts in the box with no repo, and a repo without a GitHub origin is refused", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const plain = join(s.root, "plain");
  await mkdir(plain);
  const r = s.run(plain);
  assert.equal(r.status, 0, r.stderr);
  assert.match((await s.log()).find((c) => c.includes("ug-session")) ?? "", /UG_REPO= /);
  spawnSync("git", ["-C", s.repo, "remote", "set-url", "origin", "https://gitlab.com/owner/app.git"]);
  await writeFile(join(s.fake, "log"), "");
  const bad = s.run();
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /no GitHub origin/);
  assert.ok(!(await s.log()).some((c) => c.startsWith("run ") || c.startsWith("exec ")));
});

test("ug-box refuses when the egress door is not running, and boots nothing", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  s.egressServer.close();
  await once(s.egressServer, "close");
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /egress door is not running[\s\S]*launchd/);
  assert.ok(!(await s.log()).some((c) => c.startsWith("run ") || c.startsWith("exec ")));
});

test("ug-box refuses when the GitHub broker is not running, and boots nothing", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  s.brokerServer.close();
  await once(s.brokerServer, "close");
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /broker is not running/);
  assert.ok(!(await s.log()).some((c) => c.startsWith("run ") || c.startsWith("exec ")));
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
  const weak = inspectedBox("__NAME__", "__REF__", s.egress, s.broker);
  weak.configuration.networks.push({ network: "default" });
  await writeFile(join(s.fake, "inspect.json"), JSON.stringify([weak]));
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /has a network[\s\S]*failed its check/);
  const calls = await s.log();
  assert.ok(!calls.some((c) => c.includes("ug-session")), "a session started in a box that failed its check");
  assert.equal(calls.at(-1), "stop ug-box");
});
