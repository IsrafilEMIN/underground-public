import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { access, chmod, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { appFiles, appJwt, createAppTokens, redactTokens } from "../../host/broker/github-app.ts";
import type { AppFiles, Fetch, GithubTokens } from "../../host/broker/github-app.ts";
import type { Reply } from "../../host/broker/protocol.ts";
import { defaultConfig } from "../../host/broker/server.ts";
import type { ServerConfig } from "../../host/broker/server.ts";
import { FAKE_TOKEN, fakeTokens, tokenRemote } from "./fake-app.ts";
import { handleAs } from "./session.ts";
import type { Session } from "./session.ts";
import { tempDir } from "../temp.ts";

const REPO = "o/r";
const AUTHOR: Session = { role: "author" };
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const NOW = Date.parse("2026-10-31T12:00:00Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let root: string;
let files: AppFiles;

type Call = { url: string; method: string; authorization: string; body: unknown };

function decodePart(part: string | undefined): unknown {
  return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));
}

function jwtVerifies(jwt: string, key: string | KeyObject): boolean {
  const [header, payload, signature] = jwt.split(".");
  return verify("sha256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature ?? "", "base64url"));
}

function fakeGithub(options: { tokens: string[]; installation?: number; status?: number; now?: () => number }): { fetch: Fetch; calls: Call[] } {
  let minted = 0;
  return githubAnswering((url) => {
    if (url === `https://api.github.com/repos/${REPO}/installation`) {
      return Response.json(options.installation === undefined ? { message: "Not Found" } : { id: options.installation }, { status: options.installation === undefined ? 404 : 200 });
    }
    if (options.status !== undefined) return Response.json({ message: "A JSON web token could not be decoded" }, { status: options.status });
    const token = options.tokens[minted++];
    const mintedAt = options.now?.() ?? NOW;
    return Response.json({ token, expires_at: new Date(mintedAt + 60 * 60 * 1000).toISOString() }, { status: 201 });
  });
}

function githubAnswering(answer: (url: string) => Response): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? "GET", authorization: headers.get("authorization") ?? "", body });
    return answer(url);
  };
  return { fetch, calls };
}

async function writeApp(config: Record<string, unknown>, keyMode = 0o600): Promise<void> {
  await writeFile(files.configFile, JSON.stringify(config));
  await writeFile(files.keyFile, privateKey, { mode: keyMode });
  await chmod(files.keyFile, keyMode);
}

beforeEach(async () => {
  root = await tempDir(join(tmpdir(), "ug-app-"));
  files = { configFile: join(root, "github-app.json"), keyFile: join(root, "github-app.pem") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the app JWT is RS256, names the client id as iss, and lives from one minute ago to nine minutes ahead", () => {
  const jwt = appJwt({ clientId: "Iv23liABC", privateKey, nowSeconds: 1_000_000 });
  const [header, payload] = jwt.split(".");
  assert.deepEqual(decodePart(header), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodePart(payload), { iat: 999_940, exp: 1_000_540, iss: "Iv23liABC" });
  assert.ok(jwtVerifies(jwt, publicKey), "the signature verifies with the app's public key");
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
  assert.ok(!jwtVerifies(jwt, other), "the signature does not verify with another key");
});

test("a token is minted for the configured installation, narrowed to the request's repo, with a signed JWT", async () => {
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  const github = fakeGithub({ tokens: [FAKE_TOKEN] });
  const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
  assert.equal(await tokens.token(REPO, new AbortController().signal), FAKE_TOKEN);
  assert.equal(github.calls.length, 1);
  const [call] = github.calls;
  assert.equal(call?.url, "https://api.github.com/app/installations/42/access_tokens");
  assert.equal(call?.method, "POST");
  assert.deepEqual(call?.body, { repositories: ["r"] });
  const jwt = call?.authorization.replace(/^Bearer /, "") ?? "";
  assert.ok(jwtVerifies(jwt, publicKey));
  assert.deepEqual(decodePart(jwt.split(".")[1]), { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: "Iv23liABC" });
});

test("without installation_id the installation is looked up from the repo", async () => {
  await writeApp({ client_id: "Iv23liABC" });
  const github = fakeGithub({ tokens: [FAKE_TOKEN], installation: 7 });
  const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
  assert.equal(await tokens.token(REPO, new AbortController().signal), FAKE_TOKEN);
  assert.deepEqual(
    github.calls.map((call) => `${call.method} ${call.url}`),
    [`GET https://api.github.com/repos/${REPO}/installation`, "POST https://api.github.com/app/installations/7/access_tokens"],
  );
});

test("a token is reused until five minutes before it expires, and minted again after a drop", async () => {
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  let now = NOW;
  const github = fakeGithub({ tokens: ["ghs_first", "ghs_second", "ghs_third"], now: () => now });
  const tokens = createAppTokens({ files, fetch: github.fetch, now: () => now });
  const signal = new AbortController().signal;
  assert.equal(await tokens.token(REPO, signal), "ghs_first");
  now = NOW + 54 * 60 * 1000;
  assert.equal(await tokens.token(REPO, signal), "ghs_first");
  assert.equal(github.calls.length, 1);
  now = NOW + 56 * 60 * 1000;
  assert.equal(await tokens.token(REPO, signal), "ghs_second");
  assert.equal(await tokens.token(REPO, signal), "ghs_second", "a token minted now lives for an hour, so only a drop replaces it");
  tokens.drop(REPO);
  assert.equal(await tokens.token(REPO, signal), "ghs_third");
  assert.equal(github.calls.length, 3);
});

test("a private key that others can read is refused, and no token is minted", async () => {
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 }, 0o644);
  const github = fakeGithub({ tokens: [FAKE_TOKEN] });
  const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
  await assert.rejects(tokens.token(REPO, new AbortController().signal), /mode 600/);
  assert.equal(github.calls.length, 0);
});

test("a missing app config or a GitHub error is a clear failure", async () => {
  const github = fakeGithub({ tokens: [FAKE_TOKEN], status: 401 });
  const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
  await assert.rejects(tokens.token(REPO, new AbortController().signal), /github-app\.json/);
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  await assert.rejects(tokens.token(REPO, new AbortController().signal), /HTTP 401: A JSON web token could not be decoded/);
});

test("the broker finds the app config and key in the host zone ~/.ug/host of its home", async () => {
  const home = join(root, "home");
  const appDir = join(home, ".ug/host");
  await mkdir(appDir, { recursive: true, mode: 0o700 });
  files = { configFile: join(appDir, "github-app.json"), keyFile: join(appDir, "github-app.pem") };
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  const github = fakeGithub({ tokens: [FAKE_TOKEN] });
  const tokens = createAppTokens({ files: appFiles(home), fetch: github.fetch, now: () => NOW });
  assert.equal(await tokens.token(REPO, new AbortController().signal), FAKE_TOKEN);
  assert.equal(github.calls.length, 1);
});

test("an app config that is not a usable config is refused with its path and reason, and no token is minted", async () => {
  const cases: [string, RegExp][] = [
    ["not json", /is not JSON/],
    ["[1]", /is not a JSON object/],
    ["null", /is not a JSON object/],
    [JSON.stringify({ installation_id: 42 }), /needs the app's client_id/],
    [JSON.stringify({ client_id: "Iv23/../x", installation_id: 42 }), /needs the app's client_id/],
    [JSON.stringify({ client_id: "Iv23liABC", installation_id: 0 }), /installation_id that is not a positive whole number/],
    [JSON.stringify({ client_id: "Iv23liABC", installation_id: -42 }), /installation_id that is not a positive whole number/],
    [JSON.stringify({ client_id: "Iv23liABC", installation_id: 4.2 }), /installation_id that is not a positive whole number/],
    [JSON.stringify({ client_id: "Iv23liABC", installation_id: "42" }), /installation_id that is not a positive whole number/],
  ];
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  for (const [text, reason] of cases) {
    await writeFile(files.configFile, text);
    const github = fakeGithub({ tokens: [FAKE_TOKEN], installation: 7 });
    const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
    const error = await tokens.token(REPO, new AbortController().signal).then(
      (token) => assert.fail(`${text} gave the token ${token}`),
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );
    assert.ok(error.startsWith(`the app config ${files.configFile} `), `${text}: ${error}`);
    assert.match(error, reason, text);
    assert.equal(github.calls.length, 0, text);
  }
});

test("a missing private key is refused by name, and no token is minted", async () => {
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  await rm(files.keyFile);
  const github = fakeGithub({ tokens: [FAKE_TOKEN] });
  const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
  await assert.rejects(tokens.token(REPO, new AbortController().signal), { message: `cannot read the app private key ${files.keyFile}` });
  assert.equal(github.calls.length, 0);
});

test("a private key path that is a folder or a symlink is refused, and no token is minted", async () => {
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  const realKey = join(root, "real.pem");
  await rename(files.keyFile, realKey);
  await mkdir(files.keyFile, { mode: 0o700 });
  await chmod(files.keyFile, 0o700);
  const github = fakeGithub({ tokens: [FAKE_TOKEN] });
  const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
  await assert.rejects(tokens.token(REPO, new AbortController().signal), /must be a plain file with mode 600 that only you own/);
  await rm(files.keyFile, { recursive: true });
  await symlink(realKey, files.keyFile);
  await assert.rejects(tokens.token(REPO, new AbortController().signal), /must be a plain file with mode 600 that only you own/);
  assert.equal(github.calls.length, 0);
});

const OTHER_OWNER_KEY = ["/etc/master.passwd", "/etc/shadow"].find((path) => {
  try {
    const info = lstatSync(path);
    return info.isFile() && (info.mode & 0o077) === 0 && info.uid !== process.getuid?.();
  } catch {
    return false;
  }
});

test(
  "[mac] a private key that another user owns is refused, and no token is minted",
  { skip: OTHER_OWNER_KEY === undefined ? "needs a mode-600 file owned by another user (/etc/master.passwd or /etc/shadow); a test user cannot chown" : false },
  async () => {
    await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
    files = { ...files, keyFile: OTHER_OWNER_KEY ?? "" };
    const github = fakeGithub({ tokens: [FAKE_TOKEN] });
    const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
    await assert.rejects(tokens.token(REPO, new AbortController().signal), /must be a plain file with mode 600 that only you own/);
    assert.equal(github.calls.length, 0);
  },
);

test("a GitHub error that quotes a token shows the error with the token redacted", async () => {
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  const github = githubAnswering(() => Response.json({ message: `token ${FAKE_TOKEN} was revoked` }, { status: 403 }));
  const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
  const error = await tokens.token(REPO, new AbortController().signal).then(
    () => assert.fail("a 403 gave a token"),
    (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
  );
  assert.ok(!error.includes(FAKE_TOKEN), error);
  assert.match(error, /HTTP 403: token ghs_\[redacted\] was revoked/);
});

test("a GitHub success whose body is not a JSON object gives no token", async () => {
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  for (const body of [JSON.stringify([FAKE_TOKEN]), JSON.stringify(FAKE_TOKEN), "not json"]) {
    const github = githubAnswering(() => new Response(body, { status: 201, headers: { "content-type": "application/json" } }));
    const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
    await assert.rejects(tokens.token(REPO, new AbortController().signal), /with no JSON object/, body);
  }
});

test("an installation lookup without a numeric id gives no token and mints nothing", async () => {
  await writeApp({ client_id: "Iv23liABC" });
  for (const reply of [{ id: "7" }, {}, { id: 7.5 }]) {
    const github = githubAnswering((url) =>
      url.endsWith("/installation") ? Response.json(reply) : Response.json({ token: FAKE_TOKEN, expires_at: new Date(NOW + 3_600_000).toISOString() }, { status: 201 }),
    );
    const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
    await assert.rejects(tokens.token(REPO, new AbortController().signal), { message: `GitHub sent no installation id for ${REPO}` }, JSON.stringify(reply));
    assert.deepEqual(github.calls.map((call) => call.method), ["GET"], JSON.stringify(reply));
  }
});

test("a minted token in an unknown format, or with a missing or bad expiry, is refused", async () => {
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  const expires = new Date(NOW + 3_600_000).toISOString();
  const replies = [
    { token: "gho_personal", expires_at: expires },
    { token: `x${FAKE_TOKEN}`, expires_at: expires },
    { expires_at: expires },
    { token: FAKE_TOKEN },
    { token: FAKE_TOKEN, expires_at: "soon" },
    { token: FAKE_TOKEN, expires_at: Date.parse(expires) },
  ];
  for (const reply of replies) {
    const github = githubAnswering(() => Response.json(reply, { status: 201 }));
    const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
    await assert.rejects(tokens.token(REPO, new AbortController().signal), { message: "GitHub sent an installation token in an unknown format" }, JSON.stringify(reply));
  }
});

test("each repo gets its own token: a token cached for one repo never goes to another", async () => {
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  const github = fakeGithub({ tokens: ["ghs_for_r", "ghs_for_s"] });
  const tokens = createAppTokens({ files, fetch: github.fetch, now: () => NOW });
  const signal = new AbortController().signal;
  assert.equal(await tokens.token("o/r", signal), "ghs_for_r");
  assert.equal(await tokens.token("o/s", signal), "ghs_for_s");
  assert.equal(await tokens.token("o/r", signal), "ghs_for_r");
  assert.deepEqual(github.calls.map((call) => call.body), [{ repositories: ["r"] }, { repositories: ["s"] }]);
});

test("redaction hides installation tokens of any length, also inside a remote URL", () => {
  const text = `fatal: unable to access '${tokenRemote(REPO)}': 403\nGH_TOKEN=${FAKE_TOKEN} ghs_short\n`;
  const redacted = redactTokens(text);
  assert.ok(!redacted.includes(FAKE_TOKEN));
  assert.ok(!/ghs_[A-Za-z0-9]/.test(redacted), redacted);
  assert.match(redacted, /x-access-token:ghs_\[redacted\]@github\.com\/o\/r\.git/);
});

const FAKE_GH = `#!/bin/sh
printf '%s %s\\n' "$GH_TOKEN" "$GH_CONFIG_DIR" >> "$HOME/gh-env"
if [ -f "$HOME/gh-401" ]; then rm "$HOME/gh-401"; echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2; exit 1; fi
if [ -f "$HOME/gh-leak" ]; then echo "error near $GH_TOKEN" >&2; exit 1; fi
printf '{"defaultBranchRef":{"name":"main"}}\\n'
`;

let config: ServerConfig;
let remote: string;

function rotatingTokens(): GithubTokens {
  let current = 0;
  return {
    token: () => Promise.resolve(`${FAKE_TOKEN}${current}`),
    drop: () => {
      current += 1;
    },
  };
}

function sync(): Promise<Reply> {
  return handleAs(config, AUTHOR, { verb: "sync", repo: REPO }, new AbortController().signal);
}

async function setUp(github: GithubTokens): Promise<void> {
  config = {
    ...defaultConfig(),
    socketPath: join(root, "run", "broker.sock"),
    reposRoot: join(root, "bare"),
    reviewsDir: join(root, "reviews"),
    pushesDir: join(root, "pushes"),
    protectedDir: join(root, "protected"),
    ghPath: join(root, "gh"),
    github,
    home: join(root, "home"),
    tempRoot: join(root, "tmp"),
  };
  await mkdir(config.home);
  await writeFile(config.ghPath, FAKE_GH, { mode: 0o755 });
  remote = join(root, "remote.git");
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", "-b", "main", remote], { env: GIT_ENV });
  const work = join(root, "work");
  execFileSync(config.gitPath, ["init", "--quiet", "-b", "main", work], { env: GIT_ENV });
  execFileSync(config.gitPath, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "base"], { cwd: work, env: GIT_ENV });
  execFileSync(config.gitPath, ["push", "--quiet", remote, "main:main"], { cwd: work, env: GIT_ENV });
  const bare = join(config.reposRoot, `${REPO}.git`);
  execFileSync(config.gitPath, ["init", "--bare", "--quiet", bare], { env: GIT_ENV });
}

function routeRemote(url: string): void {
  execFileSync(config.gitPath, ["-C", join(config.reposRoot, `${REPO}.git`), "config", `url.file://${remote}.insteadOf`, url], { env: GIT_ENV });
}

async function ghEnv(): Promise<string[]> {
  return (await readFile(join(config.home, "gh-env"), "utf8")).trim().split("\n");
}

test("gh runs with the installation token in GH_TOKEN and no gh login of its own", async () => {
  await setUp(fakeTokens());
  routeRemote(tokenRemote(REPO));
  const reply = await sync();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  const [line] = await ghEnv();
  const [token, configDir] = (line ?? "").split(" ");
  assert.equal(token, FAKE_TOKEN);
  assert.ok(configDir !== undefined && configDir !== "", line);
  const entries = await readdir(configDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(entries, [], "gh finds no login or config in its config dir");
  let existing = configDir;
  while (!(await access(existing).then(() => true, () => false))) existing = dirname(existing);
  await assert.rejects(access(existing, constants.W_OK), `gh cannot store a login in ${configDir}`);
});

test("git reaches GitHub through a remote URL that carries the installation token", async () => {
  await setUp(fakeTokens());
  routeRemote(tokenRemote(REPO));
  const reply = await sync();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.ok("branch" in reply && reply.branch === "main");
});

test("a 401 drops the token and the call runs once more with a fresh one", async () => {
  await setUp(rotatingTokens());
  routeRemote(tokenRemote(REPO, `${FAKE_TOKEN}1`));
  await writeFile(join(config.home, "gh-401"), "");
  const reply = await sync();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.deepEqual(
    (await ghEnv()).map((line) => line.split(" ")[0]),
    [`${FAKE_TOKEN}0`, `${FAKE_TOKEN}1`],
  );
});

test("with the app provider, a 401 drops the cached token and the retry runs with a newly minted one", async () => {
  await writeApp({ client_id: "Iv23liABC", installation_id: 42 });
  const github = fakeGithub({ tokens: [`${FAKE_TOKEN}0`, `${FAKE_TOKEN}1`] });
  await setUp(createAppTokens({ files, fetch: github.fetch, now: () => NOW }));
  routeRemote(tokenRemote(REPO, `${FAKE_TOKEN}1`));
  await writeFile(join(config.home, "gh-401"), "");
  const reply = await sync();
  assert.equal(reply.exit, 0, JSON.stringify(reply));
  assert.deepEqual(
    (await ghEnv()).map((line) => line.split(" ")[0]),
    [`${FAKE_TOKEN}0`, `${FAKE_TOKEN}1`],
  );
  assert.equal(github.calls.length, 2, "the first token lives for an hour, so only the drop mints the second");
});

test("a failing call never echoes the token in its reply", async () => {
  await setUp(fakeTokens());
  await writeFile(join(config.home, "gh-leak"), "");
  const reply = await sync();
  assert.notEqual(reply.exit, 0);
  assert.ok(!JSON.stringify(reply).includes(FAKE_TOKEN), JSON.stringify(reply));
  assert.match(JSON.stringify(reply), /ghs_\[redacted\]/);
});

test("a git failure never echoes the token URL in its reply", async () => {
  await setUp(fakeTokens());
  execFileSync(config.gitPath, ["-C", join(config.reposRoot, `${REPO}.git`), "config", `url.file://${join(root, "missing.git")}?${FAKE_TOKEN}.insteadOf`, tokenRemote(REPO)], { env: GIT_ENV });
  const reply = await sync();
  assert.notEqual(reply.exit, 0);
  assert.ok(!JSON.stringify(reply).includes(FAKE_TOKEN), JSON.stringify(reply));
});

test("no app token means no GitHub call, and the reply says why", async () => {
  await setUp({ token: () => Promise.reject(new Error("cannot read /k/github-app.pem")), drop: () => {} });
  const reply = await sync();
  assert.equal(reply.exit, 1);
  assert.match("stderr" in reply ? reply.stderr : "", /cannot get a GitHub App token: cannot read \/k\/github-app\.pem/);
  await assert.rejects(readFile(join(config.home, "gh-env"), "utf8"));
});
