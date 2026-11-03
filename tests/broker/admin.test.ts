import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { bindingRepoId, sessionRepo } from "../../host/broker/admin.ts";
import { isBindingPart } from "../../host/broker/protocol.ts";
import { tempDir } from "../temp.ts";

const SRC = join(import.meta.dirname, "../..");
const ADMIN = join(SRC, "host/broker/admin.ts");

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
