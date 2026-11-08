import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appFiles } from "../../host/broker/github-app.ts";
import { defaultConfig, startServer, stopServer } from "../../host/broker/server.ts";
import { defaultConfig as usageConfig } from "../../host/broker/usage-broker.ts";
import { tempDir } from "../temp.ts";

const HOME = homedir();
const HOST = join(HOME, ".ug/host");

test("the broker listens on /Library/Underground/run/broker.sock and keeps every file in the host zone", () => {
  const { socketPath, reposRoot, reviewsDir, pushesDir, protectedDir, tempRoot } = defaultConfig();
  assert.equal(socketPath, "/Library/Underground/run/broker.sock");
  for (const path of [reposRoot, reviewsDir, pushesDir, protectedDir, tempRoot]) {
    assert.ok(path.startsWith(`${HOST}/`), `${path} is outside the host zone`);
  }
});

test("the broker app's key and config, and the usage broker's files, are in the host zone", () => {
  const app = appFiles(HOME);
  assert.deepEqual(app, { configFile: join(HOST, "github-app.json"), keyFile: join(HOST, "github-app.pem") });
  const usage = usageConfig();
  assert.equal(usage.addressesFile, join(HOST, "addresses"));
  assert.equal(usage.gatewayTokenFile, join(HOST, "auth/auth-gateway.token"));
});

test("the broker socket is 0666 after it listens, so the agent user can connect", async () => {
  const root = await tempDir(join(tmpdir(), "ug-sock-"));
  const config = { ...defaultConfig(), socketPath: join(root, "run/broker.sock") };
  const broker = await startServer(config);
  try {
    assert.equal((await stat(config.socketPath)).mode & 0o777, 0o666);
  } finally {
    await stopServer(broker);
  }
});
