import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GithubTokens } from "../../host/gh-broker/github-app.ts";
import type { Reply } from "../../host/gh-broker/protocol.ts";
import { defaultConfig, handleRequest } from "../../host/gh-broker/server.ts";
import type { ServerConfig } from "../../host/gh-broker/server.ts";
import { fakeTokens, githubRemote } from "./fake-app.ts";

export const REPO = "o/r";
export const BRANCH = "agent/x";
export const REAL_GIT = defaultConfig("/unused/gh").gitPath;
export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
};

export async function brokerConfig(root: string, gh: string, github: GithubTokens = fakeTokens()): Promise<ServerConfig> {
  const config: ServerConfig = {
    ...defaultConfig("/unused/gh"),
    socketPath: join(root, "run", "gh-broker.sock"),
    reposRoot: join(root, "bare"),
    pushesDir: join(root, "pushes"),
    ghPath: join(root, "gh"),
    github,
    home: join(root, "home"),
    tempRoot: join(root, "tmp"),
    statusFile: join(root, "status"),
  };
  await mkdir(config.home);
  await writeFile(config.ghPath, gh, { mode: 0o755 });
  return config;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

export function initRepo(path: string, bare = false): string {
  execFileSync(REAL_GIT, ["init", ...(bare ? ["--bare"] : []), "--quiet", "-b", "main", path], { env: GIT_ENV });
  return path;
}

export function initMirror(config: ServerConfig, remote?: string): string {
  const mirror = initRepo(join(config.reposRoot, `${REPO}.git`), true);
  git(mirror, "config", "maintenance.auto", "false");
  if (remote !== undefined) git(mirror, "config", `url.file://${remote}.insteadOf`, githubRemote(REPO));
  return mirror;
}

export async function commit(cwd: string, file: string, branch?: string): Promise<string> {
  if (branch !== undefined) git(cwd, "checkout", "--quiet", "-B", branch);
  await writeFile(join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

export async function seedMain(work: string, remote: string): Promise<string> {
  const base = await commit(work, "base.txt");
  git(work, "push", "--quiet", remote, "main:main");
  return base;
}

export function bundleOf(work: string, branch: string): string {
  return execFileSync(REAL_GIT, ["bundle", "create", "-", `refs/heads/${branch}`], { cwd: work, env: GIT_ENV }).toString("base64");
}

export function remoteRef(remote: string, branch: string): string {
  return git(remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
}

export function request(config: ServerConfig, input: Record<string, unknown>): Promise<Reply> {
  return handleRequest(config, { repo: REPO, ...input }, new AbortController().signal);
}
