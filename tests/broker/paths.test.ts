import assert from "node:assert/strict";
import { rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readHostFacts } from "../../host/gh-broker/facts.ts";
import { defaultConfig, startServer, stopServer } from "../../host/gh-broker/server.ts";
import { defaultConfig as usageConfig } from "../../host/gh-broker/usage-broker.ts";
import { tempDir } from "../temp.ts";

const HOME = homedir();
const FACTS = readHostFacts();

test("the gh-broker keeps its key, mirrors, and records in its own user's home, and its socket, status, and protected paths under the install root", () => {
  const { socketPath, statusFile, protectedDir, reposRoot, reviewsDir, pushesDir, tempRoot, home, ghPath, gitPath } = defaultConfig("/pinned/gh");
  assert.equal(socketPath, join(FACTS.root, "run/gh-broker.sock"));
  assert.equal(statusFile, join(FACTS.root, "run/gh-broker.status"));
  assert.equal(protectedDir, join(FACTS.root, "code/protected-paths"));
  assert.deepEqual([reposRoot, reviewsDir, pushesDir, tempRoot], ["repos", "reviews", "pushes", "tmp"].map((name) => join(HOME, name)));
  assert.equal(home, HOME);
  assert.equal(ghPath, "/pinned/gh");
  assert.equal(gitPath, "/usr/bin/git");
  assert.throws(() => defaultConfig("gh"), /not absolute/);
});

test("the usage broker reads root's addresses and its own user's token", () => {
  const usage = usageConfig();
  assert.equal(usage.addressesFile, join(FACTS.root, "code/addresses"));
  assert.equal(usage.gatewayTokenFile, join(HOME, ".omp/auth-gateway.token"));
});

test("the host facts reader refuses a facts file that lacks a value or has a bad port", async (t) => {
  const dir = await tempDir(join(tmpdir(), "ug-facts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "facts");
  await writeFile(file, "root=/r\nowner_data=d\ngh_broker_socket=run/s.sock\ngh_broker_status=run/s.status\n");
  assert.throws(() => readHostFacts(file), /has no usage_broker_port/);
  await writeFile(file, "root=/r\nowner_data=d\ngh_broker_socket=run/s.sock\ngh_broker_status=run/s.status\nusage_broker_port=99999\n");
  assert.throws(() => readHostFacts(file), /not a port/);
  await writeFile(file, "root=/r\nowner_data=d\ngh_broker_socket=run/s.sock\ngh_broker_status=run/s.status\nusage_broker_port=1\n");
  assert.deepEqual(readHostFacts(file), { root: "/r", ownerData: "d", ghBrokerSocket: "/r/run/s.sock", ghBrokerStatus: "/r/run/s.status", usageBrokerPort: 1 });
});

test("the gh-broker socket is 0660 after it listens, so only its owner and the group of its folder can connect", async () => {
  const root = await tempDir(join(tmpdir(), "ug-sock-"));
  const config = { ...defaultConfig("/unused/gh"), socketPath: join(root, "run/gh-broker.sock"), statusFile: join(root, "status") };
  const broker = await startServer(config);
  try {
    assert.equal((await stat(config.socketPath)).mode & 0o777, 0o660);
  } finally {
    await stopServer(broker);
  }
});
