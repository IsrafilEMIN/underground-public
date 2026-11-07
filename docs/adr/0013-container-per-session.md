# One throwaway container per session

Date: 2026-11-07. Status: proposed, for the owner's decision. Supersedes `0011-one-agent-arena.md` (the arena as the agent's home on the owner's macOS user, srt as the box) and `0004-no-local-binding.md`, and ends the macOS build check that `0008-preflight.md` and `0012-pinned-omp-and-setup.md` kept. Amends `0012` (pins) and `0005-model-auth-gateway.md` (the gateway's address from the box). The brokers, the gateway, the merge gate, and the config copy stay as they are.

## Context

The arena design (`0011-one-agent-arena.md`) keeps the agent on the owner's macOS user and uses srt as a filter: a read deny on `~`, a write grant on `~/.ug/home`, a socket list, a domain allowlist, and `allowLocalBinding: true` because omp's own features need localhost (`../SPEC.md`, B5). Its costs are listed in that ADR: srt is a filter, not a wall; localhost is open to every host port (U7); a macOS build pin and the U1 and U2 probes exist because the filter's behaviour depends on the macOS build (B1); and the arena holds a long-lived clone, a worktree per session, and a background sync after each session (B4), because every session shares one home.

`0011` rejected a VM or container with: "the brokers, the gateway, the egress allowlist, the merge gate, and the config copy stay the same, and it adds an image, repo sync, an egress proxy, Linux only, more memory, and slower starts. srt is light." The owner reopened it on 2026-11-07: a throwaway container per session makes the layered home unneeded, and the credentials can stay on the host in omp's default root, because nothing on the host is mounted into the container.

What a container changes, in the terms of `../PRODUCT-BRIEF.md`:

- The line between the agent and the owner stops being a list of paths on one user. It becomes a list of mounts. A path list fails open (a new omp version adds a path and the deny misses it, `0002-role-homes.md`); a mount list fails closed (a path that is not mounted is lost, not leaked).
- Reset is free: the container is deleted at exit. "A broken arena gets deleted and rebuilt" (principle 5) needs no code.
- U2 (clipboard, keychain, screen, Apple events) and U7 (host localhost and sockets) close by structure: a Linux VM has no mach services and no route to the host's loopback. The U1 and U2 probes and the macOS build pin lose their reason.
- Two crossings move from "srt does it" to "we build it": the broker socket into the container, and the egress allowlist.

## Decision

### Runtime: Apple `container`

Apple's `container` runs each container in its own lightweight VM on the Virtualization framework, mounts only what is named, and gives each container an IP on a vmnet network (apple/container `docs/technical-overview.md`, read 2026-11-07). It needs macOS 26 and Apple silicon (`README.md`, same read); this mac is macOS 27.3 on arm64 (`sw_vers`, 2026-11-07). The current release is 1.7.1 of 2026-11-06 (`releases/latest`, read 2026-11-07).

The features the design needs, each documented in apple/container (read 2026-11-07, `main`):

- Mounts: `--volume` and `--mount ...,readonly` (`docs/command-reference.md`, `container run`). Nothing is shared unless named: there is no shared VM and no file-sharing list like Docker Desktop's.
- A host unix socket inside the container: `--ssh` "performs the equivalent of the options `--volume "${SSH_AUTH_SOCK}:/var/host-services/ssh-auth.sock"`" (`docs/host-integration.md`). So `--volume ~/.ug/run/broker.sock:/run/ug/broker.sock` carries the broker socket [inference from that sentence; the probe below tests it].
- A network with no way out: `container network create --internal` makes a host-only network (`docs/command-reference.md`, "Network Management (macOS 26+)"). `--no-dns` leaves the container without a resolver. Whether a container on an internal network reaches the host at the network's gateway address is not documented; the probe tests it.
- Per-container `--memory` and `--cpus`, `--rm`, `--read-only`, a non-root `--uid`, `--tmpfs`, `-it` for the TUI (`docs/command-reference.md`).

Compared on 2026-11-07:

| runtime | box | what is shared by default | host socket in | egress control | on this mac |
|---|---|---|---|---|---|
| Apple `container` 1.7.1 | one VM per container | nothing; mounts only | `--volume` of a socket path (`--ssh` is built on it) | `--internal` network, `--no-dns`, our proxy on the host | not installed; signed pkg from GitHub, admin password |
| Lima 2.2.1 (VZ, `--plain`) | one VM per instance | nothing in plain mode (`docs/config/plain.md`: mounts, port forwards, agent all off) | not documented for host to guest; ssh only | a full Linux guest per session, with no mounts in plain mode, so state would go over ssh [inference] | installed (`limactl`) |
| Colima 0.10.3 + Docker 29.9 | one shared VM, containers inside | the VM mounts the host home (`embedded/defaults/colima.yaml` could not be read as text through the proxy; its mount default is from memory, unverified) and exposes the Docker socket to the host | a socket mounted twice (host to VM, VM to container) | Docker networks plus our proxy | installed |
| Docker Desktop | one shared VM | `/Users` shared by default [inference, not checked here] | same two hops | same | not installed |

Apple `container` is the lightest that is also a wall: no resident VM when no session runs, no shared file list to cut down, and the two crossings we need are documented features. Lima in plain mode is the fallback if the socket volume or the internal network fails the probe: it is installed, it is a VM per session, and it shares nothing, but state and the broker would go over ssh or a static port forward, which is more to build.

Known limits (`docs/technical-overview.md`, read 2026-11-07): memory freed inside the VM is not returned to macOS until the container stops, which a per-session container does; and a name on a custom network does not resolve by bare hostname, which we do not use.

### The shape

- **Image.** Setup builds one image, `ug-session`, from a `Containerfile` in this repo: a pinned Debian base by digest, `git`, `node` for the broker client, and the pinned `omp-linux-arm64` checked against its SHA-256 (`VERSIONS`: the release has it, `omp-linux-arm64` of v18.13.2 is `5a5f3d46…d208d3`, `releases/expanded_assets/v18.13.2`, read 2026-11-07). The image holds no secret and no config. Setup records the image digest.
- **Start.** The wrapper (`host/bin/omp-arena`, kept name or renamed `ug-session`) still reads `origin`, copies the owner's config repo with the same checks (links, token shapes, the gateway bearer), fills `models.yml`, and starts a clean environment. Then, instead of srt, it runs `container run --rm -it` with:
  - `--network ug` (internal), `--no-dns`, `HTTPS_PROXY`, `https_proxy`, and `PI_PROXY` set to the egress proxy at the network's gateway address.
  - `--volume ~/.ug/run/broker.sock:/run/ug/broker.sock` and `UG_BROKER_SOCKET=/run/ug/broker.sock`.
  - `--mount type=bind,source=<run dir>/config,target=/run/ug/config,readonly` with the config-repo copy and `config-names`, as today.
  - The state mounts (next item).
  - `--uid` of an unprivileged user, `HOME=/home/agent`, `--memory` and `--cpus` from the owner's settings, `TERM` and `LANG`.
  - The entrypoint, `host/container/init`: the config replace step of today's `host/arena/init` (`rm -rf` then `cp -R` for each repo-owned name), then `git clone https://github.com/<owner>/<repo> /home/agent/work/<owner>/<repo>` through the proxy, `git switch -c wt/<timestamp>`, `exec omp` in it.
- **State mounts.** The agent's state that the owner keeps is mounted read-write from the host; everything else is the container's and dies with it. The list is short and named, so a forgotten path is lost, not leaked:
  - `sessions` at `/home/agent/.omp/agent/sessions`, and `blobs` beside it (session attachments [inference from the folder name; check omp]).
  - `history.db` and `stats.db`: SQLite with a `-wal` and `-shm` sibling, so a one-file mount loses the WAL. `init` copies them in at start and out at exit instead. A crash loses that session's prompt history; the session file itself is on the live mount.
  - Where on the host: the owner's `~/.omp/agent/sessions` (owner's ask, 2026-11-07: "go back to the original `~/.omp` structure"). A session the agent wrote can then be opened by any omp on the host that reads `~/.omp`: the wrapper's `omp --resume` opens it in a container, and Tern's omp or a full-path omp opens it on the host. Accepted: a resume on the host is the owner's own act, like a raw start (U36 below). The alternative is `~/.ug/state/sessions`, a folder no host omp reads by convention; the choice is the owner's and changes one path.
- **Repos.** One fresh clone per session, inside the container, from GitHub over the proxy, anonymous, because the repos are public (`../PRODUCT-BRIEF.md`, user and scope). No clone lives on the host, so the host never runs git in agent-written files (U4) by construction, not by rule. The worktree per session goes: the clone is the session's. `broker sync` stays for a rebase (`git fetch` through the proxy does the same for a public repo; `sync` remains the path when a repo turns private, U14). The clone of this repo is 1.1 MB and arkan 2.0 MB (`du`, 2026-11-07), so a clone per start is cheap; the probe measures it (principle 9).
- **Unpushed work.** It dies with the container, like today's worktree hole for a resumed session (`0011`, amendment). At exit, `init` writes a `git bundle` of commits not on `origin` and a patch of the uncommitted change into the state mount under `unpushed/<owner>-<repo>-<timestamp>/`, and the wrapper names them. The next session restores with `git fetch <bundle>` inside the container. The host runs no git on them (U4 rule, unchanged).
- **Egress proxy.** A new host service, `host/broker/egress-proxy.ts`, under launchd like the other brokers: an HTTP CONNECT proxy that allows the entries of `host/network-allowlist` with `@GATEWAY@` filled, refuses every other name with 403, and listens on the `ug` network's gateway address, where only containers on that network reach it. It replaces srt's proxy, which is the only part of srt the design still used. The usage broker (`127.0.0.1:18765`) is reached through it as one more allowlist entry, resolved on the host, so it keeps its loopback bind. The auth gateway keeps its tailscale bind; the proxy tunnels to it.
- **Credentials.** They stay on the host, never mounted: the auth broker's logins, the gateway tokens, the app key, the backup password. The owner's ask of 2026-11-07 is omp's default root for the logins (`~/.omp`), which drops `PI_CONFIG_DIR` from the auth broker's plist, `ug-auth`, and `raw-omp-config.bash`. U36 then reads: an agent in the container cannot start a logged-in omp, because no credential root is mounted; an omp started on the host by the owner is the owner's act. `~/.ug/host` keeps the app key, the backup files, and the addresses file.

### Zones after the change

| where | path | the agent gets |
|---|---|---|
| the container | its own root, `/home/agent` | everything, gone at exit |
| state mounts | `~/.omp/agent/sessions`, `blobs`, the copied `history.db` and `stats.db`, `unpushed/` | read and write |
| broker socket | `~/.ug/run/broker.sock` | connect |
| config copy | `<run dir>/config` | read |
| the egress proxy | the `ug` gateway address | CONNECT to the allowlist |
| everything else on the mac | | nothing |

`~/.ug/home` (the arena as `HOME`) goes. `~/.ug/sys` keeps the pins, the image digest, the wrapper link, and `bin/`. `~/.ug/run` keeps the socket and the run folders. `~/.ug/host` keeps what the agent never sees.

## What goes

The parts that exist only because of srt or the shared arena (read 2026-11-07: `host/bin/omp-arena:184` to `:228`, `host/arena/init:25` to `:107`, `host/bin/ug-setup:37` to `:38`, `:77`, `:120` to `:139`, `:195` to `:209`, `host/broker/client.ts:81` to `:116`, `scripts/probe-arena.sh`, `scripts/probe-u1-u2.sh`, `tests/host/omp-arena.test.ts:158` to `:175`):

- srt: `host/srt/package.json` and lock, the `srt` pin in `VERSIONS`, `install_srt`, `srt_package`, and the pin check in `host/bin/ug-setup`, the settings block and the `exec srt` in `host/bin/omp-arena` (the `denyRead`, `allowRead`, `allowWrite`, `allowUnixSockets`, `allowLocalBinding`, `allowAppleEvents`, `allowPty` lines), and `tests/host/omp-arena.test.ts`'s srt-settings tests.
- The arena home: `HOME=~/.ug/home` in the wrapper and `host/arena/init`, `~/.ug/home` in setup, the `TMPDIR` line, the stale-session cleanup, and the start refusal inside `~/.ug` (the container has no `~/.ug`).
- The arena clone and worktrees: `host/arena/init` lines 62 to 107 (clone, `OMP_WORKTREE_DIR`, the half-made clone check, the temp clone, the background sync and detached checkout), `cleanUpLocal` in `host/broker/client.ts` (the worktree and branch removal after a merge; the container is gone by then), and `worktree.onStart` and `worktree.onExit` in the owner's config repo.
- The macOS build pin and its refusal at start (B1), `scripts/probe-u1-u2.sh` and its test, the srt-specific checks of `scripts/probe-arena.sh` (read deny, write deny, links, the socket link, the home-reach log, `srt-on-bun`) and its test.
- `allowLocalBinding` and `0004-no-local-binding.md` as a live decision; the localhost inventory check (`../SPEC.md`, Checks) stays as an owner habit, not a control.
- `PI_CONFIG_DIR` for the auth broker, `ug-auth`'s `PI_CONFIG_DIR` line, and `host/lib/raw-omp-config.bash` with the `disabledProviders` write to `~/.omp/agent/config.yml`, if the owner moves the logins to `~/.omp` (owner decision pending).
- The agent-bin shim install in setup (`install_arena_files`): the broker shim and the omp link move into the image.

## What stays

- The GitHub broker, its socket, its protocol, the merge gate, the push record, the review records, and `broker review` (B7, B8).
- The auth broker, the auth gateway, and the usage broker (B6).
- The config repo copy with its checks, and the start-time replace of repo-owned names (B3).
- The network allowlist file and the secret patterns file.
- The backup (B10), now of the state mounts only.
- The onboarding checks and the live run (`../SPEC.md`).

## What changes

- `VERSIONS`: `srt` out; `omp_linux_sha256` in; `container` version and the pkg SHA-256 in; the base image digest in.
- `host/bin/ug-setup`: checks `container --version` against the pin and tells the owner to install the pkg when it differs (the pkg wants the admin password, so setup does not run it); builds the image; installs the egress proxy service; stops making `~/.ug/home`.
- `host/bin/omp-arena`: `container run` in place of srt; the mounts and the environment above; the exit step that names unpushed bundles.
- `host/arena/init` becomes `host/container/init`, the image entrypoint.
- `host/launchd/com.underground.egress-proxy.plist`, new.
- `scripts/probe-container.sh`, new, in place of the two probes.
- Docs: `../SPEC.md` B1, B2, B3, B4, B5, B9, B10, and Checks; `../THREAT-MODEL.md` rows U1, U2, U4, U6, U7, U21, U32, U36, U37; `../PRODUCT-BRIEF.md` zones and flows; `../../GLOSSARY.md` for arena, zone, state mount, egress proxy.

## Build order

Each step is one PR, in this order, so that the old design keeps working until step 5.

1. Probe first, build nothing: a throwaway script runs `container` by hand on this mac and answers the open facts: a host unix socket through `--volume` connects; a container on an internal network reaches the gateway address and nothing else; `--no-dns` plus `HTTPS_PROXY` is enough for `git`, `bun`, `npm`, and omp; the cold start time of boot plus clone plus omp. The owner installs the `container` pkg for this step.
2. The egress proxy service and its tests, bound to loopback for the tests and to the `ug` gateway address in the plist.
3. The image: `Containerfile`, the `omp-linux-arm64` pin, the build step in setup, the image digest record.
4. `host/container/init` and the wrapper's `container run`, behind a flag in the wrapper until step 5; the probe script.
5. Cutover: the flag goes, srt goes, the arena goes, with the doc changes above in the same PR. The owner deletes `~/.ug/home` after the backup of its state mounts is confirmed.
6. The logins move to `~/.omp`, if the owner decides so: the plist, `ug-auth`, `raw-omp-config.bash`.

## Cost

- Linux only. A task that needs a macOS toolchain does not run in the box. The owner's repos today are shell and TypeScript (`du` of the two clones, 2026-11-07).
- A clone, an omp start, and a cache warm-up per session. Measured in step 1, judged against principle 9.
- The session folders are keyed by the working directory, so sessions started under `/home/agent/work/<owner>/<repo>` are new folders beside the `--Users-kutluk-.ug-home-work-…` ones (`ls ~/.omp/agent/sessions`, 2026-11-07). The old folders stay readable by path.
- Two parts to build that srt gave us: the proxy and the socket crossing. Both are small; the proxy is the only new service.
- A new runtime to pin, from Apple, young: 1.7.1 with product versions, not semantic ones (`README.md`, Project Status, read 2026-11-07). A breaking CLI change lands as a pin change plus a wrapper change.
- `container system start` keeps a launch agent running while any session runs; nothing stays when none does.

## Open, for the owner

- The state mount's host path: `~/.omp/agent/sessions` (the ask) or `~/.ug/state/sessions` (no host omp reads it by convention).
- The logins' root: `~/.omp` (the ask) or `~/.ug/host/auth` (today). Either way they are never mounted.
- `--memory` and `--cpus` per session.
