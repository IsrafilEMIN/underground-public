# Loopback: the auth broker's port closed to the agent, the rest accepted by name

Date: 2026-11-10. Status: built, not run on the owner's mac. Owner decisions of 2026-11-10, in the session that built it: build the firewall line against a fake auth broker, and it must not cripple the agent; accept by name that the agent reaches every listener of the owner on loopback.

## Context

`0021-github-holds-the-wall-on-main.md` sets the rule: a wall sits where the agent has no presence. Loopback fails it. macOS gives each user their own files, but one loopback for all users, and a listener there has no owner check. The agent user has no network wall (`0016-agent-user.md`, "No network wall for now"). The only control was a rule and a hand-run `lsof` (`../SPEC.md`, Checks, "Localhost inventory").

Two harms that cannot be undone:

1. **A fake auth broker.** Nothing checks who listens on `127.0.0.1:8765` (`../THREAT-MODEL.md`, the agent user table, "U15 (the logins), changed 2026-11-09", Open). If the agent listens there while the real broker is down, the auth gateway sends its request to the agent, with the broker bearer [inference, not run]. That bearer reads the snapshot with every access token and API key (`0005-model-auth-gateway.md`, Rejected). The clone refresh runs agent-written git config every 30 s from boot (`../THREAT-MODEL.md`, "new: agent code runs between sessions"), so the agent can race the broker [inference].
2. **The agent calls a listener of the owner.** A debug port, a notebook kernel, or a dev server that obeys any caller gives code as the owner (U7 into U4).

## Evidence

All runs on the owner's mac, 2026-11-10. The owner loaded each rule file with `sudo pfctl -a com.apple/underground-test -f /tmp/ug-pf-test.conf`; the agent probed from a pinned session.

- Before any rule, from the session: `curl http://127.0.0.1:8765/v1/healthz` and `http://127.0.0.1:18765/v1/healthz` printed `200`, and port `2222` answered.
- omp listens on random loopback ports and connects to them: `lsof -nP -iTCP -a -u ugagent` showed `omp` with `127.0.0.1:65363 (LISTEN)`, `127.0.0.1:57508 (LISTEN)`, and `127.0.0.1:49152 (LISTEN)`. So no fixed port list can say which ports the agent needs.
- A rule that names the listener's user works. With `block return in quick on lo0 proto tcp from any to any port 18766 user ugagent` loaded and a listener of `ugagent` on `127.0.0.1:18766` (`lsof` showed `Python ugagent 127.0.0.1:18766 (LISTEN)`), the owner's `curl -m 3 http://127.0.0.1:18766/` printed `Failed to connect to 127.0.0.1 port 18766 after 0 ms: Couldn't connect to server`, and `pfctl -vsr` showed `Packets: 2` on that line. After the owner flushed the anchor, the agent's own request to a new listener on that port printed `200`.
- A rule that joins the caller's user to the listener's user does not work. The file marked the agent's outgoing SYN (`pass out quick on lo0 proto tcp from any to any user ugagent flags S/SA no state tag UGAGENT`) and blocked a marked packet that reaches another user's listener (`block return in quick on lo0 proto tcp from any to any user != ugagent tagged UGAGENT`). `pfctl -vsr` showed `Packets: 84` on the mark line and `Packets: 0` on every line that reads the mark, and the agent still got `200` from the owner's listener on `127.0.0.1:18799` and from port `8765`. So the mark does not survive the trip through loopback [inference from the counters]. A pf rule sees the caller's user on the way out and the listener's user on the way in, never both.
- The line for port `8765` itself was loaded in that test with `on lo0`, and nothing tried it: `Packets: 0`.
- The session and its model calls went on while the rules were loaded. The agent's own listeners answered on `127.0.0.1`, the tailscale address, and the LAN address.
- pf was already on: `pfctl -s References` listed `pfd` (2 days) and `socketfilterfw` (4 days).
- `printf 'block return in quick proto tcp from any to any port 8765 user ugagent\n' | /sbin/pfctl -n -v -f -`, as `ugagent`, printed `block return in quick proto tcp from any to any port = 8765 user = 502` and exit 0.
- A sandbox profile line refuses a bind on one port and leaves the others free. Owner run, 2026-11-10, with `sandbox-exec -p '(version 1)(allow default)(deny network-bind (local ip "*:18766"))'`: `python3 -m http.server 18766 --bind 127.0.0.1` and the same with `--bind ::1` each ended in `PermissionError: [Errno 1] Operation not permitted` at `self.socket.bind`, and port `18767` printed `Serving HTTP on 127.0.0.1 port 18767`.

## Decision

1. **The pin refuses the agent a listener on port 8765.** `host/agent/pin.sb` holds `(deny network-bind (local ip "*:@AUTH_BROKER_PORT@"))`, which setup renders with the port from `host/facts`. Every agent process starts under the pin, the clone refresh at boot too, so this holds from the first process, with no race against a loader. It covers IPv4 and IPv6 (Evidence).
2. **A firewall line refuses the agent user as the listener on port 8765, for the case that the agent gets out of the pin.** The template `host/agent/agent-pf.conf` holds one line, and setup renders it to `block return in quick proto tcp from any to any port 8765 user ugagent` with the values of `host/facts`. It names no interface and no address family, so it holds on every address of the mac. The root LaunchDaemon `com.underground.agent-pf` runs `/Library/Underground/pf-load` at load and every 30 s (`host/agent/com.underground.agent-pf.plist`). The loader loads the line into the anchor `com.apple/underground`, which the main ruleset of `/etc/pf.conf` already evaluates through `anchor "com.apple/*"` (read 2026-11-10), so no system file changes. It then turns pf on with a reference of its own if pf is off (`host/agent/agent-pf-load`). Root owns the rule file, the loader, and the anchor, and the agent user cannot open pf: as `ugagent`, `/sbin/pfctl -s info` printed `pfctl: /dev/pf: Permission denied`, and `ls -l /dev/pf` printed `crw------- 1 root wheel` (agent run, 2026-11-10). This line does not rest on the pin.
3. **Setup checks the firewall line.** It stops unless pf is on and the anchor holds the line for the agent's user id and port 8765 (`ug_pf_refuses_listener`, `host/lib/ug.bash`; its caller in `host/bin/ug-agent-setup`; `tests/host/launchd.test.ts`, "the firewall check passes only when pf is on"). Before the install, `pfctl -n` must accept the rendered file.
4. **The agent's reach to the owner's listeners on loopback is accepted by name** (harm 2). The guard stays the owner's rule: no program of the owner listens without a secret. On 2026-11-03 the inventory found none that breaks it (`../SPEC.md`, Checks). If the owner starts to run debug ports or notebooks on this mac day to day, the answer is a machine or a VM of its own for the agent, not a longer firewall list.

Neither line cripples the agent: the agent has no use for port 8765, and omp's own listeners sit on ports the system picks, at 49152 and above in the run above.

## Rejected

- A rule "the agent calls only its own listeners": pf cannot express it (Evidence).
- A port range for the agent as caller (only 18765, the gateway port, and 49152 and above). It leaves open every listener of the owner on a random high port, which is where a notebook kernel or a browser debug port can sit, and it breaks `/stats` on `127.0.0.1:3847` (`0004-no-local-binding.md`, amendment 2026-10-31) and the agent's dev servers on low ports. It would look like a wall without being one.
- A list of blocked ports for the agent as caller: a list of denied places leaves open what nobody listed (`0016-agent-user.md`, Rejected).
- A VM for the agent: the root-cause fix, since only a VM or a second machine gives the agent a loopback of its own. The owner removed the box on 2026-11-08 for its cost (`0016-agent-user.md`, Context).

## Not covered

- The probe on the real port has not run. After the owner's setup: a pinned session must fail to listen on `[::1]:8765`, and a listener on that address started outside the pin must refuse a connection.
- The firewall line alone has gaps: at boot it can load after the clone refresh starts, and if another program flushes the anchor or turns pf off, the line is gone for up to 30 s. The pin line closes both while the agent stays in the pin.
- A fake listener on the usage broker's port or on the gateway's port gets nothing that the agent lacks: sessions send it the gateway bearer, which the agent can read (`0018-login-user.md`, decision 5) [inference].
- Whether a macOS update keeps `anchor "com.apple/*"` in `/etc/pf.conf` is not known. Without it the anchor is loaded but not evaluated, and setup's check does not see that.
