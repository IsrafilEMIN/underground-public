import assert from "node:assert/strict";
import { test } from "node:test";
import { addGatewayBearer, isAllowed, readRules } from "../../host/egress/rules.ts";

const rules = readRules("gateway=100.64.0.1:4000\nengine=100.64.0.9:8081\n", "github.com\nregistry.npmjs.org # packages\n", "real-secret\n");

test("the egress door lets through only the mapped host services on their own port and the listed sites on 443", () => {
  for (const [host, port] of [["gateway.internal", 4000], ["usage.internal", 18765], ["github.com", 443], ["registry.npmjs.org", 443]] as const) {
    assert.ok(isAllowed(rules, port, host), `${host}:${port} was refused`);
  }
  for (const [host, port] of [
    ["gateway.internal", 443],
    ["usage.internal", 4000],
    ["other.internal", 4000],
    ["100.64.0.1", 4000],
    ["127.0.0.1", 8765],
    ["github.com", 80],
    ["example.com", 443],
    ["github.com.evil.test", 443],
  ] as const) {
    assert.ok(!isAllowed(rules, port, host), `${host}:${port} was let through`);
  }
});

test("the real gateway bearer replaces the box's placeholder only on calls to the gateway", () => {
  const toGateway = { authorization: "Bearer ug-placeholder" };
  addGatewayBearer(rules, toGateway, "gateway.internal:4000");
  assert.equal(toGateway.authorization, "Bearer real-secret");
  for (const host of ["usage.internal:18765", "github.com", "gateway.internal.evil.test"]) {
    const other = { authorization: "Bearer ug-placeholder" };
    addGatewayBearer(rules, other, host);
    assert.equal(other.authorization, "Bearer ug-placeholder", host);
  }
});

test("the egress door refuses to start on an allowlist entry that is not a plain site name", () => {
  for (const entry of ["100.64.0.1:4000", "10.0.0.1", "gateway.internal", "https://x.test"]) {
    assert.throws(() => readRules("gateway=100.64.0.1:4000\n", `${entry}\n`, "t"), /not a plain site name/, entry);
  }
  assert.throws(() => readRules("engine=1.2.3.4:1\n", "github.com\n", "t"), /gateway=/);
  assert.throws(() => readRules("gateway=100.64.0.1:4000\n", "github.com\n", "  \n"), /token is empty/);
});
