# Accepted risks for MVP 0.5

Date: 2026-10-30. Owner decision.

We accept one irreversible risk: U14, the agent can send data that it can read to a destination on the srt allowlist of its role. Each role has its own allowlist, and we keep a destination only when a step of that role needs it.

- The broker flow needs no allowlist entry: the client talks to the broker over a Unix socket and imports a bundle (`send` and `importSync`, `host/broker/client.ts:103` to `:136`); the host fetches from GitHub (`handleSync`, `host/broker/server.ts:231`).
- After B9, model calls go to the auth gateway, so the model provider domains leave the list.
- Kept by the owner for author roles: `github.com` (reading public code), web search (`html.duckduckgo.com`, `www.perplexity.ai`, `api.perplexity.ai`), and `registry.npmjs.org` (package installs). Any request to them can carry data to the service. With a token, a push to an attacker repo or a package publish can carry data to an attacker.
- Kept by the owner for reviewer roles: web search, and the tailscale entry of the auth gateway (B6). The inference engine left every list on 2026-11-01; roles reach it through the gateway (`0005-model-auth-gateway.md`). A reviewer reads every diff, gets the PR through the broker, and runs no code, so it needs neither `github.com` nor `registry.npmjs.org`. Rejected: no web search for reviewers; a reviewer then cannot look up a CVE or an API change. Rejected: one allowlist for all roles; each reviewer then keeps the author's leak paths for no gain.

A bad merge is only partly reversible: a revert restores the repo content, not a leaked secret or an effect that the code had while it ran (U10).
