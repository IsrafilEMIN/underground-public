# The agent box: a VM with no network, and doors that the host owns

Date: 2026-11-07. Status: proposed. The owner agreed to the rough layout on 2026-11-07; the doors, the folders, and the start are not decided yet. Once built, it supersedes `0004-no-local-binding.md` and `0011-one-agent-arena.md` (except its one trust level), and amends `0001-accepted-risks.md`, `0005-model-auth-gateway.md`, `0008-preflight.md`, and `0012-pinned-omp-and-setup.md`. Each of them has an amendment of 2026-11-07 that says what changes.

## Context

The agent runs on the owner's mac as the owner's user. It shares the user, the network stack, localhost, and a home that persists. srt keeps it in with a list of rules on top of that shared host, and each gap in the list has needed its own patch:

- Incoming: with `allowLocalBinding: true`, srt allows `(allow network-inbound (local ip "*:*"))` (srt 0.0.81 `dist/sandbox/macos-sandbox-utils.js:951` to `:953`). The guard in `../THREAT-MODEL.md` U7 is the macOS firewall, and on this mac `socketfilterfw --getglobalstate` printed `Firewall is disabled. (State = 0)` (2026-11-07).
- Localhost: every local service is reachable from the sandbox (`0004-no-local-binding.md`, amendment 2026-11-03).
- Persistence: only the names in `config_names` are reset at a start (`host/bin/omp-arena:46` to `:49`, `host/arena/init:35` to `:48`); other loaders in the arena and in each clone outlast it.
- The macOS build check, the arena probe, and the socket folder rules exist only to keep srt's rules sound.

## Decision (proposed)

- **The box.** The agent runs in an Apple `container` VM with `--network none`: its own kernel, filesystem, and loopback, and no route off the box. Each start is a fresh VM from a pinned image, with the box's home on a host volume that persists (where it lives: Open).
- **Vanilla omp inside.** omp runs in its default layout in the box's home. Nothing in omp is moved, wrapped, or reset. Whatever the agent changes inside the box stays inside it, and a reset or a backup restore undoes it.
- **Doors.** The box reaches the host only through unix sockets that the host mounts in. Draft list: the GitHub broker, and an egress socket to an allowlist proxy on the host. Model calls go through the egress door, and the host adds the gateway bearer there, so no secret enters the box.
- **Safety lives in the doors.** A box can be taken over and stay taken over across starts, so each door must hold against a hostile caller. What the broker door allows (`broker merge`, N1 of the 2026-11-07 re-check) and what the model door can spend are part of this design, not separate from it.
- **srt.** It stops being the sandbox and stays as the egress proxy.
- **Egress by name only** (owner decision, 2026-11-07). The proxy decides each HTTPS connection by the site's name and passes it through unopened, so the box needs no CA. This is srt's own HTTP proxy, `createHttpProxyServer` (srt 0.0.81 `dist/sandbox/http-proxy.d.ts:315`), run by a small host launcher on the egress socket: its `filter(port, host)` is the host allowlist (`:27`), and without `mitmCA` a CONNECT is "an opaque byte tunnel", "hostname-allowlisted via `filter`, but not content-inspected" (`:38` to `:51`). It is not exported from srt's index (`dist/index.d.ts`), so the launcher imports it by path and the srt pin holds it in place. Model calls are plain HTTP to the gateway (every `baseUrl` in the arena's `models.yml` is `http://<tailscale address>:4000`, read 2026-11-07), so the proxy replaces the box's placeholder bearer there with `mutateHeadersPlaintext` (`:101`). A loopback test on 2026-11-07 (node, srt 0.0.81, in a session) showed both: a plain-HTTP request with `authorization: Bearer placeholder` reached an allowed echo server as `Bearer probe-secret`, and a request to an unlisted host got `403` "Connection blocked by network allowlist". Why not open every connection: the box holds no GitHub or npm token, since pushes go through the broker door, so a finer HTTPS check would stop only an anonymous upload to an allowed site, which U14 already accepts (`0001-accepted-risks.md`); it would cost a CA in git, npm, node, python, and curl.
- **Kept from underground:** the GitHub broker, the auth broker and gateway, the merge gate, setup with its pins, and the backup.
- **Gone once built:** srt as the sandbox, the wrapper's srt settings, `host/arena/init`, `config_names`, the macOS build check, and `scripts/probe-arena.sh`.

## Evidence

Owner runs on this mac, 2026-11-07, `container` 1.7.1 (`container --version`: `build: release, commit: a15b460`), kernel from the recommended Kata 4.3.1 release:

- An `--internal` network is not enough. On `container network create --internal ugbox`, the box had `default via 192.168.128.1 dev eth0`. A TCP connect to `1.1.1.1:80` timed out, but the mac's gateway address `192.168.128.1:8765`, its wifi address `192.168.18.22:8765`, and the auth gateway `100.110.237.15:4000` were all `open`.
- `--network none` has no route. `ip addr` showed only `lo` (`127.0.0.1/8`, `::1/128`), `ip route` printed nothing, and connects to `1.1.1.1:80` and `192.168.128.1:8765` failed with `OSError`.
- A socket door works with no network. With `-v /tmp/ug-probe.sock:/door.sock` and `--network none`, the box sent `ping`; the host listener printed `host got b'ping'`, and the box printed `b'door ok ping'`.
- A reply can be lost when the host closes at once. A host listener that sent and closed at once gave the box `b''`; with a one-second wait before the close, the reply arrived. [inference] The socket forwarding drops data on a fast close. The real broker must be tested through the door.
- The `container` docs document no `none` network on `container run`; the only restriction they show is `container network create --internal`, "Restrict to host-only network" (`docs/command-reference.md`, main branch, read 2026-11-07). `--network none` works in 1.7.1 but is not documented, so the start must check for it.

## Open

- The doors against a hostile caller: the broker verbs, model spend, the allowlist.
- The relay inside the box: omp, git, and npm reach a proxy by host and port (`HTTPS_PROXY`), not by a socket, so the image needs a TCP-to-socket relay on the box's loopback.
- The proxy launcher: that `createHttpProxyServer` serves connections handed in from a unix socket, filters each CONNECT by its host, and sets a header on a plain-HTTP request. Probe it before building on it.
- What persists, where it lives on the host, and what the backup covers.
- The image: how omp gets in, the Linux omp pin, and how a session starts.
- Where the host code runs from (N2, `0001-accepted-risks.md`, amendment 2026-11-03).

## Rejected

- An `--internal` network alone: the box reaches every service on the mac that listens on all interfaces (Evidence).
- An `--internal` network plus a pf rule that drops the box's subnet: it works without an undocumented mode, but it is a host rule to keep loaded, and reading pf rules needs root at each start. Keep it as the fallback if `--network none` goes away.
- colima and Docker Desktop: both reach the mac's localhost by default (`host.lima.internal`, `host.docker.internal`), and Docker's `-p` listens on every interface. [inference] From memory, not read in their docs.
- Patching srt to bind loopback only: srt's comment says Seatbelt's `localhost` matches the any-address (`macos-sandbox-utils.js:943` to `:947`), so it may close nothing.

## Cost

- A Linux image to build and pin, and a Linux omp.
- A VM per session: more memory and a slower start than srt [inference, not measured].
- `--network none` is undocumented in `container` 1.7.1, so an update can remove it; the start must refuse a box that has a route.
