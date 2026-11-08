# Product brief: underground MVP 0.5 (redesign)

Owner decision, 2026-11-02. This brief replaces the design of the first MVP 0.5. `SPEC.md` lists the build work, `THREAT-MODEL.md` the threats and their controls, and `adr/0011-one-agent-arena.md` and `adr/0012-pinned-omp-and-setup.md` the reasons. The code ran the old design until #90 removed it (commit 54a418a1, 2026-11-07). The box ran the sessions until step 4 of `adr/0016-agent-user.md` removed it (2026-11-08); the agent's own macOS user runs them now.

**Redesign phase** (owner decision, 2026-11-07; `../AGENTS.md`, "Redesign phase"). The architecture is being redesigned from the problem up. This brief describes the srt design, which the code ran until #90 removed its wrapper and arena start step (`host/bin/omp-arena`, `host/arena/init`, commit 54a418a1). For the new design, its summary, the first paragraph of its problem, its user and scope, and its north star hold. The rest (the second paragraph of the problem, the principles, zones, flows, "What stays", "What goes", and the trade-offs) is aid, not base: a part comes back only if the new base needs it. This includes "the rest stays" under Accepted trade-offs; it is not a decision for the box (`adr/0013-agent-box.md`).

## Summary

underground lets the omp coding agent work on the owner's mac like a coworker: the owner designs with it, and it implements ready tickets and merges its own PRs while the owner is away.

## Problem

The owner runs omp without approvals, but does not trust an unattended run. The owner must watch only to stop harm that cannot be undone.

The first design drew the line between the agent and the owner as a list of paths inside the owner's home. omp assumes that it owns its home: its root, logins, caches, skills, and updates. So each normal omp action crossed the line, and each crossing needed a patch: the split omp root, the policy pins, the `XDG_*` moves, `skillLinkRoots`, the subagent rules hook, `drop_secret_env`, and the reviewer store move (`adr/0002`, `adr/0008`, `adr/0009`). A new omp version can add a new path, so the list never ends [inference].

## User and scope

- One owner: a solo developer, on one macOS laptop, with one macOS user.
- One agent: omp. The owner removes every other agent from the mac.
- Repos: public for now. A private repo reopens the data-out question (U14).

## North star

The agent works like a coworker. The owner and the agent do the design together; the agent turns each ready ticket into a merged change on its own. Whatever the agent does without the owner's approval, in either way of working, the owner can undo.

Before each decision, ask: does this stop an irreversible harm, or keep undo and work possible? If not, it waits.

## Two ways of working

Owner decision, 2026-11-08. Until this date the brief assumed that every session runs unattended. The agent now works in two ways:

- **Together.** Design, architecture, specs, ADRs, and the split of user stories into tickets. The owner works in the session with the agent and reads each step, but only after it has run: omp runs tool calls without approvals, so the owner's presence stops no call in time.
- **On its own.** A ready ticket: the smallest unit of work, with no design decision left in it. The agent implements it, gets it merged, and reports back to the owner with the result. Only this part runs unattended.

The threat model is to be checked again against these two ways (`THREAT-MODEL.md`). The check splits a threat by whether the owner approves a call before it runs, not by whether the owner is there. A leak, a force-push, or a write to the owner's files is as irreversible in a session together as in one on its own.

## Principles

1. **One arena.** The agent has one home of its own. srt keeps it there. srt stays because it is light.
2. **omp runs unchanged.** Default paths and the default profile. If the design needs a patch to omp, the design is wrong.
3. **No secret in the arena.** The agent uses a credential through a broker. It never reads one.
4. **Control only the crossings.** Each way into or out of the arena has one control. Inside the arena, the agent is free.
5. **Undo over prevention.** A bad merge gets a revert. A broken arena gets deleted and rebuilt.
6. **One trust level.** All roles share the arena. Reviewers improve quality. They are not a safety wall.
7. **A plain owner zone.** One root. Only setup writes it. No tool finds it by convention.
8. **Count the parts.** Each part names its crossing or the irreversible harm that it stops. A part that names neither goes.
9. **Few runtimes.** Each runtime on the start path is pinned. Measure the start time before and after a change.

## Zones

| zone | path | the agent may |
|---|---|---|
| arena | `~/.ug/home` | do anything |
| owner zone | `~/.ug/sys` | read only |
| sockets | `~/.ug/run` | use the listed sockets only |
| host | `~/.ug/host` | nothing |
| owner's zone | everything else | nothing |

- **Arena:** omp's own `~/.omp` (config, sessions, caches, helpers) and the agent's repo clones, proposed at `work/<owner>/<repo>`. The arena is the agent's `HOME`.
- **Owner zone:** the pinned omp binary, the pinned srt (still installed for the egress door's HTTP proxy, `host/egress/server.ts:27-29`), and `bin/omp`, a link to the box's launcher `ug-box` (`host/bin/ug-setup:185`). `bin/` is on `PATH`.
- **Sockets:** the gh-broker and egress sockets (`~/.ug/run`, `host/bin/ug-box:16-17`). The agent cannot write here, so it cannot plant a socket or a link.
- **Host:** everything the agent gets nothing of: the GitHub App key, the auth broker's logins, the gh-broker's records, the arena backup's password and settings (`SPEC.md`, B10), and the owner's hand-edited gh-broker files, such as the addresses file (owner decision, 2026-11-03).
- **Owner's zone:** the owner's checkouts. underground runs from its checkout. The owner's agent config repo lives here too.

To uninstall: delete `~/.ug` and the launchd files.

## Flows

**Start a session**

1. The owner types `omp` in a checkout. `PATH` finds the wrapper.
2. The wrapper copies the owner's config repo into the arena's `~/.omp/agent`.
3. It sets `HOME` to the arena and starts a clean environment.
4. srt starts the pinned omp in that repo's clone in the arena.

**Repos**

- The agent works in its own clone in the arena, never in the owner's checkout. Agent-written `.git` files, `.envrc`, or editor tasks then never run in a host tool (U4).
- The host never runs git in the arena. Git there runs only inside the sandbox.
- Agent work reaches the owner only through GitHub.

**Code out**

- Agent → gh-broker socket → GitHub, `agent/*` branches only → PR → CI → reviewers → merge gate.
- Other repos: auto merge.
- underground: the owner merges, because its code runs on the host.

**Model calls**

- Agent → auth gateway (tailscale address) → auth broker (`127.0.0.1`) → provider.
- Only the gateway talks to the broker. A direct broker client receives access tokens and API keys (omp `docs/auth-broker-gateway.md:3`, read 2026-11-02), so no session is a broker client.

**`/usage`**

- Agent → usage broker → gateway. The usage broker holds no credentials.
- omp's `/usage` reads only local logins or a broker client (omp `packages/coding-agent/src/session/agent-session.ts:14301`, `main` at `650f3a1`, read 2026-11-02). So the usage broker stays until omp serves usage through the gateway.
- It stays on `127.0.0.1:18765`, because localhost stays on for omp's own features (`SPEC.md`, B5).

## The omp binary

- One file, `omp-darwin-arm64`. It carries omp's code, the bun runtime, and the native parts. We never build omp.
- Source: GitHub releases. The release file of v18.13.2 has the same SHA-256 as Tern's copy, `38c3645283ceba06f66462830ae15f27270cc7f84575e40a4c6bd68452a63d0f` (download and `shasum`, 2026-11-02). Releases back to v5.0.0 (2026-01-12) have the file; v14.0.0 does not (HTTP 404, 2026-11-02).
- The pin is a version and a SHA-256 in `VERSIONS`. Setup downloads the file, checks the hash, and keeps its own copy.
- Tern stays for the owner's iPhone. Its omp comes off `PATH`.

**No unboxed session**

- Inside the sandbox: impossible. Every child of srt stays in the sandbox.
- From the owner's shell: only the wrapper is named `omp`.
- By full path: the raw omp finds no login, so it cannot work.

## Updates

- underground: `git pull` in the owner's checkout, then setup, which copies the code into `~/.ug/sys` (`install_service_code`, `host/bin/ug-setup`; `adr/0012-pinned-omp-and-setup.md`, amendment "an installed copy of the host code"). The agent user's copy and its `omp` link come from `host/bin/ug-agent-setup`, which setup runs with sudo at its end.
- omp: change the pin, then run setup.
- Config: commit to the config repo, then run setup. Setup copies the last commit into `/Library/Underground/config` (`stage_config`, `host/bin/ug-agent-setup:136-177`), and each start copies that folder into the agent's `~/.omp/agent` (`host/agent/agent-start:20-24`).

Setup runs when underground's `main`, a pin, a host service, the config repo, or macOS changes. It installs the pinned omp and restic, makes the zones and their modes, and registers and restarts the launchd services (`host/bin/ug-setup`). At its end it runs `host/bin/ug-agent-setup` with sudo, which links the agent user's `omp` on `PATH`.

## What stays

- The auth gateway, the auth broker, and the usage broker.
- The gh-broker and its merge gate.
- The macOS build pin.
- The onboarding checks (`SPEC.md`), including: a merge to `main` has no effect that a revert cannot undo.
- The reviewer roles. Their rules come as skills.

## What goes

- The owner/agent split of the omp root, and the policy pins.
- The one-by-one moves: `PI_CONFIG_DIR`, `XDG_*`, `CARGO_HOME`.
- `skillLinkRoots` and the skill symlinks.
- `drop_secret_env`. A clean environment replaces it.
- Per-role homes, sessions, state, and reviewer stores.
- The heavy install and its file hash record.

## Accepted trade-offs

- srt is a filter on the owner's macOS user, not a wall.
- Localhost is open to every port for now. srt 0.0.81 has one switch for it (`dist/sandbox/macos-sandbox-utils.js:951` to `:954`).
- The agent can send what it reads to an allowlisted domain (U14). This is fine while the repos are public.
- A session can damage another repo's clone in the arena. Only agent work is lost.
- The box can be swapped. If srt fails us, the arena moves into a VM, and the rest stays.

## Deferred

- Localhost: decided 2026-11-03, it stays on, because omp's own features need it (`SPEC.md`, B5). Still open: a per-port setting in srt.
- Per-repo allowlists, with the data-out question.
- The merge gate's machinery: what is still needed now that reviewers are quality only.
- The runtime choice for scripts.
- Probes: `HOME` on the pinned omp, omp's helper socket paths, the arena clone step.
- A feature request to Stencil: `/usage` through the auth gateway.
