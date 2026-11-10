import { sign } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./protocol.ts";
import type { Checked } from "./protocol.ts";

export type AppConfig = { clientId: string; installationId: number | undefined };
export type AppFiles = { configFile: string; keyFile: string };
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type TokenScope = "app" | "contents-read";
export type GithubTokens = {
  token(repo: string, signal: AbortSignal, scope?: TokenScope): Promise<string>;
  drop(repo: string, scope?: TokenScope): void;
};

type Minted = { token: string; refreshAt: number };

const API = "https://api.github.com";
const REFRESH_BEFORE_MS = 5 * 60 * 1000;
const INSTALLATION_TOKEN = /^ghs_[A-Za-z0-9_.-]+$/;
const INSTALLATION_TOKEN_TEXT = /ghs_[A-Za-z0-9_.-]+/g;
const BASIC_USER = "x-access-token:";
const BASIC_TEXT = new RegExp(`${Buffer.from(BASIC_USER).toString("base64")}[A-Za-z0-9+/=]+`, "g");

export function appFiles(home: string): AppFiles {
  return {
    configFile: join(home, ".local/share/underground/github-app.json"),
    keyFile: join(home, ".local/share/underground/github-app.pem"),
  };
}

export function basicAuth(token: string): string {
  return `Basic ${Buffer.from(`${BASIC_USER}${token}`).toString("base64")}`;
}

export function redactTokens(text: string): string {
  return text.replace(INSTALLATION_TOKEN_TEXT, "ghs_[redacted]").replace(BASIC_TEXT, "[redacted]");
}

function parseAppConfig(text: string): Checked<AppConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "is not JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "is not a JSON object" };
  const { client_id: clientId, installation_id: installationId } = parsed;
  if (typeof clientId !== "string" || !/^[A-Za-z0-9.]+$/.test(clientId)) return { ok: false, reason: "needs the app's client_id" };
  if (installationId === undefined) return { ok: true, value: { clientId, installationId: undefined } };
  if (typeof installationId !== "number" || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return { ok: false, reason: "has an installation_id that is not a positive whole number" };
  }
  return { ok: true, value: { clientId, installationId } };
}

export function appJwt({ clientId, privateKey, nowSeconds }: { clientId: string; privateKey: string; nowSeconds: number }): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: clientId })}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
}

async function readAppConfig(path: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`cannot read the app config ${path}`);
  }
  const config = parseAppConfig(text);
  if (!config.ok) throw new Error(`the app config ${path} ${config.reason}`);
  return config.value;
}

async function readPrivateKey(path: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new Error(`cannot read the app private key ${path}`);
  }
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error(`the app private key ${path} must be a plain file with mode 600 that only you own`);
  }
  return readFile(path, "utf8");
}

async function callGithub(fetch: Fetch, request: { method: string; path: string; jwt: string; body?: object; signal: AbortSignal }): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${request.path}`, {
    method: request.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${request.jwt}`,
      "Content-Type": "application/json",
      "User-Agent": "underground-gh-broker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: request.signal,
  });
  let reply: unknown;
  try {
    reply = await response.json();
  } catch {
    reply = undefined;
  }
  if (!response.ok) {
    const message = isRecord(reply) && typeof reply.message === "string" ? `: ${redactTokens(reply.message)}` : "";
    throw new Error(`GitHub answered ${request.method} ${request.path} with HTTP ${response.status}${message}`);
  }
  if (!isRecord(reply)) throw new Error(`GitHub answered ${request.method} ${request.path} with no JSON object`);
  return reply;
}

export function createAppTokens({ files, fetch = globalThis.fetch, now = Date.now }: { files: AppFiles; fetch?: Fetch; now?: () => number }): GithubTokens {
  const cache = new Map<string, Minted>();

  const mint = async (repo: string, scope: TokenScope, signal: AbortSignal): Promise<Minted> => {
    const config = await readAppConfig(files.configFile);
    const jwt = appJwt({ clientId: config.clientId, privateKey: await readPrivateKey(files.keyFile), nowSeconds: Math.floor(now() / 1000) });
    let installation = config.installationId;
    if (installation === undefined) {
      const found = await callGithub(fetch, { method: "GET", path: `/repos/${repo}/installation`, jwt, signal });
      if (typeof found.id !== "number" || !Number.isSafeInteger(found.id)) throw new Error(`GitHub sent no installation id for ${repo}`);
      installation = found.id;
    }
    const repositories = [repo.slice(repo.indexOf("/") + 1)];
    const reply = await callGithub(fetch, {
      method: "POST",
      path: `/app/installations/${installation}/access_tokens`,
      jwt,
      body: scope === "contents-read" ? { repositories, permissions: { contents: "read" } } : { repositories },
      signal,
    });
    const expiresAt = typeof reply.expires_at === "string" ? Date.parse(reply.expires_at) : Number.NaN;
    if (typeof reply.token !== "string" || !INSTALLATION_TOKEN.test(reply.token) || Number.isNaN(expiresAt)) {
      throw new Error("GitHub sent an installation token in an unknown format");
    }
    return { token: reply.token, refreshAt: expiresAt - REFRESH_BEFORE_MS };
  };

  return {
    async token(repo, signal, scope = "app") {
      const key = `${scope} ${repo}`;
      const cached = cache.get(key);
      if (cached !== undefined && now() < cached.refreshAt) return cached.token;
      const minted = await mint(repo, scope, signal);
      cache.set(key, minted);
      return minted.token;
    },
    drop(repo, scope = "app") {
      cache.delete(`${scope} ${repo}`);
    },
  };
}
