# Layers inside the box: one long-running VM, a Linux container per session

Date: 2026-11-07. Status: proposed. Owner decision on 2026-11-07, after the design talk of that day: the layout below is agreed, and the items under Open are not decided. Amends `0013-agent-box.md`: its "The box" and "Vanilla omp inside" lines give way to the layers here; its doors, egress, and host-service decisions stand.

Amended by `0015-box-layout.md` (owner decision, 2026-11-07): the container per session is dropped as over-design, and with it the bubblewrap runtime, the relay per session, and the layers. The one long-running VM and its reason (Context) stay. The rest of this ADR is kept as the record of the runs.

## Context

`0013-agent-box.md` gave the box two jobs: be the wall between the agent and the mac, and be the unit that a session throws away. Apple `container` makes every container its own VM with its own kernel (`docs/volumes.md` and `docs/command-reference.md`, apple/container 1.7.1, read 2026-11-07), so a box per session would split omp's shared state across kernels, and omp's shared state needs one kernel:

- omp keeps its shared databases in SQLite WAL mode: `PRAGMA journal_mode=WAL;` in `packages/coding-agent/src/session/agent-storage.ts:253` and `history-storage.ts:134`, and in `session-index.ts:100` (omp v18.13.2, commit `e996e1c`, read 2026-11-07). SQLite's source says: "Because the wal-index is shared memory, SQLite does not support journal_mode=WAL on a network filesystem. All users of the database must be able to share memory." (`src/wal.c` header comment, sqlite/sqlite on GitHub, master, read 2026-11-07; line numbers not checked.)
- omp's session lock is `tryAcquireFileLock(lockPath)` (`session-storage.ts:640`), and on Linux that lock is kernel-local: "Linux uses abstract Unix sockets" (`packages/utils/src/file-lock.ts:4` to `:5`). [inference] A second kernel cannot see it, so two VMs could both write one session.
- omp checks no filesystem type before it opens these files; it assumes one host (search of the session and utils sources for nfs, virtiofs, statfs, and network-filesystem wording found none, read 2026-11-07).

So the two jobs go to two layers.

## Decision (proposed)

- **The wall: one long-running VM.** Apple `container`, `--network none`, one kernel (`0013-agent-box.md`, Evidence). It runs while sessions run and restarts from the pinned image when the image changes. Every session runs on its kernel, so omp's SQLite files and session locks work as omp expects.
- **A throwaway Linux container per session, inside the VM.** It shares the VM's kernel and has its own mounts and processes. It can write its own worktree and its own session folder. It reads the config layer and the other sessions' transcripts and attachments read-only, and it cannot see the other sessions' worktrees or processes. Which of omp's other files it shares with other sessions is open (Open, the state layer). When the session ends, its container goes.
- **Its own network namespace and relay.** Each session container has its own loopback and its own relay to the egress socket, so sessions cannot reach each other's local ports. With one shared namespace, a session that held `127.0.0.1:3847` would serve omp's `/stats` page to the others (`0004-no-local-binding.md`, amendment "loopback allowed").
- **The session runtime is bubblewrap** (owner decision, 2026-11-07), run as `bwrap --unshare-user --uid 1000 --gid 1000 --cap-drop ALL` with its own network and process namespaces. The box runs with `--masked-path NONE --read-only-path NONE`, which bubblewrap needs for a session's own `/proc`; both flags are experimental in `container` 1.7.1, so the start checks for them like `--network none` (Evidence).
- **Image layer, read-only.** The pinned Linux base and the Linux omp, rebuilt only when a pin changes.
- **Config layer, read-only.** The owner's agent-config repo, in the places where omp already looks for each item. Nothing is copied into the box or reset at a start.
- **State layer: data only, on one volume of the VM.** Reopened on 2026-11-07, because omp's data folder holds code (Evidence, Open); the table below is the first draft. Shared across sessions only where omp reads it as data:

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
- Session containers work inside the box, owner runs on this mac, 2026-11-07, `container` 1.7.1, image `debian:bookworm-slim` with Debian's `bubblewrap` and `python3`. Each session ran as `bwrap --unshare-user --uid 1000 --gid 1000 --cap-drop ALL --unshare-net --unshare-pid --new-session`, with the shared database folder writable, `/state/sessions` read-only except its own folder, and `/work` a fresh tmpfs with only its own folder bound in. Both sessions printed: `uid: 1000 caps: 0000000000000000`; own session folder and own work `WROTE`; the other session's folder `blocked OSError`; the other session's work not visible; `processes visible: 2`; `mount -o remount,rw /state/sessions`, `umount /work`, and `mount -t tmpfs x /work` all `failed`; each bound `127.0.0.1:3847` at the same time. The shared WAL database ended at `(4000,)` rows and `('ok',)` integrity after both wrote 2000 rows at once.
- Two runs before that one failed, and each bears on the design. First, `bwrap: Can't mount proc on /newroot/proc: Operation not permitted` with the box's default settings; it worked once the box ran with `--masked-path NONE --read-only-path NONE`, which clear `container`'s default hidden and read-only `/proc` paths (`docs/command-reference.md`, `container run`, both marked experimental, read 2026-11-07). Second, with no database yet, two sessions that both opened a new database and set WAL at once: one failed with `sqlite3.OperationalError: database is locked`, though Python's busy timeout was 30 s. A fresh state layer would hit the same race on omp's first two sessions [inference: omp opens its history database with a busy timeout and then sets WAL, `session-index.ts:99` to `:100`, the same sequence]. The run that passed created the database once before the sessions started, which is the start rule proposed under Open.
- Not tested by these runs: omp itself in a session container (the sessions ran Python); a nested user namespace made inside a session to win back privileges; links planted in a session's own folder; one session filling the shared volume; a session killed in the middle of a write to a shared database; the VM itself crashing.
- omp runs in session containers, owner run on this mac, 2026-11-07: `omp-linux-arm64` v18.13.2 (SHA-256 `5a5f3d46...d208d3`, `sha256sum -c` printed `OK`; `omp --version` printed `omp/18.13.2`) on `debian:bookworm-slim`, in two bubblewrap sessions as above, each with a stub model on its own loopback, `HOME` a fresh tmpfs with `config.yml` (`{}`) and `models.yml` mounted read-only, and `XDG_DATA_HOME=/state` on one shared folder. Round 1, both started at once on an empty `/state/omp`: `A round 1 exit 0 : Working... stub-ok`, the same for B; omp made `agent.db`, `models.db`, `skill-descriptions.db`, `natives`, and `sessions` there, with one folder per working folder, `--work-A--` and `--work-B--`. Round 2, with `/state/omp/sessions` read-only except the session's own folder: both exited 0, each wrote its new session file only in its own folder, and each write into the other's folder failed with `Read-only file system`. omp ran with its `config.yml` read-only and did not fail. Not exercised: omp in `-p` mode never made `history.db` (the later query found `no such table: history`), so the shared history database, its first-start race, and prompt history across sessions are still untested; the race on `agent.db` did not occur.
- omp's data folder is not data only. With `XDG_DATA_HOME` set and `$XDG_DATA_HOME/omp` present, omp moves its whole data group there, not just sessions and databases (`packages/utils/src/dirs.ts:396` to `:440`, v18.13.2). That group holds code: installed plugins, which load extensions and hooks by themselves (`getPluginsDir`, `rootSubdir("plugins", "data")`, `:700` to `:704`), the managed Python environment (`python-env`, `:788`), the browser relay (`:803`), `remote` (`:724`), and `marketplaces.json` (`:1161`). In the run, omp also put its native addons, `natives`, in the shared folder; omp's docs say that folder "Must be writable only by the user(s) running `omp`: an existing addon of the expected size is reused without re-extraction" (omp `docs/environment-variables.md:572`, read 2026-11-07). A shared, writable data folder would therefore let one session plant code that later sessions load.

## Open

- Decided 2026-11-07 (owner, `0015-box-layout.md`): sessions do not get their own containers. They are one trust level and share every door, so the split stops no irreversible harm. Its costs, a shared loopback and code planted in the home that loads until a rebuild, are listed in `0015-box-layout.md`, Cost.
- Closed 2026-11-07: the shared state layer and the first-session start rule. With one home, omp keeps its data where it puts it (`0015-box-layout.md`). The Evidence on omp's data folder still bears on what a rebuild carries over.
- Closed 2026-11-07: the failure cases of the session container and its write folder. The crash cases of the box are in `0015-box-layout.md`. Still open from that list: a session that fills the box's disk (U22).
- The state volume: a container volume, which is an ext4 disk image inside the VM (`docs/volumes.md`, 1.7.1), keeps SQLite's locks plain Linux locks; a folder shared from the mac is untested for them. The backup then needs a way to read the volume.
- The config layer mechanism: rules and skills mounted read-only where omp reads them, and settings through omp's read-only settings layer (`PI_CONFIG_FILES`), which ranks above the global `config.yml` (omp `docs/settings.md`, "Layers", read 2026-11-07). `0011-one-agent-arena.md` rejected `PI_CONFIG_FILES` as a workaround for a shared home; using it here as omp's own read-only layer reverses that line of 0011 and needs the owner's decision.
- The image: base image and which Linux omp build. v18.13.2 ships `omp-linux-arm64` and `omp-linux-musl-arm64` (release assets, read 2026-11-07); which libc the plain build needs is not confirmed. Also what the image carries for omp features such as the browser tool.
- Whether the auth broker and the usage broker move to the tailscale address (`0013-agent-box.md`, "Host services on tailscale first"). The usage broker checks no caller token (`host/broker/usage-broker.ts:83`, `:38` to `:42`), so on the tailnet any device could read usage.
- The broker door (deferred by the owner) and how a session starts. Where the host code runs from (N2) is decided in `0015-box-layout.md`.

## Rejected

- A VM per session sharing one home: two kernels on WAL databases and kernel-local session locks (Context).
- A VM per session with its own home: safe, but prompt history, recaps, and pins do not carry across sessions, and sessions at once do not share state.
- Two VMs, a long-running one that holds the state and a throwaway one that mounts it: the state is again written by two kernels.
- One long-running VM with no per-session container: a taken-over session can change every other session's files and processes.

## Cost

- Sessions share one kernel, so a kernel escape from one session reaches the others. A VM per session would not share it, but it splits omp's state (Rejected).
- A container runtime inside the VM to pin and configure.
- omp features that need macOS do not work in the box: Apple's on-device model and macOS spelling prediction.
- If the state layer shares the history database, it is a write path between sessions that the session container does not close: a taken-over session can rewrite other sessions' prompt history, titles, and recaps, and recalling a poisoned prompt sends it again. The vanilla allow-list (Open) does not share it, at the cost of prompt history across sessions.
