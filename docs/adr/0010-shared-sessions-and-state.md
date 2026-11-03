# One session folder and one state folder for every role

Date: 2026-11-01. Owner decision. Amends `0009-one-omp-root.md`: its sessions and state per role name go; the rest of it holds.

Superseded in full on 2026-11-02 by `0011-one-agent-arena.md`: every role shares the arena by design. The split of `run/daemons` under "Later" is dropped, because all roles share one trust level.

`0009-one-omp-root.md` kept sessions and state per role name. The owner decided to keep them in one place for MVP 0.5, with harder rules later.

## Decision

- Every role uses one session folder per repo: `~/.ug/omp/agent/sessions/ug-<repo id>` (`host/bin/omp`, `sessions=`).
- Every role uses one state folder per repo: `~/.ug/omp/underground/state/<path hash>` (`host/bin/omp`, `state=`), which is `XDG_STATE_HOME`.
- Still per role: the broker binding and its verbs, the rules of each binding role in `~/.agents/roles`, and each reviewer's store in `~/.ug/git/<role name>`. Every role uses one network allowlist (amended 2026-11-02, `0001-accepted-risks.md`).
- The rules of every role tell the agent to use only its own broker socket and its own sessions, and never an omp daemon broker or session file of another role.

## Cost

- omp runs one daemon broker per state folder. It runs each job under the sandbox of the session that started it, and any session that can read its token in the state folder can ask it to start a job (omp 18.13.2, `launch/broker.ts`, `launch/paths.ts`). In a shared state folder, a reviewer can run a job with the author's sandbox, which writes the repo, and the author can run a job with a reviewer's sandbox, which writes that reviewer's store and reaches its broker socket, so it can record a verdict as that reviewer. A session that uses the broker of another role is a rule break, not a sandbox refusal. [inference] from the omp code; not run.
- A session can read or write the session files of every other role.
- Undo: stop the daemon brokers (`install.sh`, `stop_role_brokers`) and delete the state folder.

## Later

Split state again, at least omp's `run/daemons`, before agents merge alone where a forged verdict matters.
