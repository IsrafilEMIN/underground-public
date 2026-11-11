# 0027. Enforce least rights

Status: Accepted (owner, 2026-11-11). Extends `docs/adr/0025-agent-input-runs-with-least-rights.md`, "Decision", item 2. Built in this change, not yet run on the owner's mac.

## Context

- ADR 0025 states the rule: no process with more rights than the agent parses bytes that the agent made (`docs/adr/0025-agent-input-runs-with-least-rights.md`, "Decision", item 1). Its check reads the service table, and it covers only the launchd jobs that run as the owner or root.
- A map of every line between the parties ran on 2026-11-11. An agent run read the code at commit 3f56933. Nothing ran on the host. The map found three breaks that the table check does not see.
- Before this change, root ran `tar` over the agent home for the backup. A hard link in the agent home to a file that only root can read puts that file in the backup [inference, not tested] (`docs/THREAT-MODEL.md`, U40).
- Root hashes the restart inputs in the login user's home (`docs/THREAT-MODEL.md`, U42).
- The login user's services parse the agent's requests, with every login in reach (`docs/THREAT-MODEL.md`, U43).

## Decision

The rule now has three levels: structure, proof, and CI.

1. **Structure.** Owner and root code touch a path below a lower user's home only with that user's rights, through one helper. The lower users are the agent user, the login user, and the gh-broker user. The helpers are `ug_as`, `ug_read_as`, and `ug_write_as` (`host/lib/ug.bash`). `ug_as` runs a command as a login: directly when the login is the caller, and otherwise through `sudo -n -u`. One place is the exception: root builds each home, and the root-owned `.ssh` of a new agent user, before that user ever runs (`make_user`, `host/bin/ug-agent-setup`).
2. **Proof.** At each setup, two checks run. `check_walls` (`host/bin/ug-setup`) checks as the owner that the owner cannot run omp, read the bearer, or list the login user's and gh-broker user's homes. `ug_user_walls` (`host/lib/ug.bash`) runs as each service user and as the agent user. Each run must run `/usr/bin/true`, so a failed sudo shows up. Each run must fail to list every other home. For the two users that are not the agent, each run must fail to read the staged `models.yml`. The agent user reads that file by design (`docs/THREAT-MODEL.md`, U30). A sudo that fails counts as an open wall. Each check prints each open wall and returns 1 when one is open.
3. **CI.** `scripts/check-lower-homes.mjs`, run by `tests/host/lower-homes.test.ts`, fails when a line of owner or root shell code names a path below a lower home. Such a line passes only when it also contains `ug_as`, `ug_read_as`, `ug_write_as`, `sudo -u`, or `sudo -n -u`. The bare home, not followed by `/`, passes anywhere. So a message of setup names the user and the file, not the full path. The service table refuses a job that breaks the rule. `ug_service_allowed` (`host/lib/ug.bash`) checks each row. A job that is not the agent's and reads agent input must name a threat row, and a host test checks that the row exists and names the job (`tests/host/launchd.test.ts`). Each home placeholder in the row's inputs or log must be the home of the row's own user. An input that names a home holds no glob character. `ug_services_allowed` passes the new fields to it.
4. **Cleanup.** The change removes what the three levels make obsolete.
   - The backup helper, `host/agent/agent-home-tar`, runs as the agent user, not as root. The sudoers rule lets the owner run it as that user, `<owner> ALL=(<agent_user>) NOPASSWD: <root>/code/bin/agent-home-tar`. `host/bin/ug-backup` calls it with `sudo -n -u <agent_user>`.
   - A whole-home restore unpacks as the agent user (`docs/SPEC.md`, "Restore").
   - The restart hash reads a service's inputs with that service user's rights (`ug_fingerprint`, `host/lib/ug.bash`).
   - `read_as` and `write_as` in `host/bin/ug-agent-setup` are gone. `ug_read_as` and `ug_write_as` replace them (`host/lib/ug.bash`).

## Not covered

- The checker matches text. A home passed to a function under another name escapes it. So does a path that a command of the lower user printed, such as a temp folder.
- The proof covers what the service users and the agent user can read. It does not cover what root or the owner reads. The owner's sudo reaches everything (`docs/adr/0018-login-user.md`, "Not covered, accepted by name").
- Nothing here ran as root on the owner's mac. The first run is the owner's next setup.
- The owner's scratch restore still unpacks agent-made bytes as the owner (U40, open).
- The login user's services still parse agent requests with every login in reach (U43, open).
- The agent can make a file unreadable to itself, so the backup cannot read it. Every earlier snapshot still holds it (`docs/SPEC.md`, "Backup").
- The agent still reaches loopback ports and command lines (`docs/adr/0022-loopback-one-firewall-line.md`).

## Undo

A git revert of the change. The walls and the checker go with it.

## Open

The owner's terminal (U39), the agent sshd (U41), and the login user's services (U43) stay open. `docs/THREAT-MODEL.md` names their candidates.

## Evidence

Owner run, 2026-11-11. With the rule `block return out quick proto tcp from any to any port 2222 user ugagent` in a test anchor, `sudo -u ugagent curl -m 3 http://127.0.0.1:2222/` printed `curl: (28) Connection timed out after 3006 milliseconds`. Without the rule, the same command printed `curl: (1) Received HTTP/0.9 when not allowed`. So a pf line that names the caller's user stops the agent user's call to one port. This change adds no such line.
