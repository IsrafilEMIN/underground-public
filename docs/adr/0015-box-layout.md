# The box layout: one home, three mounts, an installed host copy

Date: 2026-11-07. Status: proposed. Owner decisions on 2026-11-07 (design talk of that day): no per-session container, and the mac runs an installed copy of underground. The rest of the layout is a proposal, not yet agreed in detail. Amends `0013-agent-box.md` ("The box", "Vanilla omp inside", and N2 under Open), `0014-session-containers.md` (the session container and the layers go; the one long-running VM stays), and `0001-accepted-risks.md` (amendment "the live checkout").

## Context

Sessions are one trust level and share every door (`0011-one-agent-arena.md`, "Why one trust level is enough"; `0013-agent-box.md`, "Safety lives in the doors"). So a session that takes over another gains nothing at the doors. What it can harm in another session is agent work (`../THREAT-MODEL.md`, U21, reversible) and transcripts, which need a backup either way (U37). A split per session stops no irreversible harm, and it cost experimental `container` flags, a relay per session, and the state-layer question (`0014-session-containers.md`). Owner, 2026-11-07: the split is over-design, and it is dropped.

## Decision (proposed)

- **One long-running VM, no container inside it.** The VM of `0014-session-containers.md` stays: one kernel, so omp's SQLite files and session locks work as omp expects. Every session runs in it as one Linux user.
- **One home.** omp runs on its default `~/.omp`: sessions, databases, caches, and worktrees where omp puts them. The repo clones sit in the same home. The home is on the box's own disk, a `container` volume (`0014-session-containers.md`, Open, "The state volume"). No zones, no layers, no moved paths.
- **Read-only root.** The box runs with `--read-only` ("Mount the container's root filesystem as read-only", `docs/command-reference.md`, apple/container `main`, read 2026-11-07). The pinned image holds the Linux omp, git, and the relay. A new omp version is a new image.
- **Three mounts, fixed in the host code.** The broker socket, the egress socket, and the owner's agent config, read-only (`--mount type=…,source=…,target=…,readonly`, same reference). Nothing else: not the owner's home, not a checkout, and never `--ssh` ("Forward SSH agent socket to container", same reference).
- **Checks after each start.** The mac checks the running box: exactly those mounts, no route (`0008-preflight.md`, amendment 2026-11-07), and the pinned image. If a check fails, the start refuses. Only the mac runs `container`. [inference] The box cannot reach it through the two doors, so it cannot add a mount.
- **Repos are cloned, never mounted.** The box clones each repo from GitHub through the broker door, underground included. The owner's checkout is never mounted, not even read-only under overlayfs. A mount shows the box what is in the checkout but not on GitHub, such as `.env` files, local tokens, and unpushed work (U1). And overlayfs does not allow a lower layer that changes, which the owner's edits would do: "If the underlying filesystem is changed, the behavior of the overlay is undefined" (Linux `Documentation/filesystems/overlayfs.rst`, "Changes to underlying filesystems", `master`, read 2026-11-07).
- **Rebuild.** A rebuild starts a fresh home from the image and the config, and carries over only the transcripts and their attachments (`~/.omp/agent/sessions`, `~/.omp/agent/blobs`). Code planted in the home, such as plugins or native addons (`0014-session-containers.md`, Evidence), does not survive it. The owner rebuilds on demand, or on a schedule.
- **Crashes fail closed.** A crash can stop work, but it never widens the walls: nothing falls back to running omp on the mac.
  - omp dies: its transcript and worktree are on the box's disk, so the owner resumes the session. [inference] Only the turn in flight is lost.
  - The VM dies or the mac restarts: the disk survives, and the next start boots the box on it.
  - The disk is damaged, or the box was taken over: rebuild, and restore the kept data from the backup.
  - A start check fails: the start refuses and says why.
  - A door service dies: launchd restarts it, and calls from the box fail until then.

  `container run` has no restart policy: its option list names none (same reference). The start does not need one, because it reuses a healthy box, boots a stopped one, and refuses a bad one. Resuming an unattended run on its own after a crash belongs to arkan (`../THREAT-MODEL.md`, K20), not underground.
- **The mac runs an installed copy of underground** (owner decision, 2026-11-07). Setup copies a merged `main` commit of underground into a folder that only setup writes. launchd's services and the start run from that copy, never from the owner's checkout. An update is `git pull`, then setup. A checkout of an agent branch in the owner's folder runs nothing on the mac.
- **The mac side.** `~/.ug` holds only what the mac keeps: the keys and logins, the door sockets, the installed host code, and the backup settings.

## Open

- The config mechanism: where each read-only item is mounted for omp to find. omp has run with a read-only `config.yml` only in `-p` mode (`0014-session-containers.md`, Evidence); interactive use is untested.
- The backup of the box's disk, and whether a rebuild carries prompt history (`history.db`) as well.
- How a session starts from the mac.
- The doors against a hostile caller (`0013-agent-box.md`, Open).
- Nothing in this ADR is tested yet.

## Rejected

- A container per session inside the VM (`0014-session-containers.md`): it stops no irreversible harm (Context).
- Mounting the owner's checkout, with or without overlayfs (Decision, "Repos are cloned, never mounted").
- Running the host code from the owner's live checkout (`0001-accepted-risks.md`, amendment "the live checkout"): an agent branch checked out there runs on the mac with every key.

## Cost

- Sessions share one home. A taken-over session can change other sessions' work and plant code that later sessions load, until a rebuild.
- Sessions share one loopback, such as omp's `/stats` port `127.0.0.1:3847` (`0004-no-local-binding.md`, amendment "loopback allowed").
- An update of the host code needs a setup run, not just `git pull`.
