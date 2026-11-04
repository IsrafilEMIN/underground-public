# Accepted risks for MVP 0.5

Date: 2026-10-30. Owner decision.

Holds under the redesign (2026-11-02, `../PRODUCT-BRIEF.md`). Every session uses one allowlist, `host/network-allowlist` in the owner's checkout (until 2026-11-03 it sat at `host/roles/network-allowlist`). Roles no longer differ in reach (`0011-one-agent-arena.md`). A per-repo allowlist is deferred.

We accept one irreversible risk: U14, the agent can send data that it can read to a destination on the srt allowlist. Every role uses one allowlist (amendment below), and we keep a destination only when a step of some role needs it. A second came on 2026-11-03: the host runs underground from the live checkout (amendment "the live checkout").

- The broker flow needs no allowlist entry: the client talks to the broker over a Unix socket and imports a bundle (`send` and `importSync`, `host/broker/client.ts:103` to `:136`); the host fetches from GitHub (`handleSync`, `host/broker/server.ts:231`).
- After B9, model calls go to the auth gateway, so the model provider domains leave the list.
- Kept by the owner for every role: the tailscale entry of the auth gateway (B6), `github.com` (reading public code), web search (`html.duckduckgo.com`, `www.perplexity.ai`, `api.perplexity.ai`), and `registry.npmjs.org` (package installs). The inference engine left the list on 2026-11-01; roles reach it through the gateway (`0005-model-auth-gateway.md`). Any request to these destinations can carry data to the service. With a token, a push to an attacker repo or a package publish can carry data to an attacker. Rejected: no web search for reviewers; a reviewer then cannot look up a CVE or an API change.

A bad merge is only partly reversible: a revert restores the repo content, not a leaked secret or an effect that the code had while it ran (U10).

## Amendment 2026-11-02: one allowlist for all roles

Until 2026-11-02 each role had its own allowlist, and reviewer roles had no `github.com` and no `registry.npmjs.org`. The owner chose one allowlist for all roles, `host/roles/network-allowlist`, installed as `~/.agents/roles/network-allowlist` (owner decision, 2026-11-02). The reviewer gain is small but real: a reviewer can read upstream code and package data, for example for a dependency bump. The leak cost is small: a reviewer already reaches web search and the gateway, and it holds no GitHub or npm token, so it cannot push or publish. [inference] The rule that a reviewer runs no PR code stays in its rules; the allowlist never enforced it.

## Amendment 2026-11-03: the live checkout

Owner decision, 2026-11-03. The host runs underground straight from the owner's checkout (`0012-pinned-omp-and-setup.md`): `~/.ug/sys/bin/omp` links to `host/bin/omp-arena` there (`host/bin/ug-setup:207`), and the broker, usage broker, and backup services run `host/...` files there (`@SRC@` in `host/launchd/`). So whatever the checkout holds runs on the host, outside the sandbox, with the app key and `~/.ug/host`: the wrapper at the next `omp`, the brokers at their next start (login or a crash, under `KeepAlive`), and the backup at 20:00. Setup's test suite does not run first.

The merge gate keeps agent code out of underground's `main` (onboarding check 6, `../SPEC.md`), but not out of the checkout: a `gh pr checkout` or a `git checkout` of an agent branch in it runs that branch on the host. We accept this risk. It is irreversible, because a revert does not undo code that has run on the host. The control is a host rule (`../THREAT-MODEL.md`, U4): the owner checks out only `main` in the checkout that the host runs, and reads a PR on GitHub or in another clone.

Rejected: setup copies the host code at a commit into the owner zone and points the link and the services at the copy, so only tested code that setup installed runs on the host. It is the stronger control, but it ends "`git pull` updates its code" (`0012-pinned-omp-and-setup.md`), and the owner's merge already keeps unread agent code off `main`. Revisit it if underground ever updates without the owner, for example for an unattended agent setup.
