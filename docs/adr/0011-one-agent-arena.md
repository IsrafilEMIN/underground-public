# One agent arena

Date: 2026-11-02. Owner decision. Supersedes `0002-role-homes.md`, `0009-one-omp-root.md`, and `0010-shared-sessions-and-state.md`. Amends `0005-model-auth-gateway.md`, `0006-reviewer-roles-gate.md`, and `0008-preflight.md`. The design is in `../PRODUCT-BRIEF.md`.

## Context

The first design drew the line between the agent and the owner as a list of paths inside the owner's home. omp assumes that it owns its home, so each normal omp action crossed that line, and each crossing needed a patch: the split omp root and the policy pins (`0002-role-homes.md`), `PI_CONFIG_DIR` and the one-by-one `XDG_*` and `CARGO_HOME` moves (`host/bin/omp:386` to `:399`), `skillLinkRoots` (`host/sandbox/srt-settings.template.json:2`), the subagent rules hook and the moved reviewer stores (`0009-one-omp-root.md`), and `drop_secret_env` (`0008-preflight.md`). A deny list fails open when a new omp version loads code from a new path (`0002-role-homes.md`, cost). Role separation added per-role homes, sessions, state, and stores.

## Decision

- **One arena.** The agent has one home, `~/.ug/home`. The wrapper sets `HOME` to it, so omp, its caches, its helpers, and its worktrees live there on omp's default paths and default profile. srt grants writes on the arena only.
- **omp runs unchanged.** No `PI_CONFIG_DIR`, no `PI_CONFIG_FILES` overlay, no policy pins, no per-path moves.
- **Clean environment.** The wrapper starts omp with named variables only, not the owner's shell.
- **Config from the owner's repo.** The owner keeps the agent config (`AGENTS.md`, skills, hooks, MCP config, settings, no secrets) in a private repo in the owner's zone, laid out like omp's `~/.omp/agent`. The owner's local folder is the source of truth. The wrapper copies it into `~/.ug/home/.omp/agent` at each start.
- **Clones in the arena.** The agent works in its own clone of each repo in the arena, proposed at `~/.ug/home/work/<owner>/<repo>`, never in the owner's checkout. The clone is made and updated only inside the sandbox, with `broker sync`. The host never runs git in the arena.
- **One trust level.** Author and reviewers share the arena. The reviewers are a quality step, not a safety wall. Their rules come as skills in the config repo.
- **Strict sockets.** `allowUnixSockets` lists only the broker sockets in `~/.ug/run` and omp's helper sockets.
- **Zones.** `~/.ug/sys` (owner zone, read only), `~/.ug/run` (sockets), `~/.ug/host` (no access), `~/.ug/home` (the arena), and the owner's zone (no access).

## Why one trust level is enough

Role separation protects the review, and the review protects only the merge. A reviewer reads text that the author wrote, so the diff itself can carry an injection that no home isolation stops [inference]. The harm of a weak review is a bad merge. Onboarding checks 5 and 6 (`../SPEC.md`) keep a merge reversible: a deploy, a publish, or a job with secrets on `main` waits for the owner, and a repo whose code runs on the host gets no auto merge. So a weak review leads only to a revert. The other damage that a revert cannot undo (the use of a brokered credential, data out to an allowlisted domain, spend) happens during the session, where no reviewer is involved.

## Rejected

- One arena with one omp profile per role (`omp --profile <role>`). omp separates a profile's config, auth, sessions, and caches (omp `docs/config-usage.md:76` to `:82`, read 2026-11-02), but it does not enforce it: every profile lives in one `~/.omp` that one user writes [inference]. Keybindings, `~/.claude`, `~/.codex`, `~/.gemini`, the root files of `~/.omp`, and non-omp caches are shared across profiles (`config-usage.md:84`, `:88`). Each needs its own srt rule, so the path list comes back.
- One home per role. It is safe by structure, but one trust level makes it unneeded.
- The agent in the owner's checkout. A host `git`, direnv, or editor would run agent-written `.git` hooks, `.git/config`, `.envrc`, or tasks (U4). Avoiding that needs a deny list of every file that a host tool runs, which fails open.
- A VM or a container. It gives reset, its own localhost, and its own user. But the brokers, the gateway, the egress allowlist, the merge gate, and the config copy stay the same, and it adds an image, repo sync, an egress proxy, Linux only, more memory, and slower starts. srt is light. The arena can move into a VM later; the rest stays.
- Unix sockets allowed in the whole arena. An agent can make a link in the arena to a socket outside it, and it is not known whether macOS checks the link path or the real path on connect [inference].

## Cost

- srt is a filter on the owner's macOS user, not a wall. Localhost stays open to every port for now (`0004-no-local-binding.md`).
- A session can damage another repo's clone or unpushed work in the arena (U21). Only agent work is lost.
- A change that the agent makes to its own config lasts until the next start.
- The arena clone holds GitHub's `main`, not the owner's unpushed edits.
- To verify: that omp, bun, and git honor `HOME` on the pinned omp; the paths of omp's helper sockets (`../SPEC.md`, Checks). A tool that ignores `HOME` fails on the srt deny; it does not leak.

## Amendment 2026-11-03: worktrees

omp owns the session worktree. The config repo sets `worktree.onStart: create` and `worktree.onExit: remove`: a fresh interactive session starts in a new worktree on a `wt/<timestamp>` branch made from the arena clone's `HEAD`, and at exit omp removes the worktree and the branch when it has no change and no commit, and asks otherwise (omp 18.13.2, `worktree-cli.ts` and the exit handler, read 2026-11-03; tested in the arena the same day). The clone is the base, not a place of work: `host/arena/init` keeps its `HEAD` detached at `origin/<default>`. After a session quits, `init` runs `broker sync` in the background and then `git checkout --detach origin/<default>`, so the next session starts from the current `main` with the clone's files at that commit. A detached checkout moves the files without force: it refuses when a real edit in the clone would be overwritten, and leaves the clone as it was. The first form of this amendment made `HEAD` a symbolic ref to `refs/remotes/origin/<default>` and let the sync move it (`--update-head-ok`, `host/broker/client.ts`, which stays); that left the clone's index and files at the old commit after each sync, and `/wt` from such a clone carries that lag into the new worktree as staged deletions (tested 2026-11-03). The broker accepts `wt/*` next to `agent/*` (`AGENT_BRANCH_RE`, `host/broker/protocol.ts`).

Known holes, accepted: a resumed session whose worktree is gone opens in the clone, and the agent reports that (`AGENTS.md`); a headless `omp -p` works in the clone; `remove` deletes a worktree whose only changes are gitignored files; a worktree with commits is never removed by omp, only by `broker merge`.

## Amendment 2026-11-07: the agent box (proposed)

`0013-agent-box.md` is proposed, not built. Until it is built, this ADR describes the system. Once built, it supersedes this ADR except "One trust level" and its reasoning, which still hold. The arena, the zones, srt as the sandbox, the strict socket list, the config copy at each start, and the clone made by `host/arena/init` go: the agent gets one long-running VM with no network, reaches the host only through sockets that the host mounts in, and runs each session in its own throwaway Linux container inside the VM (`0014-session-containers.md`). Sessions stay one trust level. A session can no longer change another session's worktree, session files, or processes, which narrows the cost "A session can damage another repo's clone or unpushed work in the arena (U21)" above; the shared history database stays writable by every session (`0014-session-containers.md`, Cost). The rejection of "A VM or a container" above is reversed. Its costs still apply and are listed in `0013-agent-box.md` and `0014-session-containers.md`, Cost. It weighed srt as light; the 2026-11-07 re-check found what srt leaves open: incoming connections on every interface, with the firewall off on this mac (`0013-agent-box.md`, Context).

Changed by `0015-box-layout.md` (owner decision, 2026-11-07): there is no container per session. All sessions share one home in the box, so the cost "A session can damage another repo's clone or unpushed work in the arena (U21)" above stays as it is, and the claim that the box narrows it no longer holds. A rebuild clears code planted in that home (`0015-box-layout.md`, "Rebuild").
