# The box layout: one home, three mounts, an installed host copy

Date: 2026-11-07. Status: superseded by `0016-agent-user.md` (2026-11-08). Owner decisions on 2026-11-07 (design talk of that day): no per-session container, and the mac runs an installed copy of underground. The rest of the layout was a proposal, not agreed in detail. Amends `0013-agent-box.md` ("The box", "Vanilla omp inside", and N2 under Open), `0014-session-containers.md` (the session container and the layers go; the one long-running VM, its Context, and its Evidence stay), `0001-accepted-risks.md` (amendment "the live checkout"), `0004-no-local-binding.md` and `0011-one-agent-arena.md` (their 2026-11-07 amendments), and `0012-pinned-omp-and-setup.md` ("`git pull` updates its code").

Owner decision, 2026-11-08: the containers go; the agent runs as its own macOS user (`0016-agent-user.md`), which supersedes this ADR once built.

## Context

Sessions are one trust level and share every door (`0011-one-agent-arena.md`, "Why one trust level is enough"; `0013-agent-box.md`, "Safety lives in the doors"). So a session that takes over another gains nothing at the doors. What it can harm in another session is agent work (`../THREAT-MODEL.md`, U21, reversible) and transcripts, which need a backup either way (U37). A split per session stops no irreversible harm, and it cost experimental `container` flags, a relay per session, and the state-layer question (`0014-session-containers.md`). Owner, 2026-11-07: the split is over-design, and it is dropped.

## Decision (proposed)

- **One long-running VM, no container inside it.** The VM of `0014-session-containers.md` stays: one kernel, so omp's SQLite files and session locks work as omp expects. Every session runs in it as one Linux user.
- **One home.** omp runs on its default `~/.omp`: sessions, databases, caches, and worktrees where omp puts them. The repo clones sit in the same home. The home is on the box's own disk, a `container` volume (`0014-session-containers.md`, Open, "The state volume"). No zones, no layers, no moved paths.
- **Read-only root.** The box runs with `--read-only` ("Mount the container's root filesystem as read-only", `docs/command-reference.md`, apple/container `main`, read 2026-11-07). The pinned image holds the Linux omp, git, and the relay. A new omp version is a new image.
- **Three mounts, fixed in the host code.** The gh-broker socket, the egress socket, and a vetted copy of the owner's agent config, read-only (`--mount type=…,source=…,target=…,readonly`, same reference). Nothing else: not the owner's home, not a checkout, and never `--ssh` ("Forward SSH agent socket to container", same reference).
- **The config is a vetted copy, never the owner's folder.** A mount of the config repo itself would show the box its untracked files and its `.git`, the same leak as a mounted checkout. Setup copies the config repo's tracked files at a commit into a folder that only setup writes, as it does for the host code, and keeps the checks of today's wrapper: it refuses a link, a special file, or a file with a token shape or the auth broker's bearer (`../SPEC.md`, B3; `../THREAT-MODEL.md`, U1). The box mounts that copy.
- **Checks after each start.** The mac checks the running box: exactly those mounts, no route (`0008-preflight.md`, amendment 2026-11-07), and the pinned image. If a check fails, the start refuses. Only the mac runs `container`. [inference] The box cannot reach it through the two doors, so it cannot add a mount.
- **Repos are cloned, never mounted.** The box clones each repo from GitHub through the gh-broker door, underground included. The owner's checkout is never mounted, not even read-only under overlayfs. A mount shows the box what is in the checkout but not on GitHub, such as `.env` files, local tokens, and unpushed work (U1). And overlayfs does not allow a lower layer that changes, which the owner's edits would do: "If the underlying filesystem is changed, the behavior of the overlay is undefined" (Linux `Documentation/filesystems/overlayfs.rst`, "Changes to underlying filesystems", `master`, read 2026-11-07).
- **Rebuild.** A rebuild starts a fresh home from the image and the config, and carries over only the transcripts and their attachments (`~/.omp/agent/sessions`, `~/.omp/agent/blobs`). Code planted in the home, such as plugins or native addons (`0014-session-containers.md`, Evidence), does not survive it. The owner rebuilds on demand, or on a schedule. Unpushed work does not carry over (Cost), so before a rebuild the start lists every worktree and clone with unpushed commits or changes, and a scheduled rebuild waits until that list is empty.
- **Crashes fail closed.** A crash can stop work, but it never widens the walls: nothing falls back to running omp on the mac.
  - omp dies: its transcript and worktree are on the box's disk, so the owner resumes the session. [inference] Only the turn in flight is lost.
  - The VM dies or the mac restarts: the disk survives, and the next start boots the box on it.
  - The disk is damaged, or the box was taken over: rebuild, and restore the kept data from the backup.
  - A start check fails: the start refuses and says why.
  - A door service dies: launchd restarts it, and calls from the box fail until then.

  `container run` has no restart policy: its option list names none (same reference). The start does not need one, because it reuses a healthy box, boots a stopped one, and refuses a bad one. Resuming an unattended run on its own after a crash belongs to arkan (`../THREAT-MODEL.md`, K20), not underground.
- **The mac runs an installed copy of underground** (owner decision, 2026-11-07). Setup copies a merged `main` commit of underground into a folder that only setup writes. launchd's services and the start run from that copy, never from the owner's checkout. An update is `git pull`, then setup. A checkout of an agent branch in the owner's folder runs nothing on the mac.
- **The mac side.** `~/.ug` holds only what the mac keeps: the keys and logins, the door sockets, the installed host code, and the backup settings. Candidate (owner, 2026-11-07): fold `~/.ug` into `~/.omp`. The one thing the fold must keep is that a plain omp on the mac finds no login (`../THREAT-MODEL.md`, U36, U15).

## Open

- Run on the owner's mac 2026-11-07: the egress door is the launchd service `com.underground.egress` (`KeepAlive`), run from `~/.ug/sys/egress`, a copy that setup writes; a running box kept reaching a model after `launchctl kickstart -k` of the door. `ug-box` runs from `~/.ug/sys/box`, a copy that setup writes of everything it reads (`host/bin/ug-box`, `ug-box-check.ts`, `host/lib/box-image.bash`, `host/lib/backup-target.bash`, `host/secret-patterns`, `host/gh-broker/{client,protocol}.ts`, `VERSIONS`, `box/*`), linked as `~/.ug/sys/bin/ug-box`; setup also builds the box image (`../THREAT-MODEL.md`, U4).
- Run on the owner's mac 2026-11-08: a launchd run of the backup saved the box's home (tag `ug-box`); `ug-box-restore` saved the old home (tag `ug-box-prerestore`), created a capped volume (`container volume inspect`: `"size" : "64g"`, `"sizeInBytes" : 68719476736`), filled it from snapshot `3add7f33`, and a session on it answered (`../THREAT-MODEL.md`, U37, U22). From #80 on, the restore wakes the backup target and puts it back to sleep, as the backup does.
- The fold of `~/.ug` into `~/.omp`, and the removal of the srt design: the wrapper, `host/arena/init`, the zones, the probes and their tests, the docs and glossary terms.
- The switch (2026-11-08): step 1, setup links `~/.ug/sys/bin/omp` to the installed `ug-box`, so `omp` starts a box session; the srt wrapper stays reachable as `omp-arena` until its removal. Step 2, the gh-broker, usage broker, and backup run from `~/.ug/sys/services`, a copy that setup writes. Next: the removal of the srt design.

- 2026-11-07: done. The srt wrapper, `host/arena/init`, the probes, and their tests were removed in #90 (commit 54a418a1). `~/.ug/sys/bin/omp` links to `ug-box` (`host/bin/ug-setup:185`).
- Not run on the owner's mac yet: sessions in the clone with omp's own worktree (#69). Run on the owner's mac on 2026-11-07: the box with its start check, the model door, clone and status through the gh-broker door, the config copy, and the raw-request refusals of the gh-broker (`../THREAT-MODEL.md`, "The box against each row").

## Rejected

- A container per session inside the VM (`0014-session-containers.md`): it stops no irreversible harm (Context).
- Mounting the owner's checkout, with or without overlayfs (Decision, "Repos are cloned, never mounted").
- Running the host code from the owner's live checkout (`0001-accepted-risks.md`, amendment "the live checkout"): an agent branch checked out there runs on the mac with every key.

## Cost

- Sessions share one home. A taken-over session can change other sessions' work and plant code that later sessions load, until a rebuild.
- Sessions share one loopback, such as omp's `/stats` port `127.0.0.1:3847` (`0004-no-local-binding.md`, amendment "loopback allowed").
- An update of the host code or of the config needs a setup run, not just `git pull` or an edit.
- A rebuild loses unpushed work, which U37 names as data the owner cannot rebuild. After a takeover that work is agent-written and untrusted anyway; otherwise the list before a rebuild lets it be pushed first.

## Amendment 2026-11-07: the first build, a trial

Owner, 2026-11-07: build to find out what discussion cannot. The first build, `host/bin/ug-box` and `box/`, tries a different layout from the Decision above, and its results decide between them:

- **One box per repo**, not one for all. It mounts the repo's top folder read-only, so the fixed-mounts problem of a shared box goes away. The cost: omp's sessions and history are per repo.
- **ovnfs checkouts** on top of that mount, at the repo's `origin/HEAD` (or `origin/main`) as the owner's checkout last fetched it, never the owner's working files, so a push cannot carry unpushed local edits. ovnfs mounts without any added permission inside the agent's own user and mount namespace; the owner's runs of 2026-11-07 showed it in a `--network none`, `--read-only` box with omp 18.18.0, which first works with ovnfs (omp CHANGELOG, 18.17.0). So the box's omp pin is 18.18.0 (`VERSIONS`, `box_omp`).
- **Sessions counted on the mac.** The first session boots the box, later ones join it, the last one to quit stops it; a box on an older image refuses new sessions until its last one quits.

Not in the trial: the doors (no model, no gh-broker), the config, and the start check of the running box, which waits for a real `container inspect` reply to read. So the trial box is not for unattended use. A read-only mount shows the box every file in the repo folder, ignored ones such as `.env` included; the owner accepts this (2026-11-07: no repo keeps secrets there).

## Amendment 2026-11-07: clones through the gh-broker, one box again

Owner decision, 2026-11-07: the box clones each repo through the gh-broker door instead of mounting the owner's checkout, so the owner's local work is never in the box. With no repo mount, the fixed-mounts problem is gone, and one box (`ug-box`, home volume `ug-box-home`) serves every repo, with omp's history shared across them. The allowlist of repos is the gh-broker app's installation: `gh-broker sync` refuses a repo without it, and the gh-broker runs on the mac. A session started outside a repo gets a scratch folder and no clone.

- The box's `gh-broker` command is the gh-broker's own client (`host/gh-broker/client.ts`), run by the Bun inside the pinned omp (`BUN_BE_BUN=1 omp`; the owner's run of 2026-11-07 printed `1.4.4`), so the box needs no Node.
- The box has four mounts, all checked from the mac: `/tmp`, its home volume, the egress door, and the gh-broker door (`~/.ug/run/gh-broker.sock`). The check refuses any folder of the mac.
- Each session syncs the clone under a lock, checks it out detached at `origin/<default branch>`, and starts omp there. omp's own `worktree.onStart: create` and `worktree.onExit: remove`, from the owner's config repo, give each session its own worktree and `wt/<time>` branch and remove it when clean (owner decision, 2026-11-07). In omp 18.18 ovnfs does not make that worktree: omp uses it for isolated subagents, for any extra copy the agent opens (its system prompt says so when the ovnfs binary is found), for searches inside a copy, and in its git guard (omp `task/structured-subagent.ts:889`, `prompts/system/system-prompt.md:147`, `ovnfs/search.ts`, `exec/bash-executor.ts:737`, tag v18.18.0, read 2026-11-07).
- Open: github.com stays on the egress allowlist, so the agent can also clone any public repo directly; that brings code in and sends nothing out.
