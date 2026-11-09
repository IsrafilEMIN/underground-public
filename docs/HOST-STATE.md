# Host state

This page lists each file outside the repo that underground reads or writes on the mac. For each file, it says who writes it, who reads it, and when a change takes effect. It describes today's code (2026-11-08). Under the redesign phase (`../AGENTS.md`), it is a description, not a design.

Most changes take effect only when you run `host/bin/ug-setup`. Setup copies your files into root-owned snapshots, and the services and sessions read only those snapshots.

## When data moves

```text
 (1) YOU RUN host/bin/ug-setup
     config repo (last commit) ─┐
     skill repos (last commit) ─┼──► /Library/Underground/config/  (models.yml gets the gateway and its bearer)
     data folder: addresses ────┼──► /Library/Underground/addresses + rendered launchd plists
     checkout: host/** ─────────┼──► ~/.local/share/underground/services/  (code that the launchd jobs run)
     VERSIONS pin ──────────────┘──► /Library/Underground/omp/<pin>/omp

 (2) EACH SESSION STARTS (omp ─► ssh 127.0.0.1:2222 ─► agent-start, as ugagent)
     /Library/Underground/config/ ──copy──► /Users/ugagent/.omp/agent/
     gh-broker sync ─────────────────────► /Users/ugagent/work/<owner>/<repo>

 (3) ALL THE TIME (launchd jobs)
     gh-broker     reads  github-app.pem/.json, protected-paths/   writes  gh-broker/{repos,pushes,reviews}
     agent refresh every 30 s syncs each clone that a session used in the last 7 days
     auth broker   reads/writes  /Users/ugauth/.omp  (logins, tokens)
     auth gateway  reads  /Users/ugauth/.omp, listens on the gateway address
     usage broker  reads  /Library/Underground/addresses, /Users/ugauth/.omp/auth-gateway.token
     backup 20:00  reads  backup/config, backup/password, all of /Users/ugagent  writes  backup/last
```

## Files that you write by hand

No code makes these files. Setup or the service reads them as they are.

| path | what it is for | if it is missing or wrong |
|---|---|---|
| `~/.local/share/underground/config-repo` | One line: the path to your agent config repo (`host/bin/ug-agent-setup:207`). A leading `~` means your home (`:209`). | If it is missing, setup stops (`:208`). If it names a different repo that exists, setup stages that repo and gives no error. |
| `skill-repos` in the config repo | One skill repo path on each line (`host/bin/ug-agent-setup:233-260`). | If a path is not a folder or is outside your home, setup stops (`:238-240`). |
| `~/.local/share/underground/backup/config` | The lines `repo=sftp:<user>@<host>:<path>`, `wake=` and `sleep=` (`host/lib/backup-target.bash:3-21`). | Setup gives only a warning (`host/bin/ug-setup:149-150`). The nightly backup then fails, and only `backup/backup.log` records it. |
| `~/.local/share/underground/protected-paths/<owner>/<repo>` | Globs, one on each line. A PR that changes a matching path gets a hold, so you merge it on GitHub (`host/gh-broker/protocol.ts:369-372`). | If it is missing, the gh-broker reads it as empty and gives no warning (`host/gh-broker/server.ts:568-571`). Then only `.github/**` and `CODEOWNERS` are protected (`host/gh-broker/protocol.ts:284`). |

## Data folder: `~/.local/share/underground` (yours, mode 700)

| path | what it is for | who writes it | who reads it | when a change takes effect |
|---|---|---|---|---|
| `addresses` | `gateway=<tailscale-ip>:4000` is where the auth gateway listens. `engine=<ip>:<port>` is the inference engine. | setup, once only (`host/bin/ug-setup:196-223`) | setup (`host/bin/ug-agent-setup:211,290-292`) | Only at the next setup. Setup never rewrites the file, so after a tailscale IP change you must edit it by hand. |
| `backup/password` | The restic repo password | setup, once only (`host/bin/ug-setup:144-145`) | `host/bin/ug-backup:33-35` | If you lose it, you cannot open the backup. |
| `backup/last` | The time of the last good backup | `host/bin/ug-backup:61` | `host/bin/ug-agent:24-28` warns after 36 hours | at once |
| `github-app.pem`, `github-app.json` | The gh-broker app key and client ID | `scripts/gh-broker-app-wizard.sh` | `host/gh-broker/github-app.ts:23-27` | at the next token mint |
| `gh-broker/repos/`, `pushes/`, `reviews/`, `tmp/` | The gh-broker's mirrors and its push and review records | the gh-broker (`host/gh-broker/server.ts:83-91`) | the gh-broker | at once. Nothing deletes old review records or runs `git gc` on the mirrors. |
| `services/` | Setup's copy of the gh-broker code, `ug-backup`, `ug-auth`, `ug.bash`, `backup-target.bash`, and `VERSIONS` | setup deletes and remakes it (`host/bin/ug-setup:183-194`) | the launchd jobs (`host/launchd/com.underground.gh-broker.plist:10`, `com.underground.backup.plist:10`) | Only at the next setup. An edit in your checkout does not change the running services. |
| `restic/<pin>/restic` | The pinned restic | `host/bin/ug-setup:118-139` | `host/bin/ug-backup:13,32` | at the next setup |
| `agent-ssh/` | Your key for the agent login, and `known_hosts` for `127.0.0.1:2222` | `host/bin/ug-agent-setup:178-194` | `host/bin/ug-agent:14-15,50` | at once |
| `agent/bin/ug-agent` | The launcher. `~/.local/bin/omp` links to it. | `host/bin/ug-agent-setup:347-355` | your shell | at the next setup |
| `state/`, `gh-broker/gh-broker.log`, `backup/backup.log` | Setup fingerprints and the service logs | setup, launchd | you | none |

## Root zone: `/Library/Underground` (root-owned)

| path | what it is for | who writes it | who reads it |
|---|---|---|---|
| `config/` | The staged agent config. `models.yml` holds the gateway address and its bearer. It is `root:ugagent`, so you cannot read it. | `stage_config` (`host/bin/ug-agent-setup:205-274`) | `host/agent/agent-start:36-47`, at each start |
| `config-names` | The names that the agent config owns in `~/.omp/agent` | `host/bin/ug-agent-setup:155` | `host/agent/agent-start:43`, `host/agent/agent-home-tar:6` |
| `addresses` | A root-owned copy of your `addresses`. The usage broker runs as `ugauth` and cannot read your home. | `host/bin/ug-agent-setup:297` | `host/gh-broker/usage-broker.ts:25` |
| `omp/<pin>/omp`, `omp.sha256`, `bin/omp` | The one pinned omp, `root:ugomp` mode 550 | `host/bin/ug-agent-setup:115-138` | `host/agent/agent-start:16-20` checks the hash at each start |
| `bin/gh-broker`, `gh-broker/*.ts` | The gh-broker client for the agent | `host/bin/ug-agent-setup:139-147` | `host/agent/agent-start:80`, `host/agent/agent-refresh:19` |
| `usage-broker/*.ts` | The usage broker code | `host/bin/ug-agent-setup:293-296` | its LaunchDaemon |
| `pin.sb`, `agent-session`, `agent-start`, `agent-refresh`, `sshd_config`, `ssh_host_ed25519_key`, `authorized_keys/ugagent` | The agent login, its sandbox, and the clone refresh | `host/bin/ug-agent-setup:149-188` | the agent sshd, `host/agent/agent-session:15`, and the refresh LaunchDaemon |
| `run/gh-broker.sock` | The gh-broker socket | the gh-broker (`host/gh-broker/server.ts:82,759-782`) | the agent's gh-broker client |

## Login user: `/Users/ugauth` (mode 700, not readable by you)

| path | what it is for | who writes it | when a change takes effect |
|---|---|---|---|
| `.omp/` (omp's default profile) | The model logins and API keys | omp, through `ug-auth auth-broker login`, `logout`, and `ug-auth key` (`host/bin/ug-auth:30-38`) | at once, in the auth broker |
| `.omp/auth-gateway.token` | The bearer for the auth gateway. Setup puts it into `models.yml`. | setup, if it is empty (`host/bin/ug-agent-setup:278-283`), or `ug-auth auth-gateway token --regenerate` | Sessions get the new bearer only after the next setup (`host/bin/ug-agent-setup:213,263`). |
| `.omp/auth-broker.token` | The bearer that the auth broker asks its clients for | omp, not this repo | Setup uses it only to look for leaks in the config (`:221-224`) and as a restart input (`:310,315`). |
| `logs/` | The logs of the auth broker, the auth gateway, and the usage broker | launchd | none |

## Agent user: `/Users/ugagent`

| path | what it is for | who writes it |
|---|---|---|
| `.omp/agent/` | The agent's omp config. Each start replaces the `config-names` entries with the staged copy (`host/agent/agent-start:36-47`). | `agent-start`, then omp |
| `work/<owner>/<repo>` | The agent's clone of each repo (`host/agent/agent-start:62-69`). Each start touches `.git/ug-launched` (`:70`). The refresh syncs only clones whose marker is less than 7 days old (`host/agent/agent-refresh:30-35`). | `agent-start`, the refresh, and the agent |
| `logs/agent-refresh.log` | The refresh log. The refresh empties it when it is over 1 MB (`host/agent/agent-refresh:10-15`). | the refresh |
| everything else | Sessions, caches, worktrees. The nightly backup saves it, without the config names (`host/agent/agent-home-tar:9-13`). | the agent |

## System files

| path | what it is for | who writes it |
|---|---|---|
| `/Library/LaunchDaemons/com.underground.{auth-broker,auth-gateway,usage-broker,agent-sshd,agent-refresh}.plist` | The login services, the agent sshd, and the clone refresh | `host/bin/ug-agent-setup:299-345` |
| `~/Library/LaunchAgents/com.underground.{gh-broker,backup}.plist` | Your gh-broker and the nightly backup | `host/bin/ug-setup:230-254` |
| `/etc/ssh/sshd_config.d/010-underground-deny-ugagent.conf` | It keeps `ugagent` out of the system sshd. | `host/bin/ug-agent-setup:168-175` |
| `/etc/sudoers.d/underground-backup` | It lets you run `agent-home-tar` with no password. | `host/bin/ug-agent-setup:357-363` |

## Values that repeat

Each value below is typed out in each file that uses it. Nothing defines it once for all of them. If you change one, change every file in its row.

| value | where |
|---|---|
| `/Library/Underground` | `host/bin/ug-setup:24`, `host/bin/ug-agent-setup:35`, `host/bin/ug-auth:24`, `host/bin/ug-backup:16`, `host/agent/agent-start:5,8`, `host/agent/agent-refresh:5,8`, `host/agent/agent-session:15`, `host/agent/agent-home-tar:6`, `host/agent/sshd_config:2-3,9-10`, `host/agent/com.underground.usage-broker.plist:12`, `host/agent/pin.sb:8`, `host/gh-broker/server.ts:82`, `host/gh-broker/usage-broker.ts:25`, `scripts/gh-broker-app-wizard.sh:205` |
| `.local/share/underground` | `host/bin/ug-setup:10`, `host/bin/ug-agent-setup:36`, `host/bin/ug-agent:13`, `host/bin/ug-backup:13-14`, `host/gh-broker/server.ts:80`, `host/gh-broker/github-app.ts:25-26`, `scripts/gh-broker-app-wizard.sh:121` |
| port `8765` (auth broker) | `host/agent/com.underground.auth-broker.plist:14`, `host/agent/com.underground.auth-gateway.plist:33`, `host/bin/ug-auth:27,31`, `host/bin/ug-agent-setup:308` |
| port `18765` (usage broker) | `host/agent/agent-start:6`, `host/gh-broker/usage-broker.ts:9`, `host/bin/ug-agent-setup:318` |
| port `2222` (agent sshd) | `host/agent/sshd_config:1`, `host/bin/ug-agent:47-50`, `host/bin/ug-agent-setup:191,337-339` |
| port `4000` (auth gateway) | `host/bin/ug-setup:198,219`, then only in your `addresses` file |
| `/opt/homebrew/bin/node` | `host/bin/ug-setup:25`, `host/bin/ug-agent-setup:319`, `host/launchd/com.underground.gh-broker.plist:9`, `host/agent/com.underground.usage-broker.plist:11` |
| `run/gh-broker.sock` | `host/gh-broker/server.ts:82`, `host/bin/ug-setup:240`, `host/bin/ug-agent-setup:141`, `scripts/gh-broker-app-wizard.sh:205` |
