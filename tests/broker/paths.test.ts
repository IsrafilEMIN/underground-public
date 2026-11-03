import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appFiles } from "../../host/broker/github-app.ts";
import { defaultConfig } from "../../host/broker/server.ts";
import { defaultConfig as usageConfig } from "../../host/broker/usage-broker.ts";

// Where the host services keep their files (docs/PRODUCT-BRIEF.md, zones). The sandbox may use the
// one socket in ~/.ug/run but not write there, and gets nothing at all in the host zone ~/.ug/host.
// A file that drifts into the arena ~/.ug/home, or back into ~/.agents or ~/.config, fails here.

const HOME = homedir();
const HOST = join(HOME, ".ug/host");

test("the broker listens on ~/.ug/run/broker.sock and keeps every file in the host zone", () => {
  const { socketPath, reposRoot, reviewsDir, legacyReviewsFile, pushesDir, protectedDir, tempRoot } = defaultConfig();
  assert.equal(socketPath, join(HOME, ".ug/run/broker.sock"));
  for (const path of [reposRoot, reviewsDir, legacyReviewsFile, pushesDir, protectedDir, tempRoot]) {
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
