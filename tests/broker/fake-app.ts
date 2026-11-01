import type { GithubTokens } from "../../host/broker/github-app.ts";

export const FAKE_TOKEN = `ghs_1234_${"eyJhbGciOiJSUzI1NiJ9.e30.c2ln-_".repeat(16)}`;

export function fakeTokens(token: string = FAKE_TOKEN): GithubTokens {
  return { token: () => Promise.resolve(token), drop: () => {} };
}

export function tokenRemote(repo: string, token: string = FAKE_TOKEN): string {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}
