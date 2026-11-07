# Layers inside the box: one long-running VM, a Linux container per session

Date: 2026-11-07. Status: proposed. Owner decision on 2026-11-07, after the design talk of that day: the layout below is agreed, and the items under Open are not decided. Amends `0013-agent-box.md`: its "The box" and "Vanilla omp inside" lines give way to the layers here; its doors, egress, and host-service decisions stand.

## Context

`0013-agent-box.md` gave the box two jobs: be the wall between the agent and the mac, and be the unit that a session throws away. Apple `container` makes every container its own VM with its own kernel (`docs/volumes.md` and `docs/command-reference.md`, apple/container 1.7.1, read 2026-11-07), so a box per session would split omp's shared state across kernels, and omp's shared state needs one kernel:

- omp keeps its shared databases in SQLite WAL mode: `PRAGMA journal_mode=WAL;` in `packages/coding-agent/src/session/agent-storage.ts:253` and `history-storage.ts:134`, and in `session-index.ts:100` (omp v18.13.2, commit `e996e1c`, read 2026-11-07). SQLite's source says: "Because the wal-index is shared memory, SQLite does not support journal_mode=WAL on a network filesystem. All users of the database must be able to share memory." (`src/wal.c` header comment, sqlite/sqlite on GitHub, master, read 2026-11-07; line numbers not checked.)
- omp's session lock is `tryAcquireFileLock(lockPath)` (`session-storage.ts:640`), and on Linux that lock is kernel-local: "Linux uses abstract Unix sockets" (`packages/utils/src/file-lock.ts:4` to `:5`). [inference] A second kernel cannot see it, so two VMs could both write one session.
- omp checks no filesystem type before it opens these files; it assumes one host (search of the session and utils sources for nfs, virtiofs, statfs, and network-filesystem wording found none, read 2026-11-07).

So the two jobs go to two layers.

## Decision (proposed)

- **The wall: one long-running VM.** Apple `container`, `--network none`, one kernel (`0013-agent-box.md`, Evidence). It runs while sessions run and restarts from the pinned image when the image changes. Every session runs on its kernel, so omp's SQLite files and session locks work as omp expects.
- **A throwaway Linux container per session, inside the VM.** It shares the VM's kernel and has its own mounts and processes. It can write its own worktree, its own session folder, its own agent database, its own `config.yml`, and the shared history database. It reads the config layer and the other sessions' transcripts and attachments read-only, and it cannot see the other sessions' worktrees or processes. When the session ends, its container goes.
- **Its own network namespace and relay.** Each session container has its own loopback and its own relay to the egress socket, so sessions cannot reach each other's local ports. With one shared namespace, a session that held `127.0.0.1:3847` would serve omp's `/stats` page to the others (`0004-no-local-binding.md`, amendment "loopback allowed").
- **Image layer, read-only.** The pinned Linux base and the Linux omp, rebuilt only when a pin changes.
- **Config layer, read-only.** The owner's agent-config repo, in the places where omp already looks for each item. Nothing is copied into the box or reset at a start.
- **State layer: data only, on one volume of the VM.** Shared across sessions only where omp reads it as data:

| state | shared across sessions | why |
|---|---|---|
| session transcripts | yes | per-session files (`sessions/<working folder>/`, `session-paths.ts:222` to `:223`); omp lists and resumes from the files (`session-listing.ts:699` to `:736`, `:1308` to `:1312`) |
| attachments (`agent/blobs`) | yes | session files refer to them by hash (`blob-store.ts:8`) |
| history database: prompt history, titles, recaps | yes | data only; its rebuild reads only its own tables (`history-storage.ts:382` to `:442`); titles are a cache that omp fills by scanning session files (`session-index.ts:1` to `:14`, `session-listing.ts:1407` to `:1416`) |
| stats database | yes | rebuilt from the session files (`syncAllSessions`, `packages/stats/src/aggregator.ts`, v18.13.2; line numbers not checked) |
| pins (`agent/session-pins.json`) | yes | a list of session ids (`session-pins.ts:9` to `:19`) |
| agent database | no, one per session, thrown away | "Unified SQLite storage for agent settings, model usage, and auth credentials" (`agent-storage.ts:174`); its legacy `settings` rows are copied into `config.yml` when that file is missing (`:484` to `:509`), and every fresh session starts without one, so a shared agent database would carry settings, and with them code paths, into later sessions |
| `config.yml` | no, one per session | the owner's settings come from the config layer |

- **The rule for the state layer.** Shared state holds only what omp reads as data. Anything that can turn back into config or code is per session or read-only. A resumed session carries its own transcript, injection included; that is what resume means, and the per-session container limits it to that session.

## Evidence

- Cost of a box, owner runs on this mac, 2026-11-07, `container` 1.7.1: `container run --rm --network none python:alpine true` took 0.95 s, 0.89 s, and 0.95 s; an idle box (`sleep 600`) showed `1.88 MiB / 1.00 GiB` memory in `container stats --no-stream`. That figure is inside the VM; the cost of the VM on the mac is not measured.
- What survives a fresh agent database and history database per session, from the omp source at v18.13.2 (read 2026-11-07): resume, continue, and the session picker work from the session files; titles are rescanned; `/stats` rebuilds. Prompt history, recaps, and pins (`session-pins.ts:9` to `:12`) do not rebuild from session files. This is why the history database is shared and only the agent database is per session.

## Open

- The session container itself: which Linux runtime inside the VM (srt on Linux, bubblewrap, or another), and a test in one box: two session containers, each writing only its own folders, one shared database written by both at once, and neither able to touch the other's files.
- The per-session write folder for session files: omp names the folder after the working folder (`session-paths.ts:222` to `:223`), so the start step must pick the worktree path and start omp in it, and give the container write access to that one folder. Not tested.
- The state volume: a container volume, which is an ext4 disk image inside the VM (`docs/volumes.md`, 1.7.1), keeps SQLite's locks plain Linux locks; a folder shared from the mac is untested for them. The backup then needs a way to read the volume.
- The config layer mechanism: rules and skills mounted read-only where omp reads them, and settings through omp's read-only settings layer (`PI_CONFIG_FILES`), which ranks above the global `config.yml` (omp `docs/settings.md`, "Layers", read 2026-11-07). `0011-one-agent-arena.md` rejected `PI_CONFIG_FILES` as a workaround for a shared home; using it here as omp's own read-only layer reverses that line of 0011 and needs the owner's decision.
- The image: base image and which Linux omp build. v18.13.2 ships `omp-linux-arm64` and `omp-linux-musl-arm64` (release assets, read 2026-11-07); which libc the plain build needs is not confirmed. Also what the image carries for omp features such as the browser tool.
- Whether the auth broker and the usage broker move to the tailscale address (`0013-agent-box.md`, "Host services on tailscale first"). The usage broker checks no caller token (`host/broker/usage-broker.ts:83`, `:38` to `:42`), so on the tailnet any device could read usage.
- The broker door (deferred by the owner), how a session starts, and where the host code runs from (N2).

## Rejected

- A VM per session sharing one home: two kernels on WAL databases and kernel-local session locks (Context).
- A VM per session with its own home: safe, but prompt history, recaps, and pins do not carry across sessions, and sessions at once do not share state.
- Two VMs, a long-running one that holds the state and a throwaway one that mounts it: the state is again written by two kernels.
- One long-running VM with no per-session container: a taken-over session can change every other session's files and processes.

## Cost

- Sessions share one kernel, so a kernel escape from one session reaches the others. A VM per session would not share it, but it splits omp's state (Rejected).
- A container runtime inside the VM to pin and configure.
- omp features that need macOS do not work in the box: Apple's on-device model and macOS spelling prediction.
- The history database is the one write path between sessions that the session container does not close: a taken-over session can rewrite other sessions' prompt history, titles, and recaps, and recalling a poisoned prompt sends it again. A history database per session would close it, at the cost of prompt history across sessions (Evidence).
