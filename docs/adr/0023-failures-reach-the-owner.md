# Failures reach the owner

Date: 2026-11-10. Status: built, not run on the owner's mac. Owner decisions of 2026-11-10, in the session that built it: silence must not mean "ok"; each job records its result where only its own user or root can write; one checker reads the records and tells the owner; build it. An earlier version of this line also listed the check outside the mac (decision 3) as an owner decision. In a later session the same day, the owner corrected that, and in that same session chose Healthchecks.io as the check, with its alerts sent to his Discord (chat, 2026-11-10).

## Context

The owner asked how to know that the gh-broker's 30 s refresh works, and then whether he learns of any failure of the services the setup needs. He does not. Each job writes only its failures, to a log that nobody reads: the gh-broker (`refreshRepos`, `host/gh-broker/server.ts`), the clone refresh (`sync_clone`, `host/agent/agent-refresh`), the backup (`log`, `host/bin/ug-backup`), and the login services (`StandardErrorPath`, `host/agent/com.underground.auth-broker.plist`). A job that does not run writes nothing at all. The one check was a warning at launch when `backup/last` was older than 36 hours, in `host/bin/ug-agent` before this change.

The jobs run as four users: the owner (gh-broker, backup), `ugauth` (auth broker, auth gateway, usage broker), `ugagent` (clone refresh), and root (agent sshd). If they wrote one shared folder, the agent user could forge an "ok" for another job.

## Decision

1. **Each job leaves a record that only its own user or root can write.**

   |job|runs as|record|
   |---|---|---|
   |gh-broker refresh|owner|`gh-broker/status` in the data folder, written once per 30 s tick, also when no repo is due: `at=<epoch s>` and `failed=<repos>`. A repo fails when its refresh or a branch end failed (`writeRefreshStatus`, `host/gh-broker/server.ts`). One record per tick, not per repo, so an idle gh-broker stays fresh.|
   |backup|owner|`backup/last` (`host/bin/ug-backup`), and launchd's last exit code of `com.underground.backup`.|
   |clone refresh|`ugagent`|launchd's last exit code of `com.underground.agent-refresh`. The refresh now exits 1 when a sync failed or hung (`failed`, `host/agent/agent-refresh`). launchd keeps the code, so the agent cannot write it. The pin lets the refresh write only in the agent home, which the owner cannot read.|
   |auth broker, auth gateway, usage broker|`ugauth`|no record: they are omp's code. The watch asks their health routes (`/v1/healthz`, `/healthz`).|
   |agent sshd|root|no record: it is the system's sshd. The watch checks that its port answers.|

2. **The watch reads the records.** `ug-watch` (`host/bin/ug-watch`) runs as the owner from launchd every 5 minutes and at load (`host/launchd/com.underground.watch.plist`). A problem is a gh-broker record older than 120 s or with a failed repo, a backup older than 36 hours, a last exit code other than 0, a job that launchd does not know, or a service that does not answer. When it finds a problem, it looks again after 60 s and reports only what is still there. Proposal: this keeps a mac that just woke from a false alarm, because launchd runs the missed timers at wake. It writes the result to `watch/status` in the data folder: `at=<epoch s>`, then one line for each problem.

3. **A check outside the mac.** Owner decision of 2026-11-10, in the session that corrected the status line: Healthchecks.io, with its alerts sent to the owner's Discord. Its free plan covers 20 checks ([Pricing](https://healthchecks.io/pricing/), read 2026-11-10), and its Discord integration exists on the hosted service (`https://healthchecks.io/integrations/add_discord/` redirects to its login, checked 2026-11-10). The owner writes the ping address of the check into `watch/ping`, one `https://` line. After each run, the watch sends a GET to it when nothing is wrong, and a POST to `<address>/fail` when something is ([Pinging API](https://healthchecks.io/docs/http_api/), read 2026-11-10). The POST holds only the names of the failed jobs, such as `backup` or `auth gateway`; the full lines, with paths, addresses, and repo names, stay in `watch/status` and `watch/watch.log`, because the owner keeps his names and addresses off third parties (commit "Drop the owner's engine address and names from the repo"). Healthchecks.io stays silent while pings come on time, and alerts when the check changes state: on a failure, and when no ping comes within the check's period and grace time, because the mac sleeps, is off, or the watch is dead ([Introduction](https://healthchecks.io/docs/), read 2026-11-10). The address is a secret: anyone with it can send "ok". It sits in the owner's data folder (mode 700), the agent user cannot read it, and the watch never writes it to its log. Without the file, the watch still runs, and `watch/status` says that nothing outside the mac watches it.

4. **The launch shows the status.** `ug-agent` prints each problem line of `watch/status` as a warning, and warns when the status is older than 15 minutes (`status`, `host/bin/ug-agent`). This replaces its own 36-hour backup check, which the watch now runs.

## The gate

A backup that stops silently is the one failure here that costs undo (`../THREAT-MODEL.md`, U37): the owner learns of it only when he needs a restore. The watch and the outside check change nothing that a job does; a bug in them gives a false alarm or a missed alarm, never a stopped service. The gh-broker catches a failed write of its record and goes on.

## Cost and limits

- The owner runs setup once, makes a check at the outside service, and writes `watch/ping`. Setup lists the missing file in its "left to do" lines (`prepare_services`, `host/bin/ug-setup`).
- The setup steps given to the owner set the check's period to 5 minutes, the watch's interval; the owner did not confirm the value he saved. The grace time is the owner's: a mac that sleeps for the night sends no ping, so a grace time shorter than the sleep gives an alert each night.
- The agent cannot listen on the auth broker's port (`0022-loopback-one-firewall-line.md`), but it can on the usage broker's and the gateway's. When one of those is down, a process of the agent could answer its health route, and the watch would see it as up. Accepted: such a listener gets nothing that the agent lacks (`0022-loopback-one-firewall-line.md`, "Not covered").
- The agent controls its clones, so it can make the clone refresh fail or pass. The harm is a slower launch, not a lost undo.
- A gh-broker whose loop runs but whose socket hangs looks healthy. A sync then fails at launch, so the owner sees it there.
- `watch/watch.log` gets one line each 5 minutes while a problem lasts, and nothing trims it.

## Evidence

- `tests/broker/server-failures.test.ts`: a tick with no repo due writes `failed=` empty; a tick whose repo copy cannot be made names the repo; a status file that cannot be written does not throw.
- `tests/host/ug-watch.test.ts`: all healthy pings the address; lasting problems go to `<address>/fail` with the same lines as the status, and the log does not hold the address; a problem gone on the second look is dropped; failed repos are named; without `watch/ping`, nothing is pinged.
- `tests/host/ug-agent.test.ts`: the launch prints each problem, and warns about a missing or old status; the clone refresh exits 1 after a failed or hung sync, and 0 when a launch holds a clone.
- Not run: the watch under launchd on the owner's mac; `launchctl print system/com.underground.agent-refresh` as the owner, which the watch needs for the clone refresh [inference: `ug-agent` reads `system/com.openssh.sshd` the same way]; a real ping to Healthchecks.io.
