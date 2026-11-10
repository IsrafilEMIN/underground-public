# Accepted risks for MVP 0.5

Date: 2026-10-30. Owner decision.

Holds under the redesign (2026-11-02, `../PRODUCT-BRIEF.md`). Every session used one allowlist, `host/network-allowlist` in the owner's checkout; step 4 of `0016-agent-user.md` removed it (2026-11-08, `0016-agent-user.md`, "Step 4 (2026-11-08): the switch"). Until 2026-11-03 it sat at `host/roles/network-allowlist`. Roles no longer differ in reach (`0011-one-agent-arena.md`). A per-repo allowlist is deferred.

We accept one irreversible risk: U14, the agent can send data that it can read to a destination on the srt allowlist. Every role uses one allowlist (amendment below), and we keep a destination only when a step of some role needs it. A second came on 2026-11-03: the host runs underground from the live checkout (amendment "the live checkout").

- The gh-broker flow needs no allowlist entry: the client talks to the gh-broker over a Unix socket and imports a bundle (`send` and `importSync`, `host/gh-broker/client.ts`); the host fetches from GitHub (`handleSync`, `host/gh-broker/server.ts`).
- Model calls go to the auth gateway, so the model provider domains leave the list.
- Kept by the owner for every role: the tailscale entry of the auth gateway (`../SPEC.md`, "Login services"), `github.com` (reading public code), web search (`html.duckduckgo.com`, `www.perplexity.ai`, `api.perplexity.ai`), and `registry.npmjs.org` (package installs). The inference engine left the list on 2026-11-01; roles reach it through the gateway (`0005-model-auth-gateway.md`). Any request to these destinations can carry data to the service. With a token, a push to an attacker repo or a package publish can carry data to an attacker. Rejected: no web search for reviewers; a reviewer then cannot look up a CVE or an API change.

A bad merge is only partly reversible: a revert restores the repo content, not a leaked secret or an effect that the code had while it ran (U10).

## Amendment 2026-11-02: one allowlist for all roles

Until 2026-11-02 each role had its own allowlist, and reviewer roles had no `github.com` and no `registry.npmjs.org`. The owner chose one allowlist for all roles, `host/roles/network-allowlist`, installed as `~/.agents/roles/network-allowlist` (owner decision, 2026-11-02). The reviewer gain is small but real: a reviewer can read upstream code and package data, for example for a dependency bump. The leak cost is small: a reviewer already reaches web search and the gateway, and it holds no GitHub or npm token, so it cannot push or publish. [inference] The rule that a reviewer runs no PR code stays in its rules; the allowlist never enforced it.

## Amendment 2026-11-03: the live checkout

Owner decision, 2026-11-03. The host runs underground straight from the owner's checkout (`0012-pinned-omp-and-setup.md`): `~/.ug/sys/bin/omp` links to `host/bin/omp-arena` there (`link`, `host/bin/ug-setup`; `host/bin/omp-arena` is removed), and the gh-broker, usage broker, and backup services run `host/...` files there (`@SRC@` in `host/launchd/`). So whatever the checkout holds runs on the host, outside the sandbox, with the app key and `~/.ug/host`: the wrapper at the next `omp`, the brokers at their next start (login or a crash, under `KeepAlive`), and the backup at 20:00. Setup's test suite does not run first.

This acceptance assumes the underground hold, which is not built yet: `gh-broker merge` will refuse every underground PR, so only the owner merges agent code into underground's `main` (onboarding check 6, and `../SPEC.md`, "gh-broker and the merge gate"). Until it is built, a session can merge its own underground PR, and the next `git pull` runs it on the host. Even with the hold, agent code can still reach the checkout without a merge: a `gh pr checkout` or a `git checkout` of an agent branch in it runs that branch on the host. We accept this risk. It is irreversible, because a revert does not undo code that has run on the host. The control is a host rule (`../THREAT-MODEL.md`, U4): the owner checks out only `main` in the checkout that the host runs, and reads a PR on GitHub or in another clone.

Rejected: setup copies the host code at a commit into the owner zone and points the link and the services at the copy, so only tested code that setup installed runs on the host. It is the stronger control, but it ends "`git pull` updates its code" (`0012-pinned-omp-and-setup.md`), and the underground hold, once built, keeps unread agent code off `main`. Revisit it if the hold is not built, or if underground ever updates without the owner, for example for an unattended agent setup.

## Amendment 2026-11-07: the agent box (proposed)

`0013-agent-box.md` is proposed, not built. Until it is built, this ADR describes the system. Once built, two things change. U14 stays, but the allowlist moves: srt's HTTP proxy runs on the host behind the box's egress socket and allows a site by its name only, instead of srt wrapping the sandbox. The finer check that would open each HTTPS connection was rejected because it would stop only an anonymous upload to an allowed site, which is U14 itself (`0013-agent-box.md`, "Egress by name only"). The live checkout acceptance is open again: its own revisit condition is "an unattended agent setup", and `0013-agent-box.md` lists where the host code runs from under Open.

2026-11-07: built as a trial. The box runs the sessions (`host/bin/ug-box`, `host/egress/`), and srt's HTTP proxy runs in the egress door (`host/egress/server.ts`, removed). The srt wrapper was removed in #90 (commit 54a418a1).

## Amendment 2026-11-07: an installed copy of the host code (proposed)

Owner decision, 2026-11-07. Once the box is built, the mac runs underground from a copy that setup installs from a merged `main` commit into a folder that only setup writes, not from the owner's checkout (`0015-box-layout.md`). The "live checkout" acceptance then ends: a checkout of an agent branch in the owner's folder runs nothing on the mac. An update is `git pull`, then setup.

2026-11-07: built. Setup installs the copy (`install_service_code`, `host/bin/ug-setup`); `ug-auth` joined it last, in PR #92 (commit 5338e47).

2026-11-08: an update is now one setup run, which fast-forwards `main` first (`0012-pinned-omp-and-setup.md`, "Amendment 2026-11-08: setup pulls main first").
