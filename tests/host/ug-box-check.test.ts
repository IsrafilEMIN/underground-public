import assert from "node:assert/strict";
import { test } from "node:test";
import { boxProblems, type Inspected } from "../../host/bin/ug-box-check.ts";
import { inspectedBox } from "./fixtures/box-inspect.ts";

const want = {
  name: "ug-box",
  tag: "ugbox:abc",
  egress: "/Users/owner/.local/state/underground/box/egress.sock",
  broker: "/Users/owner/.ug/run/broker.sock",
};
const box = () => inspectedBox(want.name, `docker.io/library/${want.tag}`, want.egress, want.broker);

function mount(b: Inspected, destination: string) {
  const m = b.configuration.mounts.find((x) => x.destination === destination);
  assert.ok(m, destination);
  return m;
}

test("the box with its two doors and its own home passes the check", () => {
  assert.deepEqual(boxProblems(box(), want), []);
});

test("each weakened wall of the box fails the check", () => {
  const cases: [string, (b: Inspected) => void, RegExp][] = [
    ["a network", (b) => b.configuration.networks.push({ network: "default" }), /network/],
    ["a network at run time", (b) => b.status.networks.push({ network: "default" }), /network/],
    ["a writable root", (b) => { b.configuration.readOnly = false; }, /root is writable/],
    ["an added capability", (b) => b.configuration.capAdd.push("SYS_ADMIN"), /capabilities/],
    ["the ssh agent", (b) => { b.configuration.ssh = true; }, /ssh/],
    ["a published socket", (b) => b.configuration.publishedSockets.push({}), /published/],
    ["a published port", (b) => b.configuration.publishedPorts.push({}), /published/],
    ["another image", (b) => { b.configuration.image.reference = "docker.io/library/ugbox:old"; }, /image/],
    ["another first process", (b) => { b.configuration.initProcess.executable = "/bin/sh"; }, /first process/],
    ["a folder of the mac", (b) => b.configuration.mounts.push({ destination: "/repo", options: ["ro"], source: "/Users/owner/app", type: { virtiofs: {} } }), /unexpected mounts/],
    ["a second mount on a door path", (b) => b.configuration.mounts.push({ destination: "/tmp/ug-broker.sock", options: [], source: "/Users/owner", type: { virtiofs: {} } }), /unexpected mounts/],
    ["no egress door", (b) => { b.configuration.mounts = b.configuration.mounts.filter((m) => m.destination !== "/tmp/ug-egress.sock"); }, /egress door/],
    ["another socket as the egress door", (b) => { mount(b, "/tmp/ug-egress.sock").source = "/Users/owner/.ssh/agent.sock"; }, /egress door/],
    ["another socket as the broker door", (b) => { mount(b, "/tmp/ug-broker.sock").source = "/Users/owner/.ssh/agent.sock"; }, /broker door/],
    ["another box's home", (b) => { mount(b, "/home/agent").type = { volume: { name: "ug-other-home" } }; }, /own volume/],
    ["a stopped box", (b) => { b.status.state = "stopped"; }, /not running/],
  ];
  for (const [label, weaken, why] of cases) {
    const b = box();
    weaken(b);
    const problems = boxProblems(b, want);
    assert.ok(problems.some((p) => why.test(p)), `${label}: ${JSON.stringify(problems)}`);
  }
});
