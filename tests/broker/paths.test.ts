import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appFiles } from "../../host/gh-broker/github-app.ts";
import { defaultConfig, startServer, stopServer } from "../../host/gh-broker/server.ts";
import { defaultConfig as usageConfig } from "../../host/gh-broker/usage-broker.ts";
import { tempDir } from "../temp.ts";

const HOME = homedir();
const DATA = join(HOME, ".local/share/underground");

test("the gh-broker listens on /Library/Underground/run/gh-broker.sock and keeps every file in the data folder", () => {
  const { socketPath, reposRoot, reviewsDir, pushesDir, protectedDir, tempRoot } = defaultConfig();
  assert.equal(socketPath, "/Library/Underground/run/gh-broker.sock");
  for (const path of [reposRoot, reviewsDir, pushesDir, protectedDir, tempRoot]) {
    assert.ok(path.startsWith(`${DATA}/`), `${path} is outside the data folder`);
  }
});

test("the gh-broker app's key and config are in the data folder, and the usage broker reads root's addresses and its own user's token", () => {
  const app = appFiles(HOME);
  assert.deepEqual(app, { configFile: join(DATA, "github-app.json"), keyFile: join(DATA, "github-app.pem") });
  const usage = usageConfig();
  assert.equal(usage.addressesFile, "/Library/Underground/addresses");
  assert.equal(usage.gatewayTokenFile, join(HOME, ".omp/auth-gateway.token"));
});

test("the gh-broker socket is 0666 after it listens, so the agent user can connect", async () => {
  const root = await tempDir(join(tmpdir(), "ug-sock-"));
  const config = { ...defaultConfig(), socketPath: join(root, "run/gh-broker.sock") };
  const broker = await startServer(config);
  try {
    assert.equal((await stat(config.socketPath)).mode & 0o777, 0o666);
  } finally {
    await stopServer(broker);
  }
});
