# Product brief: underground MVP 0.5 (redesign)

Owner decision, 2026-11-02. This brief replaces the design of the first MVP 0.5. `SPEC.md` lists the build work, `THREAT-MODEL.md` the threats and their controls, and `adr/0011-one-agent-arena.md` and `adr/0012-pinned-omp-and-setup.md` the reasons. The code still runs the old design until the spec is built.

## Summary

underground lets the omp coding agent work on the owner's mac and merge its own PRs while the owner is away.

## Problem

The owner runs omp without approvals, but does not trust an unattended run. The owner must watch only to stop harm that cannot be undone.

The first design drew the line between the agent and the owner as a list of paths inside the owner's home. omp assumes that it owns its home: its root, logins, caches, skills, and updates. So each normal omp action crossed the line, and each crossing needed a patch: the split omp root, the policy pins, the `XDG_*` moves, `skillLinkRoots`, the subagent rules hook, `drop_secret_env`, and the reviewer store move (`adr/0002`, `adr/0008`, `adr/0009`). A new omp version can add a new path, so the list never ends [inference].

## User and scope

- One owner: a solo developer, on one macOS laptop, with one macOS user.
- One agent: omp. The owner removes every other agent from the mac.
- Repos: public for now. A private repo reopens the data-out question (U14).

## North star

An unattended agent can only do harm that you can undo.

Before each decision, ask: does this stop an irreversible harm, or keep undo and work possible? If not, it waits.

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
- **Owner zone:** the pinned omp binary, the pinned srt, and `bin/omp`, a link to the wrapper. `bin/` is on `PATH`.
- **Sockets:** the broker sockets and the rendered srt settings. The agent cannot write here, so it cannot plant a socket or a link.
- **Host:** everything the agent gets nothing of: the GitHub App key, the auth broker's logins, the broker's records, the arena backup's password and settings (`SPEC.md`, B10), and the owner's hand-edited broker files, such as the addresses file (owner decision, 2026-11-03).
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

- Agent → broker socket → GitHub, `agent/*` branches only → PR → CI → reviewers → merge gate.
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

- underground: `git pull` in the owner's checkout.
- omp: change the pin, then run setup.
- Config: edit the config repo. The next start copies it.

Setup runs when a pin changes, a host service changes, or macOS updates. It installs the pinned omp and srt, makes the zones and their modes, registers and restarts the launchd services, puts the wrapper on `PATH`, and proves srt on this macOS build.

## What stays

- The auth gateway, the auth broker, and the usage broker.
- The GitHub broker and its merge gate.
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
