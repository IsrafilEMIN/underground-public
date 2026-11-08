# The agent user: a macOS user of its own, no containers

Date: 2026-11-08. Status: proposed. Owner decision of 2026-11-08: remove all the containers, and run the agent as its own macOS user. The owner does not log in as that user; sessions start from the owner's terminal. The agent works in the user's own home, and damage stays in that home. The parts under Open are not decided yet. Once built, this ADR supersedes `0013-agent-box.md`, `0014-session-containers.md`, and `0015-box-layout.md`, and amends `0001-accepted-risks.md` (U3, U14).

## Context

The box (`0013-agent-box.md`, `0015-box-layout.md`) puts the agent in a Linux VM with no network. It reaches the mac only through two doors. Building it and running it brought costs that come from the VM, not from the problem:

- A Linux image to build and pin, and a second omp pin for Linux (`VERSIONS`: `box_omp=18.18.0` beside `omp=18.13.2`).
- `--network none` is not documented in `container` 1.7.1, so each start has to check for it (`0013-agent-box.md`, Cost).
- A relay inside the box, because omp, git, and npm reach a proxy by host and port, not by socket (`0013-agent-box.md`, Open).
- A home on a volume that the backup can read only through `container exec` or a throwaway container (`../THREAT-MODEL.md`, U37).
- omp features that need macOS do not work in the box (`0014-session-containers.md`, Cost).

The harm that the owner wants walled is harm to the owner's own files and logins. macOS already walls a user's files from other users that are not admins. [inference] A standard user cannot write the owner's files, cannot read files that the owner keeps at mode 600 or 700, cannot signal the owner's processes, and cannot use `sudo`.

## Decision (proposed)

- **No containers.** No Apple `container` VM, no image, no volume, no relay. `host/bin/ug-box`, `host/bin/ug-box-check.ts`, `host/bin/ug-box-restore`, `host/lib/box-image.bash`, `box/`, and their tests go when the agent user is built.
- **One agent user.** A standard macOS user, not an admin, made by setup, the one step that needs root. It is hidden from the login window, and the owner never logs in as it.
- **Sessions start from the owner's terminal.** `omp` on the owner's `PATH` starts the pinned macOS omp as the agent user (draft: `sudo -u <agent user> -i`, under a sudoers rule that allows only that one command). No logout, no second login.
- **One home, on omp's defaults.** omp runs on the agent user's `~/.omp`: sessions, databases, caches, and worktrees where omp puts them. The repo clones sit in the same home. As in `0015-box-layout.md`, sessions are one trust level and share the home (`0011-one-agent-arena.md`, "One trust level").
- **The wall is the user account.** The agent writes only its own home and the folders that every user can write. The owner's home is private to the owner (Open, "The owner's home").
- **Repos are cloned through the broker, never shared.** The agent clones each repo into its own home through the broker socket, as in the box (`0015-box-layout.md`, amendment "clones through the broker"). The owner's checkouts stay in the owner's home, out of reach.
- **No network wall for now** (owner decision, 2026-11-08). The agent user shares the mac's network: every site, the LAN, the tailnet, and every service on localhost. `../THREAT-MODEL.md` U3 and U7 are accepted by name, and U14 widens from the allowlist to every site.
- **Kept, as a candidate:** the broker and its merge gate, the auth broker and gateway, the installed copy of the host code (`0015-box-layout.md`, "The mac runs an installed copy"), setup with its pins, and the backup. Each is checked against the agent user under Open.

## Open

- **The owner's home.** A new macOS user's primary group is `staff`, as is the owner's [inference, macOS default]. If the owner's home folder lets its group read it, the agent user reads every file there that is group- or world-readable, such as dotfiles at mode 644. Draft: setup sets the owner's home to mode 700 and refuses to finish if it is not.
- **The broker socket.** It sits in `~/.ug/run` in the owner's home, which the agent user cannot reach once that home is private. It moves to a folder outside the owner's home that the agent user can use but not write, such as a folder owned by the owner with a group that holds only the agent user.
- **The model door.** With no network wall, the egress proxy no longer limits anything. It still keeps the gateway bearer out of the agent's home, but the agent can call the gateway through it anyway, so the bearer adds no reach. Draft: the egress proxy goes, and the agent's `models.yml` names the gateway with its bearer, as before the box.
- **The config.** Setup or the start copies the vetted config into the agent user's `~/.omp/agent`, with today's checks (`0015-box-layout.md`, "The config is a vetted copy").
- **Mac data through the owner's terminal.** macOS asks for camera, microphone, and screen access per app, and a process started from the owner's Terminal may count as Terminal for those checks [inference]. Whether `sudo -u` keeps the owner's clipboard and Apple events in reach is not checked. A probe decides U2.
- **Shared folders.** `/tmp`, `/Users/Shared`, and other folders that every user can write are in reach. A file planted there runs on the host only if an owner tool loads it (U4). Not yet listed.
- **Other users' processes.** [inference] `ps` shows every user's processes and their arguments, so a secret on a command line of the owner leaks to the agent.
- **The disk cap (U22).** Draft: the agent's home on its own APFS volume with a quota, so a full home does not fill the mac's disk.
- **The backup (U37).** The backup runs as the owner, who cannot read the agent's private home. Draft: the backup runs as root under a launchd daemon, or the agent's home grants the owner read access.
- **The rebuild.** Delete the agent's home and make it again, or restore it from a snapshot. Planted code, such as plugins or native addons in `~/.omp`, does not survive a fresh home.
- **The user's name, its id, and its shell.**

## Rejected

- The box (`0013-agent-box.md`): the costs under Context, for a wall whose file side a user account gives too.
- A second login: the owner does not want to log out and in to use the agent.
- An admin agent user: an admin can run `sudo` and write `/Applications` and other shared folders [inference].

## Cost

- No network wall: the agent can send any data that it reads to any site (U3, U14), and it reaches every service on localhost, the LAN, and the tailnet (U7). The usage broker checks no caller token (`host/broker/usage-broker.ts:83`), so the agent can read usage.
- The agent shares the mac's kernel and the owner's macOS. A local privilege escalation in macOS reaches the owner.
- No read-only root. Code planted in the agent's home loads in later sessions until a rebuild, as in the box.
- Setup needs root once to make the user, and again for each change of the sudoers rule.
