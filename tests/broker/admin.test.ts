import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { bindingRepoId, lookupRole, roleConfigRefusal, sessionRepo } from "../../host/broker/admin.ts";
import { renderModels } from "../../host/broker/gateway.ts";
import { isBindingPart } from "../../host/broker/protocol.ts";
import { tempDir } from "../temp.ts";

const SRC = join(import.meta.dirname, "../..");
const ADMIN = join(SRC, "host/broker/admin.ts");
const ADDRESSES = { gateway: "100.64.0.1:4000", engine: "100.64.0.2:8081" };

type Run = { status: number | null; stdout: string; stderr: string };

async function admin(home: string, ...args: string[]): Promise<Run> {
  const child = spawn(process.execPath, [ADMIN, ...args], { env: { HOME: home, PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const [status] = (await once(child, "close")) as [number | null];
  return { status, stdout, stderr };
}

async function put(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode });
}


async function gitFolder(originUrl: string | undefined): Promise<string> {
  const folder = await tempDir(join(tmpdir(), "uga-repo-"));
  const origin = originUrl === undefined ? "" : `[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  await put(join(folder, ".git/config"), `[core]\n\tbare = false\n${origin}`);
  return folder;
}

// sessionRepo

test("a session repo is the listed spelling of a GitHub origin that matches it in any case", async () => {
  const folder = await gitFolder("https://github.com/owner/REPO.git");
  const repos = join(await tempDir(join(tmpdir(), "uga-")), "repos");
  await put(repos, "other/x\nOwner/Repo\n");
  assert.equal(await sessionRepo(folder, repos), "Owner/Repo");
});

test("a folder whose origin is not listed, is not on GitHub, or has no origin has no session repo", async () => {
  const repos = join(await tempDir(join(tmpdir(), "uga-")), "repos");
  await put(repos, "other/x\n");
  assert.equal(await sessionRepo(await gitFolder("https://github.com/owner/repo.git"), repos), undefined, "unlisted");
  await put(repos, "owner/repo\n");
  assert.equal(await sessionRepo(await gitFolder("https://gitlab.com/owner/repo.git"), repos), undefined, "not GitHub");
  assert.equal(await sessionRepo(await gitFolder(undefined), repos), undefined, "no origin");
});

test("a folder with no .git/config, or a missing repos file, has no session repo", async () => {
  const repos = join(await tempDir(join(tmpdir(), "uga-")), "repos");
  await put(repos, "owner/repo\n");
  assert.equal(await sessionRepo(await tempDir(join(tmpdir(), "uga-plain-")), repos), undefined, "no .git/config");
  const listed = await gitFolder("https://github.com/owner/repo.git");
  assert.equal(await sessionRepo(listed, join(dirname(repos), "missing")), undefined, "no repos file");
});

// lookupRole

test("a role lookup refuses when the roles file is unreadable or malformed", async () => {
  const dir = await tempDir(join(tmpdir(), "uga-"));
  const missing = await lookupRole("author", join(dir, "roles"));
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.reason, /cannot read the roles file/);
  await put(join(dir, "roles"), "author author\nBad Name author\n");
  const malformed = await lookupRole("author", join(dir, "roles"));
  assert.equal(malformed.ok, false);
  assert.match(malformed.ok ? "" : malformed.reason, /roles file line 2/);
});

// bindingRepoId

const hashOf = (folder: string): string => createHash("sha256").update(folder).digest("hex").slice(0, 8);

test("a binding repo id keeps two folders of one name apart and is stable for one folder", () => {
  const a = bindingRepoId("/work/a/app", "/r", hashOf("/work/a/app"));
  const b = bindingRepoId("/work/b/app", "/r", hashOf("/work/b/app"));
  assert.match(a, /^app-[0-9a-f]{8}$/);
  assert.match(b, /^app-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.equal(bindingRepoId("/work/a/app", "/r", hashOf("/work/a/app")), a);
});

test("a binding repo id is a safe binding part for any folder name", () => {
  const cases: [string, RegExp][] = [
    ["/w/my repo.v2", /^my-repo-v2-[0-9a-f]{8}$/],
    ["/w/.hidden", /^hidden-[0-9a-f]{8}$/],
    ["/w/...", /^[0-9a-f]{8}$/],
  ];
  for (const [folder, want] of cases) {
    const id = bindingRepoId(folder, "/r", hashOf(folder));
    assert.match(id, want, folder);
    assert.ok(isBindingPart(id), `${folder} → ${id}`);
  }
});

// role config check (run by start-session)

async function roleConfig(): Promise<string> {
  const dir = await tempDir(join(tmpdir(), "uga-role-"));
  await put(join(dir, "policy.yml"), await readFile(join(SRC, "host/roles/policy.yml"), "utf8"));
  const rendered = renderModels(await readFile(join(SRC, "host/roles/models.yml"), "utf8"), ADDRESSES, "t0ken");
  assert.ok(rendered.ok);
  await put(join(dir, "models.yml"), rendered.value);
  return dir;
}

const OUTSIDE_AGENT = "---\nname: helper\nmodel: web/perplexity\n---\nHelp.\n";

test("the role config check reads agents/*.md and refuses an agent model outside the gateway, and ignores other files", async () => {
  const dir = await roleConfig();
  await put(join(dir, "agents/notes.txt"), OUTSIDE_AGENT);
  assert.equal(await roleConfigRefusal(join(dir, "policy.yml")), undefined);
  await put(join(dir, "agents/helper.md"), OUTSIDE_AGENT);
  assert.match((await roleConfigRefusal(join(dir, "policy.yml"))) ?? "", /agents\/helper\.md model: web\/perplexity is not a model of a gateway provider/);
});

test("the role config check refuses an unreadable or unparsable policy.yml, and an unparsable models.yml", async () => {
  const dir = await roleConfig();
  assert.match((await roleConfigRefusal(join(dir, "absent.yml"))) ?? "", /cannot read \S*absent\.yml/);
  const policy = await readFile(join(dir, "policy.yml"), "utf8");
  await put(join(dir, "policy.yml"), `${policy}broken:\n\tvalue: x\n`);
  assert.match((await roleConfigRefusal(join(dir, "policy.yml"))) ?? "", /policy\.yml: /);
  await put(join(dir, "policy.yml"), policy);
  const models = await readFile(join(dir, "models.yml"), "utf8");
  await put(join(dir, "models.yml"), `${models}broken:\n\tvalue: x\n`);
  assert.match((await roleConfigRefusal(join(dir, "policy.yml"))) ?? "", /models\.yml: /);
});

test("the role config check refuses a wrong pin value without the restore hint that a missing pin gets", async () => {
  const dir = await roleConfig();
  const policy = await readFile(join(dir, "policy.yml"), "utf8");
  assert.match(policy, /^ {2}backend: off$/m);
  await put(join(dir, "policy.yml"), policy.replace(/^ {2}backend: off$/m, "  backend: local"));
  const refusal = (await roleConfigRefusal(join(dir, "policy.yml"))) ?? "";
  assert.match(refusal, /it must set memory\.backend: off, not "local"/);
  assert.doesNotMatch(refusal, /run ug-install/);
});

// addresses

test("an addresses file that cannot be read for a reason other than absence fails with that reason, not as missing", async () => {
  const home = await tempDir(join(tmpdir(), "uga-home-"));
  await mkdir(join(home, ".config/underground-broker/addresses"), { recursive: true });
  const run = await admin(home, "addresses");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /EISDIR/);
  assert.doesNotMatch(run.stderr, /is missing/);
});

// gateway-setup

async function setupHome(roles: string): Promise<string> {
  const home = await tempDir(join(tmpdir(), "uga-home-"));
  for (const file of ["policy.yml", "models.yml"]) {
    await put(join(home, ".agents/roles", file), await readFile(join(SRC, "host/roles", file), "utf8"));
  }
  await put(join(home, ".config/underground-broker/roles"), roles, 0o600);
  await put(join(home, ".config/underground-broker/addresses"), `gateway=${ADDRESSES.gateway}\nengine=${ADDRESSES.engine}\n`, 0o600);
  return home;
}

const agentFile = (home: string, file: string): string => join(home, ".ug/omp/agent", file);

test("gateway-setup writes the one policy.yml and models.yml of every role, readable by the owner only", async () => {
  const home = await setupHome("author author\nsec2 security-review\n");
  const run = await admin(home, "gateway-setup");
  assert.equal(run.status, 0, run.stderr);
  for (const file of ["policy.yml", "models.yml"]) {
    assert.equal((await stat(agentFile(home, file))).mode & 0o777, 0o600, file);
  }
  assert.match(run.stdout, /gateway-setup: author, sec2: /);
});

test("two fresh setups make two different gateway tokens", async () => {
  const tokens: string[] = [];
  for (let i = 0; i < 2; i++) {
    const home = await setupHome("author author\n");
    const run = await admin(home, "gateway-setup");
    assert.equal(run.status, 0, run.stderr);
    tokens.push((await readFile(join(home, ".omp/auth-gateway.token"), "utf8")).trim());
  }
  assert.match(tokens[0], /^[0-9a-f]{64}$/);
  assert.match(tokens[1], /^[0-9a-f]{64}$/);
  assert.notEqual(tokens[0], tokens[1]);
});

test("gateway-setup fails with the real cause when the token cannot be created, and renders no role", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
  const home = await setupHome("author author\n");
  await mkdir(join(home, ".omp"), { mode: 0o500 });
  t.after(() => chmod(join(home, ".omp"), 0o700));
  const run = await admin(home, "gateway-setup");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /EACCES/);
  await assert.rejects(stat(agentFile(home, "models.yml")));
});

test("gateway-setup refuses a malformed roles table and sets up no role", async () => {
  const home = await setupHome("author author\nBad Name author\n");
  const run = await admin(home, "gateway-setup");
  assert.equal(run.status, 2);
  assert.match(run.stderr, /roles file line 2/);
  await assert.rejects(readdir(join(home, ".ug/omp")));
});

test("gateway-setup refuses a models.yml template with an unknown placeholder and writes no models.yml", async () => {
  const home = await setupHome("author author\n");
  const template = await readFile(join(home, ".agents/roles/models.yml"), "utf8");
  await put(join(home, ".agents/roles/models.yml"), template.replace('"@GATEWAY_TOKEN@"', '"@GATEWAY_SECRET@"'));
  const run = await admin(home, "gateway-setup");
  assert.equal(run.status, 2);
  assert.match(run.stderr, /models\.yml: unknown placeholder @GATEWAY_SECRET@/);
  await assert.rejects(stat(agentFile(home, "models.yml")));
});

test("a second gateway-setup re-renders models.yml after the gateway address or the token changes", async () => {
  const home = await setupHome("author author\n");
  assert.equal((await admin(home, "gateway-setup")).status, 0);
  const firstToken = (await readFile(join(home, ".omp/auth-gateway.token"), "utf8")).trim();
  assert.match(await readFile(agentFile(home, "models.yml"), "utf8"), /http:\/\/100\.64\.0\.1:4000"/);

  await put(join(home, ".config/underground-broker/addresses"), `gateway=100.64.0.9:4001\nengine=${ADDRESSES.engine}\n`, 0o600);
  await rm(join(home, ".omp/auth-gateway.token"));
  const rerun = await admin(home, "gateway-setup");
  assert.equal(rerun.status, 0, rerun.stderr);
  const secondToken = (await readFile(join(home, ".omp/auth-gateway.token"), "utf8")).trim();
  assert.notEqual(secondToken, firstToken);
  const models = await readFile(agentFile(home, "models.yml"), "utf8");
  assert.match(models, /http:\/\/100\.64\.0\.9:4001"/);
  assert.doesNotMatch(models, /100\.64\.0\.1:4000/);
  assert.ok(models.includes(`"${secondToken}"`), "the new token is in models.yml");
  assert.ok(!models.includes(firstToken), "the old token is gone");
});

// main: register and session through a fake admin socket

type FakeBroker = { requests: unknown[]; close: () => void };

async function fakeBroker(home: string, reply: unknown): Promise<FakeBroker> {
  const socketPath = join(home, ".agents/broker/run/admin.sock");
  await mkdir(dirname(socketPath), { recursive: true });
  const requests: unknown[] = [];
  const server = createServer((socket) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (!text.includes("\n")) return;
      requests.push(JSON.parse(text));
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return { requests, close: () => server.close() };
}

// Like roles.test.ts: the role sandbox allows unix sockets under XDG_STATE_HOME, not under TMPDIR.
async function withBroker(reply: unknown, run: (home: string, broker: FakeBroker) => Promise<void>): Promise<void> {
  const home = await tempDir(join(process.env.XDG_STATE_HOME ?? tmpdir(), "uga-"));
  const broker = await fakeBroker(home, reply);
  try {
    await run(home, broker);
  } finally {
    broker.close();
    await rm(home, { recursive: true, force: true });
  }
}

const REGISTER = ["register", "r-1", "author", "o/r"];
const REGISTER_REQUEST = { verb: "register", repo_id: "r-1", role_name: "author", repo: "o/r" };

test("admin register sends the binding to the broker and prints the socket it gets back", async () => {
  await withBroker({ exit: 0, stdout: "", stderr: "", socket: "/run/r-1/author.sock" }, async (home, broker) => {
    const run = await admin(home, ...REGISTER);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "/run/r-1/author.sock\n");
    assert.deepEqual(broker.requests, [REGISTER_REQUEST]);
  });
});

test("admin with an unknown verb or a wrong argument count prints usage, exits 64, and sends nothing", async () => {
  await withBroker({ exit: 0, stdout: "", stderr: "", socket: "/s.sock" }, async (home, broker) => {
    for (const argv of [[], ["bogus"], ["register", "r-1", "author"], ["session", "/tmp"], ["role"], ["addresses", "x"]]) {
      const run = await admin(home, ...argv);
      assert.equal(run.status, 64, argv.join(" "));
      assert.match(run.stderr, /^usage:/, argv.join(" "));
    }
    assert.deepEqual(broker.requests, []);
  });
});

test("admin register with an invalid repo id, role name, or repo exits 64 and sends nothing", async () => {
  await withBroker({ exit: 0, stdout: "", stderr: "", socket: "/s.sock" }, async (home, broker) => {
    for (const [argv, reason] of [
      [["register", "../x", "author", "o/r"], /invalid repo id/],
      [["register", "r-1", "Author", "o/r"], /invalid role name/],
      [["register", "r-1", "author", "not-a-repo"], /invalid repo/],
    ] as const) {
      const run = await admin(home, ...argv);
      assert.equal(run.status, 64, argv.join(" "));
      assert.match(run.stderr, reason);
    }
    assert.deepEqual(broker.requests, []);
  });
});

test("admin register exits 69 when no broker answers", async () => {
  const home = await tempDir(join(tmpdir(), "uga-"));
  const run = await admin(home, ...REGISTER);
  assert.equal(run.status, 69);
  assert.match(run.stderr, /cannot reach broker/);
  assert.equal(run.stdout, "");
});

test("admin register exits 2 with the reason when the broker refuses", async () => {
  await withBroker({ exit: 2, refused: "role name author is not in the roles file" }, async (home, broker) => {
    const run = await admin(home, ...REGISTER);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /refused: role name author is not in the roles file/);
    assert.equal(run.stdout, "");
    assert.deepEqual(broker.requests, [REGISTER_REQUEST]);
  });
});

test("admin register passes on a failing broker exit and its stderr", async () => {
  await withBroker({ exit: 3, stdout: "", stderr: "bindings file is corrupt\n" }, async (home) => {
    const run = await admin(home, ...REGISTER);
    assert.equal(run.status, 3);
    assert.match(run.stderr, /bindings file is corrupt/);
    assert.equal(run.stdout, "");
  });
});

test("admin register exits 1 when the broker's reply names no absolute socket", async () => {
  for (const reply of [{ exit: 0, stdout: "", stderr: "" }, { exit: 0, stdout: "", stderr: "", socket: "relative.sock" }]) {
    await withBroker(reply, async (home) => {
      const run = await admin(home, ...REGISTER);
      assert.equal(run.status, 1, JSON.stringify(reply));
      assert.match(run.stderr, /no socket/);
      assert.equal(run.stdout, "");
    });
  }
});

test("admin session in a repo that is not listed exits 0, prints nothing, and registers nothing", async () => {
  await withBroker({ exit: 0, stdout: "", stderr: "", socket: "/s.sock" }, async (home, broker) => {
    await put(join(home, ".config/underground-broker/repos"), "other/x\n");
    const folder = await gitFolder("https://github.com/owner/repo.git");
    const run = await admin(home, "session", folder, "author");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.deepEqual(broker.requests, []);
  });
});
