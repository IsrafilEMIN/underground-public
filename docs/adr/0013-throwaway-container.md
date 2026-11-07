# A throwaway container per session, in place of srt

Date: 2026-11-07. Proposed; not built. The owner asked for the design and the plan on 2026-11-07, and chose none of the three picks below yet (runtime, egress, mac-only tools); each pick names its default. Amends `0011-one-agent-arena.md` (the rejected container), `0004-no-local-binding.md` (localhost), and `0012-pinned-omp-and-setup.md` (the pins and setup). Nothing in `0001-accepted-risks.md` changes. The design is in `../PRODUCT-BRIEF.md`.

## Context

- The security re-check at `09e90b6` (GHSA-m2gv-c6rg-2gpf, re-read 2026-11-03) left two items open that sit in the box itself: N4, the sandbox may accept incoming connections and nothing checks that the macOS firewall is on; and U7's localhost half, `allowLocalBinding: true` lets a session reach every port on this mac, because srt 0.0.81 has only an on or off switch (`0004-no-local-binding.md`, amendment). The other open items (N1, N3, S1 to S11) are in the broker, the host scripts, and the docs, and no box changes them.
- srt is a filter on the owner's macOS user, not a wall (`0011-one-agent-arena.md`, cost). The brief already says the box can be swapped: "If srt fails us, the arena moves into a VM, and the rest stays" (`../PRODUCT-BRIEF.md`, "What stays").
- `0011-one-agent-arena.md` rejected a container on cost: an image, an egress proxy, Linux only, more memory, slower starts. That cost is unchanged. What changed is that the two open box items have no fix inside srt, and that the rest of the design (brokers, gateway, config copy, worktrees, merge gate) is now built and does not move.
- Apple's `container` runs one lightweight VM per container on macOS 26 and later, passes a host folder into the container with `--volume`, and gives each container an address on a NAT network that only the mac reaches (`apple/container` docs `technical-overview.md`, `volumes.md`, `networking.md`, read 2026-11-07). Its `--ssh` option passes the mac's ssh-agent socket the same way, as a `--volume` of the socket path (`host-integration.md:10`); whether any other unix socket crosses the same way is on the list below [to probe]. The mac runs macOS 27.3 (`sw_vers`, 2026-11-07). omp 18.13.2 ships `omp-linux-arm64` (the release's assets page, read 2026-11-07).
- srt on Linux is bubblewrap, socat, seccomp, and user namespaces (srt 0.0.81 `README.md:686` to `:693`, `:713`), with caveats for a root caller (`README.md:709` to `:711`). Its `allowUnixSockets` is ignored on Linux: seccomp blocks every `socket(AF_UNIX)` unless `allowAllUnixSockets` is set (`README.md:517` to `:523`), so the strict socket list of U7 cannot be kept under srt on Linux.

## Decision

- **One box per session.** The wrapper starts one container per session and removes it at exit (`container run --rm`). The arena `~/.ug/home` is mounted read-write as the agent's home. The session's run folder (the config copy, the rendered allowlist) and the broker socket `~/.ug/run/broker.sock` are mounted read-only. Nothing else from the mac is in the box: no owner zone, no owner's zone, no host zone. What is not mounted does not exist in the box, so U1 and U2 hold by structure, and a session leaves nothing behind except what it wrote in the arena.
- **Runtime: Apple `container`** (pick 1, default). One VM per session is the throwaway. The broker socket would cross as a bind mount, the way `--ssh` passes the ssh-agent socket (`host-integration.md:10`), so the broker keeps its socket and its folder model (S9, U7) [to probe: the first line of "To verify"]. Rejected: colima and docker, which the mac has installed. One shared VM holds every session, so the sessions share a machine as they share the arena today, and the broker socket would not cross a shared-VM file share, so the broker would need a TCP listener, which is new code on the one credential path [inference: Lima documents socket forwarding over ssh, not socket bind mounts; not tried].
- **The image.** `host/box/Dockerfile` in the repo: a Debian base pinned by digest, `git`, `ca-certificates`, `tinyproxy`, `iptables`, a pinned Node for the broker client, and `omp-linux-arm64` at the omp pin with its SHA-256 in `VERSIONS`. Setup builds the image with `container build`, records its digest in `~/.ug/sys/box/digest`, and the wrapper runs that digest and nothing else. The image is rebuilt only by setup. The pinned omp in the owner zone is no longer mounted: the box carries its own.
- **Egress: a proxy in the box, and srt goes** (pick 2, default). The entrypoint runs as root before the agent: it writes the tinyproxy allowlist from the session's rendered `host/network-allowlist` (the wrapper fills `@GATEWAY@` as today), starts tinyproxy under its own uid, sets one netfilter rule set so the agent uid can reach only `127.0.0.1:<proxy port>` and nothing else (TCP, UDP, and DNS alike; the proxy resolves names itself), and then drops to the plain non-root agent uid and runs `host/arena/init` unchanged with `HTTPS_PROXY` set, which `init` already turns into `PI_PROXY` (`host/arena/init:20` to `:24`). U3's control moves from srt's proxy to tinyproxy plus the owner-match rule. srt leaves the repo: the pin, `install_srt`, the settings render in the wrapper, `allowPty`, the srt lines of the probes, and the srt package folder. Rejected: srt inside the box in Linux mode. It would keep the allowlist and the proxy, but add bubblewrap, socat, seccomp, and a user-namespace requirement inside a VM that holds nothing to hide, and it drops the socket list (context). Rejected: both. The most parts to keep correct for one crossing.
- **Localhost is the box's own.** The agent's dev servers, omp's `/stats`, and its helper daemons bind inside the box, which is what omp's features need (`0004-no-local-binding.md`, amendment). The mac's ports are not reachable: the box has no route to the mac's loopback, and the netfilter rule allows the agent uid only the proxy. Incoming: a listener in the box has an address on the container network, which the mac can reach and the LAN and the tailnet cannot (`networking.md:6` to `:9`; NAT [inference from the docs, to probe]). So N4 closes by structure, and the macOS firewall is no longer a control.
- **Host services stay where they are**, with one move. The GitHub broker: unchanged, its socket is mounted. The auth gateway: on the tailscale address, on the allowlist, reached through the proxy as today. The usage broker (`127.0.0.1:18765`) cannot be reached from the box: it moves to an address the box can reach, either the container network's host address or the tailscale address beside the gateway, decided by the probe below. Rejected: `container system dns create --localhost`. It maps a name to the mac's loopback through a packet-filter rule, which brings the mac's localhost back into reach (U7), and the rule is lost on restart (`host-integration.md:54` to `:57`).
- **Preflight.** The wrapper refuses when the digest record is missing or the runtime's service is not running, in place of the srt checks. The macOS build check stays: the runtime is Apple's and setup proves it on this build.
- **Mac-only tools are gone in a session** (pick 3, default: accept). The box is Linux: omp's browser tool, which drives a real Chromium, `open`, and anything mac-only stop working; `read` still fetches pages through the proxy. Rejected for now: a headless Chromium in the image. A bigger image and one more pin; revisit when a workflow needs it.
- **Unchanged.** The config copy, `host/arena/init`, the arena clone and worktrees, the clean environment, the backup, the merge gate, the reviewer skills, the one allowlist, the onboarding checks.

## What this closes, and what it does not

| Item | After the box |
|---|---|
| N4 incoming connections | Closed by structure: the LAN and the tailnet cannot reach the container network [to probe]. |
| U7 localhost | Closed: the box has its own localhost; the mac's ports are out of reach. The socket list keeps its shape: only mounted sockets exist. |
| U1, U2 | Still closed; the wall is a VM instead of a Seatbelt filter on the owner's user. |
| U3 | Still closed, by tinyproxy and the owner-match rule instead of srt. Until the proxy exists, a container has no allowlist at all, so no step of the plan starts a session in a box without it. |
| U36 | Unchanged: only the wrapper is `omp` on `PATH`, and a raw omp has no login. |
| N1, N3, S1 to S11, U14 | Unchanged. All in the broker, the host scripts, the docs, or accepted. |

## Cost

- Linux in the session. No mac-only tool. omp's `apple/on-device` provider does not exist there, which is a gain for the raw-omp check and nothing else.
- One more pin: Apple's `container` (a signed package from its GitHub releases, and a launchd service `container system start`), plus the image digest and the Debian base digest. The image install step is `apt`, so the digest that setup records is the pin, not a reproducible build.
- Memory and start time per session: a VM boot. Not measured.
- The usage broker moves off `127.0.0.1`.
- A new probe suite for the box (below) in place of the srt lines of `scripts/probe-arena.sh` and `scripts/probe-u1-u2.sh`, which prove srt and go with it.
- Apple's `container` is young; a macOS update can break it, which the build check catches at the next start.
- File ownership across the mount: the agent runs as a non-root uid in the box, and what it writes must appear on the mac as the owner's files [to probe].

## To verify on the host, before the build

Owner runs, one per line, after installing Apple's `container` from its release page and `container system start`. Each is a fact the design rests on; a failed line changes the design, not the probe.

- A bind-mounted unix socket that is not the ssh-agent socket works: mount `~/.ug/run/broker.sock` into an `alpine` box and connect to it with `nc -U`.
- A non-root uid in the box writes into a mounted folder, and the file appears on the mac owned by the owner.
- The guest kernel has netfilter with the owner match: `iptables -A OUTPUT -m owner --uid-owner 1000 -j REJECT` runs without error in the box, and a `curl` as uid 1000 then fails while one as root succeeds.
- With the rule in place, DNS from the agent uid fails too (`nslookup github.com` as uid 1000).
- The box reaches the auth gateway on the tailscale address, and GitHub, through tinyproxy with the allowlist, and an unlisted domain is refused with tinyproxy's own error.
- A listener on `0.0.0.0` in the box is reachable from the mac at the container's address, and not reachable from a second device on the LAN or on the tailnet (the probe that N4 needed).
- Which address of the mac the box reaches, for the usage broker: the container network's host address, or only the tailscale address.
- `container run --rm` leaves no container, no volume, and no file outside the arena after the session ends.

## Build plan

Each step is one PR with its check. A step that fails its check stops the plan.

1. **The image.** `host/box/Dockerfile`, `host/box/entrypoint` (allowlist render, tinyproxy, the netfilter rule, the drop to the agent uid, `exec init`), the omp Linux pin in `VERSIONS`, and `build_box` in setup behind `UG_BOX=1`, so the srt path stays the default. Check: setup builds the image and records a digest; `container run` of it as the agent uid can `curl` an allowlisted domain through the proxy and nothing else.
2. **The wrapper's box path.** With `UG_BOX=1` the wrapper mounts the arena, the run folder, and the broker socket, and runs the digest. `scripts/probe-box.sh`: the list under "To verify" as PASS, FAIL, INC lines in the style of `probe-arena.sh`, plus the two reads from `probe-u1-u2.sh` that still mean something in a box (the canary and `~/.ssh`), expected absent. Check: a session starts, `broker sync` makes a clone, omp calls a model through the gateway, and the probe passes.
3. **The usage broker's address.** Per the probe's answer. Check: `/v1/usage` works from the box; `probe-box.sh` gains the line.
4. **Cut over.** The box becomes the only path; `UG_BOX` goes; srt leaves the repo (pin, install, render, `allowPty`, its probe lines, `host/srt`); `SPEC.md` B2, B3, B5 and Checks, `THREAT-MODEL.md` U1, U2, U3, U7, U36, `GLOSSARY.md` (Sandbox, Owner zone, Sockets folder, Wrapper, Setup, Preflight, Network allowlist), the brief's principle 1, zones, "No unboxed session", and "What stays" are rewritten to the box. Check: setup from clean, `probe-box.sh` passes, and the reference check in CI passes.

N1 (owner-only merging for underground) is built apart from this plan and before it, so that no step of this plan can merge itself.
