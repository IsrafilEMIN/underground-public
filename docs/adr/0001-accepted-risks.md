# Accepted risks for MVP 0.5

Date: 2026-10-30. Owner decision.

Holds under the redesign (2026-11-02, `../PRODUCT-BRIEF.md`). Every session uses one allowlist, `host/network-allowlist` in the owner's checkout (until 2026-11-03 it sat at `host/roles/network-allowlist`). Roles no longer differ in reach (`0011-one-agent-arena.md`). A per-repo allowlist is deferred.

We accept one irreversible risk: U14, the agent can send data that it can read to a destination on the srt allowlist. Every role uses one allowlist (amendment below), and we keep a destination only when a step of some role needs it.

- The broker flow needs no allowlist entry: the client talks to the broker over a Unix socket and imports a bundle (`send` and `importSync`, `host/broker/client.ts:103` to `:136`); the host fetches from GitHub (`handleSync`, `host/broker/server.ts:231`).
- After B9, model calls go to the auth gateway, so the model provider domains leave the list.
- Kept by the owner for every role: the tailscale entry of the auth gateway (B6), `github.com` (reading public code), web search (`html.duckduckgo.com`, `www.perplexity.ai`, `api.perplexity.ai`), and `registry.npmjs.org` (package installs). The inference engine left the list on 2026-11-01; roles reach it through the gateway (`0005-model-auth-gateway.md`). Any request to these destinations can carry data to the service. With a token, a push to an attacker repo or a package publish can carry data to an attacker. Rejected: no web search for reviewers; a reviewer then cannot look up a CVE or an API change.

A bad merge is only partly reversible: a revert restores the repo content, not a leaked secret or an effect that the code had while it ran (U10).

## Amendment 2026-11-02: one allowlist for all roles

Until 2026-11-02 each role had its own allowlist, and reviewer roles had no `github.com` and no `registry.npmjs.org`. The owner chose one allowlist for all roles, `host/roles/network-allowlist`, installed as `~/.agents/roles/network-allowlist` (owner decision, 2026-11-02). The reviewer gain is small but real: a reviewer can read upstream code and package data, for example for a dependency bump. The leak cost is small: a reviewer already reaches web search and the gateway, and it holds no GitHub or npm token, so it cannot push or publish. [inference] The rule that a reviewer runs no PR code stays in its rules; the allowlist never enforced it.
