import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";
import { inspectedBox } from "./fixtures/box-inspect.ts";

const SRC = join(import.meta.dirname, "../..");
const FAKE_CONTAINER = (await readFile(join(import.meta.dirname, "ug-box.test.ts"), "utf8")).match(/const FAKE = `([\s\S]*?)`;/)?.[1] ?? "";

test("the installed ug-box runs with the checkout gone: setup copied everything it reads", async (t) => {
  const root = await tempDir(join(tmpdir(), "ug-box-inst-"));
  t.after(async () => {
    for (const server of [brokerServer, egressServer]) {
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const checkout = join(root, "checkout");
  for (const f of ["host/bin/ug-setup", "host/bin/ug-box", "host/bin/ug-box-restore", "host/bin/ug-box-check.ts", "host/lib/box-image.bash", "host/lib/backup-target.bash", "host/secret-patterns", "host/broker/client.ts", "host/broker/protocol.ts", "VERSIONS", "box"]) {
    await cp(join(SRC, f), join(checkout, f), { recursive: true });
  }
  const sys = join(root, "sys");
  const install = spawnSync("bash", ["-c", `
    set -euo pipefail
    src=${JSON.stringify(checkout)}
    sys=${JSON.stringify(sys)}
    cleanup=()
    install -d -m 700 "$sys" "$sys/bin"
    eval "$(sed -n '/^put() {/,/^}/p;/^link() {/,/^}/p;/^install_ug_box() {/,/^}/p' "$src/host/bin/ug-setup")"
    install_ug_box
  `], { encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  await rm(checkout, { recursive: true, force: true });

  const bin = join(root, "bin");
  const fake = join(root, "fake");
  const repo = join(root, "app");
  await mkdir(bin, { recursive: true });
  await mkdir(fake);
  await writeFile(join(bin, "container"), FAKE_CONTAINER);
  await chmod(join(bin, "container"), 0o755);
  spawnSync("git", ["init", "-q", repo]);
  spawnSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:owner/app.git"]);
  const ug = join(root, "ug");
  await mkdir(join(ug, "host"), { recursive: true });
  const cfg = join(root, "cfg");
  spawnSync("git", ["init", "-q", cfg]);
  await writeFile(join(cfg, "models.yml"), 'providers:\n  gw:\n    baseUrl: "http://@GATEWAY@"\n    apiKey: "@GATEWAY_TOKEN@"\n');
  spawnSync("git", ["-C", cfg, "add", "-A"]);
  spawnSync("git", ["-C", cfg, "-c", "user.email=o@x", "-c", "user.name=o", "commit", "-q", "-m", "c"]);
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
  const build = spawnSync("bash", ["-c", `source "${sys}/box/host/lib/box-image.bash" && box_image_build "${sys}/box"`], { env, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const r = spawnSync("bash", [join(sys, "bin/ug-box")], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SESSION/);
});
