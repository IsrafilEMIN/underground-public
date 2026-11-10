# Host state

This page lists each file outside the repo that underground reads or writes on the mac. For each file, it says who writes it, who reads it, and when a change takes effect. It describes today's code (2026-11-08). Under the redesign phase (`../AGENTS.md`), it is a description, not a design.

Most changes take effect only when you run `host/bin/ug-setup`. Setup copies your files into root-owned snapshots, and the services and sessions read only those snapshots.

Setup first asks GitHub, with your `gh` login, whether `main` of the checkout's repo needs your approval for every merge. If not, it stops before it pulls (`ug_check_main_rule`, `host/lib/ug.bash`; `adr/0021-github-holds-the-wall-on-main.md`). So setup needs `gh` with your login, `jq`, and a reply from GitHub.

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
| `~/.local/share/underground/config-repo` | One line: the path to your agent config repo (`config-repo`, `host/bin/ug-agent-setup`). A leading `~` means your home (`owner_home`, `host/bin/ug-agent-setup`). | If it is missing, setup stops (`stage_config`, `host/bin/ug-agent-setup`). If it names a different repo that exists, setup stages that repo and gives no error. |
| `skill-repos` in the config repo | One skill repo path on each line (`skill-repos`, `host/bin/ug-agent-setup`). | If a path is not a folder or is outside your home, setup stops (`skill-repos`, `host/bin/ug-agent-setup`). |
| `~/.local/share/underground/backup/config` | The lines `repo=sftp:<user>@<host>:<path>`, `wake=` and `sleep=` (`backup_target_read`, `host/lib/backup-target.bash`). | Setup gives only a warning (`setup_backup`, `host/bin/ug-setup`). The nightly backup then fails, and only `backup/backup.log` records it. |
| `~/.local/share/underground/protected-paths/<owner>/<repo>` | Globs, one on each line. A PR that changes a matching path gets a hold, so you merge it on GitHub (`protected-path`, `host/gh-broker/protocol.ts`). | If it is missing, the gh-broker reads it as empty and gives no warning (`readOptional`, `host/gh-broker/server.ts`). Then only `.github/**` and `CODEOWNERS` are protected (`isProtectedPath`, `host/gh-broker/protocol.ts`). |

## Data folder: `~/.local/share/underground` (yours, mode 700)

| path | what it is for | who writes it | who reads it | when a change takes effect |
|---|---|---|---|---|
| `addresses` | `gateway=<tailscale-ip>:4000` is where the auth gateway listens. `engine=<ip>:<port>` is the inference engine. | setup, once only (`write_addresses`, `host/bin/ug-setup`) | setup (`stage_config`, `start_login_services`, `host/bin/ug-agent-setup`) | Only at the next setup. Setup never rewrites the file, so after a tailscale IP change you must edit it by hand. |
| `backup/password` | The restic repo password | setup, once only (`setup_backup`, `host/bin/ug-setup`) | `RESTIC_PASSWORD_FILE`, `host/bin/ug-backup` | If you lose it, you cannot open the backup. |
| `backup/last` | The time of the last good backup | `backup/last`, `host/bin/ug-backup` | `last_ts`, `host/bin/ug-agent` warns after 36 hours | at once |
| `github-app.pem`, `github-app.json` | The gh-broker app key and client ID | `scripts/gh-broker-app-wizard.sh` | `appFiles`, `host/gh-broker/github-app.ts` | at the next token mint |
| `gh-broker/repos/`, `pushes/`, `reviews/`, `tmp/` | The gh-broker's mirrors and its push and review records | the gh-broker (`defaultConfig`, `host/gh-broker/server.ts`) | the gh-broker | at once. Nothing deletes old review records or runs `git gc` on the mirrors. |
| `services/` | Setup's copy of the gh-broker code, `ug-backup`, `ug-auth`, `ug.bash`, `backup-target.bash`, and `VERSIONS` | setup deletes and remakes it (`install_service_code`, `host/bin/ug-setup`) | the launchd jobs (`ProgramArguments`, `host/launchd/com.underground.gh-broker.plist`, `host/launchd/com.underground.backup.plist`) | Only at the next setup. An edit in your checkout does not change the running services. |
| `restic/<pin>/restic` | The pinned restic | `install_restic`, `host/bin/ug-setup` | `restic_bin`, `host/bin/ug-backup` | at the next setup |
| `agent-ssh/` | Your key for the agent login, and `known_hosts` for `127.0.0.1:2222` | `known_hosts`, `host/bin/ug-agent-setup` | `known_hosts`, `host/bin/ug-agent` | at once |
| `agent/bin/ug-agent` | The launcher. `~/.local/bin/omp` links to it. | `agent_dir`, `host/bin/ug-agent-setup` | your shell | at the next setup |
| `state/`, `gh-broker/gh-broker.log`, `backup/backup.log` | Setup fingerprints and the service logs | setup, launchd | you | none |

## Root zone: `/Library/Underground` (root-owned)

| path | what it is for | who writes it | who reads it |
|---|---|---|---|
| `config/` | The staged agent config. `models.yml` holds the gateway address and its bearer. It is `root:ugagent`, so you cannot read it. | `stage_config`, `host/bin/ug-agent-setup` | `config-names`, `host/agent/agent-start`, at each start |
| `config-names` | The names that the agent config owns in `~/.omp/agent` | `config-names`, `host/bin/ug-agent-setup` | `config-names`, `host/agent/agent-start`, `host/agent/agent-home-tar` |
| `addresses` | A root-owned copy of your `addresses`. The usage broker runs as `ugauth` and cannot read your home. | `addresses`, `host/bin/ug-agent-setup` | `addressesFile`, `host/gh-broker/usage-broker.ts` |
| `omp/<pin>/omp`, `omp.sha256`, `bin/omp` | The one pinned omp, `root:ugomp` mode 550 | `omp_bin`, `host/bin/ug-agent-setup` | `omp_bin`, `host/agent/agent-start` checks the hash at each start |
| `bin/gh-broker`, `gh-broker/*.ts` | The gh-broker client for the agent | `client.ts`, `host/bin/ug-agent-setup` | `bin/gh-broker`, `host/agent/agent-start`, and `sync_clone`, `host/agent/agent-refresh` |
| `usage-broker/*.ts` | The usage broker code. The pinned omp runs it (`ProgramArguments`, `host/agent/com.underground.usage-broker.plist`). | `usage-broker`, `host/bin/ug-agent-setup` | its LaunchDaemon |
| `pin.sb`, `agent-session`, `agent-start`, `agent-refresh`, `sshd_config`, `ssh_host_ed25519_key`, `authorized_keys/ugagent` | The agent login, its sandbox, and the clone refresh | `pin.sb`, `host/bin/ug-agent-setup` | the agent sshd, `sandbox-exec`, `host/agent/agent-session`, and the refresh LaunchDaemon |
| `run/` | The folder of the gh-broker socket. It is yours, group `ugagent`, mode 710, so only you and the agent user can open it. Root writes nothing in it: the agent sshd keeps no pid file (`PidFile`, `host/agent/sshd_config`). | `710`, `host/bin/ug-agent-setup` | the gh-broker and its client |
| `run/gh-broker.sock` | The gh-broker socket, mode 660. It gets the group `ugagent` from its folder [macOS gives a new file the group of its folder; a socket made by `ugagent` in a folder with that group had it, run 2026-11-09]. | the gh-broker (`listenUnix`, `socketPath`, `host/gh-broker/server.ts`) | the agent's gh-broker client |

## Login user: `/Users/ugauth` (mode 700, not readable by you)

| path | what it is for | who writes it | when a change takes effect |
|---|---|---|---|
| `.omp/` (omp's default profile) | The model logins and API keys | omp, through `ug-auth login` and `ug-auth key` (`UG_KEY_NAME`, `host/bin/ug-auth`), and the auth broker, through `ug-auth revoke` (`revoke`, `host/bin/ug-auth`) | at once, in the auth broker |
| `.omp/auth-gateway.token` | The bearer for the auth gateway. Setup puts it into `models.yml`. | setup, if it is empty (`auth-gateway.token`, `host/bin/ug-agent-setup`), or `ug-auth auth-gateway token --regenerate` | Sessions get the new bearer only after the next setup (`gateway_token`, `host/bin/ug-agent-setup`). |
| `.omp/auth-broker.token` | The bearer that the auth broker asks its clients for | omp, not this repo | Setup uses it only to look for leaks in the config (`auth-broker.token`, `host/bin/ug-agent-setup`) and as a restart input (`auth-broker.token`, `host/bin/ug-agent-setup`). |
| `logs/` | The logs of the auth broker, the auth gateway, and the usage broker | launchd | none |

## Agent user: `/Users/ugagent`

| path | what it is for | who writes it |
|---|---|---|
| `.omp/agent/` | The agent's omp config. Each start replaces the `config-names` entries with the staged copy (`config-names`, `host/agent/agent-start`). | `agent-start`, then omp |
| `work/<owner>/<repo>` | The agent's clone of each repo (`clone`, `host/agent/agent-start`). Each start touches `.git/ug-launched` (`ug-launched`, `host/agent/agent-start`). The refresh syncs only clones whose marker is less than 7 days old (`-mtime`, `host/agent/agent-refresh`). | `agent-start`, the refresh, and the agent |
| `logs/agent-refresh.log` | The refresh log. The refresh empties it when it is over 1 MB (`log` and `1048576`, `host/agent/agent-refresh`). | the refresh |
| everything else | Sessions, caches, worktrees. The nightly backup saves it, without the config names (`--exclude`, `host/agent/agent-home-tar`). | the agent |

## System files

| path | what it is for | who writes it |
|---|---|---|
| `/Library/LaunchDaemons/com.underground.{auth-broker,auth-gateway,usage-broker,agent-sshd,agent-refresh}.plist` | The login services, the agent sshd, and the clone refresh. Before setup loads one, it checks each program, folder, and `PATH` entry that the service names: root or the service's own user must own it and each folder above it, and no group, other user, or access rule may let another user write it (`ug_trusted_daemon`, `host/lib/ug.bash`). If not, setup stops. | `start_login_services`, `host/bin/ug-agent-setup` |
| `~/Library/LaunchAgents/com.underground.{gh-broker,backup}.plist` | Your gh-broker and the nightly backup | `start_services`, `host/bin/ug-setup` |
| `/etc/ssh/sshd_config.d/010-underground-deny-ugagent.conf` | It keeps `ugagent` out of the system sshd. | `DenyUsers`, `host/bin/ug-agent-setup` |
| `/etc/sudoers.d/underground-backup` | It lets you run `agent-home-tar` with no password. | `NOPASSWD`, `host/bin/ug-agent-setup` |

## Host facts

`host/facts` holds each value that more than one file needs: the install root, your data folder, the agent and login users with their homes and groups, the ports of the agent sshd, the auth broker, the usage broker, and the auth gateway, the gh-broker socket, and the node that runs your gh-broker. It is the only place that names them. Change a value there, then run setup.

| reader | how it gets the values |
|---|---|
| the shell scripts | `ug_fact`, `host/lib/ug.bash`. It reads the `facts` file one folder above the `ug.bash` that the script sources, so setup installs a copy beside each installed `ug.bash`. |
| templates: the plists, `sshd_config`, `pin.sb`, `agent-start`, `agent-refresh`, `agent-session`, `agent-home-tar` | `ug_render`, `host/lib/ug.bash`. Each `key=value` line fills `@KEY@`; setup stops on a placeholder that nothing fills. |
| the gh-broker and the usage broker | `readHostFacts`, `host/gh-broker/facts.ts`. It reads `../facts` next to the code: `~/.local/share/underground/services/host/facts` for the gh-broker, and `/Library/Underground/facts` for the usage broker. |
