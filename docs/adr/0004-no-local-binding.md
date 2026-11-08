# No direct localhost access from the sandbox

Date: 2026-10-30. Owner decision.

Holds under the redesign (2026-11-02), with `allowLocalBinding: true`. Amendment 2026-11-03 (owner decision): localhost stays on in the arena. omp's own features open a server inside the sandbox on `127.0.0.1` and talk to it there: the python tool bridge (omp `eval/py/tool-bridge.ts:153`), the browser tool (`tools/browser/relay/server.ts:112`, `tools/browser/attach.ts:25`), the debugger (`dap/client.ts:169`), and `/stats` (`stats-dashboard.ts:4`), all in omp 18.13.2, read 2026-11-03; so do the agent's dev servers. No broker or tailscale address can stand in for a server inside the sandbox, and srt has only an on or off switch (srt 0.0.81 `dist/sandbox/sandbox-config.js:619`). The usage broker stays on `127.0.0.1:18765`, because a move would close nothing while localhost is on. The cost and its guard: `../SPEC.md`, B5 and Checks; `../THREAT-MODEL.md`, U7.

With `allowLocalBinding: true`, srt lets the sandbox connect to every localhost port (srt 0.0.81, `src/sandbox/macos-sandbox-utils.ts:1280` to `:1284`), so every local service is reachable (U7).

Decision: `allowLocalBinding: false`. The sandbox reaches the network only through srt's proxy and its allowlist. The omp auth gateway listens on the tailscale address of this mac. The inference engine runs on `v100-server`, another box on the tailnet. The allowlist names each address with the port of its service (`@GATEWAY@` and `@ENGINE@`, in the allowlist templates that were in `host/roles/`, which is removed; see `0001-accepted-risks.md`, line 5), never the bare address, so no other port on either box is reachable (srt 0.0.81, `dist/sandbox/domain-pattern.js:18` to `:23`). The gateway binds with `omp auth-gateway serve --bind=<tailscale address>:<port>` (omp docs, `auth-broker-gateway.md:153`, read 2026-10-30) and always needs a token, so it never runs with `--no-auth`.

Rejected: localhost through srt's proxy, with one port per service on the allowlist (srt 0.0.81, `dist/sandbox/domain-pattern.js:18` to `:68`). srt sets `NO_PROXY=localhost` in the sandbox (`dist/sandbox/sandbox-utils.js:705` to `:720`), so the wrapper must change `NO_PROXY`, and nobody has tested it. Rejected: a Unix socket bridge. The gateway has no socket option, so the bridge is new code for the same result.

Cost: the agent cannot run a local server and connect to it directly. If tailscale is down, the agent has no inference. Every device on the tailnet can reach the gateway port; only a token lets it in. The inference engine takes no token, so every device on the tailnet can use it. (Superseded 2026-11-01: the engine takes a key, and roles reach it only through the gateway, `0005-model-auth-gateway.md`.)

## Amendment 2026-10-31: addresses from one owner file

`install.sh` hard-coded the gateway as `100.64.0.99:4000`, but `100.64.0.99` is `v100-server`, not this mac. The gateway could not bind, and launchd restarted it in a loop.

Decision: the owner-only file `~/.ug/host/addresses` holds `gateway=<ip>:<port>` and `engine=<ip>:<port>`. `host/bin/ug-setup` writes it only when it is missing (`write_addresses`, `host/bin/ug-setup:174` to `:192`), with the first line of `tailscale ip -4` and port `4000` for the gateway (`host/bin/ug-setup:190`), and never overwrites it. Setup reads it for the gateway plist and the engine address (`host/bin/ug-setup:219` to `:220`), and `host/bin/ug-agent-setup:153` reads the gateway. The allowlist templates, which filled `@GATEWAY@` and `@ENGINE@` at each session start through `render-settings`, were removed with the srt design (`0001-accepted-risks.md`, line 5).

## Amendment 2026-10-31: loopback allowed

Decision: `allowLocalBinding: true` (owner decision). With `false`, omp features that bind or reach a local port failed: the `/stats` dashboard (`127.0.0.1:3847`), the text prediction daemon, and local dev servers. srt 0.0.81 has no per-port loopback setting, so the choice is all or nothing.

Cost: a role can reach every service on this mac's localhost, including the owner's dev servers.

Why this is acceptable: the auth broker on `127.0.0.1:8765` needs a bearer token for every endpoint except `/v1/healthz` (omp docs, `auth-broker-gateway.md:74` to `:88`, read 2026-10-31). An unauthenticated `GET /v1/snapshot` returned `401` on 2026-10-31. Reads stay denied under `$HOME` except the read roots that omp needs, so a role cannot read the broker's token from `~/.omp`. If reads are ever widened to `~/.omp`, this decision must be reopened.

Accepted risk: every role and the owner's own omp share localhost. A role can bind a well-known omp port before anyone else, and another omp then talks to it. Example: omp reuses whatever answers on `127.0.0.1:3847` as the `/stats` dashboard, so a role that holds 3847 serves the dashboard page to other roles and to the owner's host omp, which opens it in the owner's browser. Collab and prediction listeners are the same kind of channel. Rule for the owner: if the host `/stats` page looks wrong, check the port's owner with `lsof -nP -iTCP:3847 -sTCP:LISTEN`. A wrapper check that refuses to start while another role holds a well-known omp port is not built yet.

## Amendment 2026-10-31: daemon brokers after a rules change

omp runs its daemons under one daemon broker per state folder. The broker keeps the sandbox rules of the session that started it, outlives that session, and later sessions of the same role and repo reuse it through `<state>/omp/run/daemons/<scope>/<name>/broker.pid`. After a rules change, its workers still run under the old rules, and text prediction stayed down after the socket grant was fixed (ticket 23).

Decision: `install.sh` stops every daemon broker of every role (`stop_role_brokers`), because an install is the one moment the rules change and the owner restarts sessions after it. The wrapper stops a daemon broker of its state folder whose worker failed (`stop_failed_brokers`, `host/bin/omp`), because such a broker serves no session. A broker with a running worker stays. Both match only a process whose command line ends in `__omp_worker_daemon_broker`. No host watchdog: nothing in the sandbox can send a signal, and a kill-and-respawn loop would hide a real failure.

## Amendment 2026-11-07: the agent box (proposed)

`0013-agent-box.md` is proposed, not built. Until it is built, this ADR describes the system. Once built, it supersedes this ADR: the box runs with `--network none`, so its loopback is its own and it has no route off the box (owner probe, 2026-11-07, in `0013-agent-box.md`, Evidence). `allowLocalBinding`, the localhost cost, and the omp ports shared between the agent and the owner's omp go away; the mac's localhost, the auth broker's port included, is out of reach. Inside the box, each session container has its own network namespace (`0014-session-containers.md`), so the port case of the amendment "loopback allowed" does not come back between sessions. Daemon brokers live and die with their session container, so `stop_failed_brokers` has nothing to stop. The addresses file stays for the host services.

2026-11-07: built as a trial. The box runs with `--network none`. The wrapper that set `allowLocalBinding` was removed in #90 (commit 54a418a1).

Changed by `0015-box-layout.md` (owner decision, 2026-11-07): there is no session container, so all sessions share the box's one loopback, and the port case of the amendment "loopback allowed" comes back between sessions, though not between the box and the mac (`0015-box-layout.md`, Cost). Daemon brokers then live and die with the box, not with a session.
