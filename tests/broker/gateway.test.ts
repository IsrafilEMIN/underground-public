import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAddresses } from "../../host/broker/gateway.ts";

const ADDRESSES = { gateway: "100.64.0.1:4000", engine: "100.64.0.2:8081" };

test("parseAddresses reads the gateway and the engine address, and refuses anything else", () => {
  assert.deepEqual(parseAddresses("# owner\ngateway=100.64.0.1:4000\n\nengine=100.64.0.2:8081\n"), { ok: true, value: ADDRESSES });
  const bad: [string, RegExp][] = [
    ["", /no gateway= line/],
    ["gateway=100.64.0.1:4000\n", /no engine= line/],
    ["gateway=100.64.0.1:4000\nengine=100.64.0.2:8081\ngateway=100.64.0.3:4000\n", /gateway= is given twice/],
    ["gateway=100.64.0.1\nengine=100.64.0.2:8081\n", /gateway=100\.64\.0\.1 is not <ip>:<port>/],
    ["gateway=100.64.0.1:4000\nengine=v100-server:8081\n", /engine=v100-server:8081 is not <ip>:<port>/],
    ["gateway=100.64.0.1:4000\nengine=100.64.0.256:8081\n", /is not <ip>:<port>/],
    ["gateway=100.64.0.1:0\nengine=100.64.0.2:8081\n", /is not <ip>:<port>/],
    ["gateway=100.64.0.1:4000\nengine=100.64.0.2:65536\n", /is not <ip>:<port>/],
    ["gateway=100.64.0.1:4000\nengine=100.64.0.2:8081\nproxy=1.2.3.4:5\n", /unknown line proxy=1\.2\.3\.4:5/],
  ];
  for (const [text, reason] of bad) {
    const parsed = parseAddresses(text);
    assert.equal(parsed.ok, false, text);
    if (!parsed.ok) assert.match(parsed.reason, reason, text);
  }
});
