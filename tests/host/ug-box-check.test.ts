import assert from "node:assert/strict";
import { test } from "node:test";
import { boxProblems, type Inspected } from "../../host/bin/ug-box-check.ts";
import { inspectedBox } from "./fixtures/box-inspect.ts";

const want = { name: "ug-app-12345678", repo: "/Users/owner/app", tag: "ugbox:abc", egress: "/Users/owner/.local/state/underground/box/egress.sock" };
const box = () => inspectedBox(want.name, want.repo, `docker.io/library/${want.tag}`);

test("the box as the owner's real run reported it passes the check", () => {
  assert.deepEqual(boxProblems(box(), want), []);
});

test("the egress socket, when the inspect reply lists it, passes as the fourth mount", () => {
  const b = box();
  b.configuration.mounts.push({ destination: "/tmp/ug-egress.sock", options: [], source: want.egress, type: {} });
  assert.deepEqual(boxProblems(b, want), []);
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
    ["an extra mount", (b) => b.configuration.mounts.push({ destination: "/mac", options: [], source: "/Users/owner", type: { virtiofs: {} } }), /unexpected mounts/],
    ["a second mount on the repo path", (b) => b.configuration.mounts.push({ destination: "/repo", options: [], source: "/Users/owner", type: { virtiofs: {} } }), /unexpected mounts/],
    ["another socket as the egress door", (b) => b.configuration.mounts.push({ destination: "/tmp/ug-egress.sock", options: [], source: "/Users/owner/.ssh/agent.sock", type: {} }), /not the egress door/],
    ["a writable repo", (b) => { b.configuration.mounts[2].options = []; }, /read-only/],
    ["another folder as the repo", (b) => { b.configuration.mounts[2].source = "/Users/owner"; }, /read-only/],
    ["another box's home", (b) => { b.configuration.mounts[1].type = { volume: { name: "ug-other-home" } }; }, /own volume/],
    ["a stopped box", (b) => { b.status.state = "stopped"; }, /not running/],
  ];
  for (const [label, weaken, why] of cases) {
    const b = box();
    weaken(b);
    const problems = boxProblems(b, want);
    assert.ok(problems.some((p) => why.test(p)), `${label}: ${JSON.stringify(problems)}`);
  }
});
