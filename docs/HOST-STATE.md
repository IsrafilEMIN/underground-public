# Host state

This page lists each file outside the repo that underground reads or writes on the mac. For each file, it says who writes it, who reads it, and when a change takes effect. It describes what runs today. The values of the paths, users, and ports are in `host/facts`. The services are in `host/services`.

Most changes take effect only when you run `host/bin/ug-setup`. Setup copies your files into root-owned snapshots. The services and sessions read only those snapshots.

Setup first asks GitHub, with your `gh` login, whether `main` of the checkout's repo needs your approval for every merge. If not, it stops before it pulls (`ug_check_main_rule`, `host/lib/ug.bash`; `docs/adr/0021-github-holds-the-wall-on-main.md`). So setup needs `gh` with your login, `jq`, and a reply from GitHub.

## Where data moves

```text
(1) YOU RUN host/bin/ug-setup
    config repo (last commit) ─┐
    skill repos (last commit) ─┼──► root/config/    (models.yml gets the gateway and its bearer)
    data folder: addresses ────┼──► root/code/addresses and the rendered service plists
    checkout: host/** ─────────┼──► owner_data/services/    (code that the services run)
    VERSIONS (version and SHA-256) ──► root/omp/<pin>/omp, root/gh/<pin>/gh
    data folder: github-app.* ──► gh_broker_home/ (moved)

(2) EACH SESSION STARTS (omp ─► ssh to the agent sshd port ─► agent-start, as the agent user)
    root/config/ ──copy──► agent_home/.omp/agent/
    gh-broker sync ─────► agent_home/work/<owner>/<repo>

(3) ALL THE TIME (services in host/services)
    gh-broker     as gh_broker_user, reads  gh_broker_home/github-app.*   writes  gh_broker_home/{repos,pushes}, root/run/gh-broker.status
    agent refresh every 30 s syncs each clone that a session used in the last 7 days
    agent firewall every 30 s loads root/code/pf.conf into the pf anchor
    auth broker   reads/writes  auth_home/.omp  (logins, tokens)
    auth gateway  reads  auth_home/.omp, listens on the gateway address
    usage broker  reads  root/code/addresses, auth_home/.omp/auth-gateway.token
    backup        reads  backup/config, backup/password, all of agent_home  writes  backup/last
    watch         reads  root/run/gh-broker.status, backup/last, addresses, watch/ping, launchd, health routes  writes  watch/status, pings the outside check
```

## Files that you write by hand

No code makes these files. Setup or the service reads them as they are.

| path | what it is for | if it is missing or wrong |
|---|---|---|
| `owner_data/config-repo` | One line: the path to your agent config repo (`config-repo`, `host/bin/ug-agent-setup`). A leading `~` means your home. | If it is missing, setup stops (`stage_config`, `host/bin/ug-agent-setup`). If it names a different repo that exists, setup stages that repo and gives no error. |
| `skill-repos` in the config repo | One skill repo path on each line (`skill-repos`, `host/bin/ug-agent-setup`). | If a path is not a folder or is outside your home, setup stops (`skill-repos`, `host/bin/ug-agent-setup`). |
| `owner_data/backup/config` | The lines `repo=sftp:<user>@<host>:<path>`, `wake=` and `sleep=` (`backup_target_read`, `host/lib/backup-target.bash`). | Setup gives only a warning (`setup_backup`, `host/bin/ug-setup`). The nightly backup then fails, and only `backup/backup.log` records it. |

| `owner_data/watch/ping` | One `https://` line: the ping address of a check on an outside service (`ping_file`, `host/bin/ug-watch`; `docs/adr/0023-failures-reach-the-owner.md`). It is a secret: anyone with it can send "ok". | Setup lists it as left to do (`prepare_services`, `host/bin/ug-setup`). The watch still runs, but nothing outside the mac alerts you, and each launch warns about it. |

## Data folder: `owner_data` (yours, mode 700)

| path | what it is for | who writes it | who reads it | when a change takes effect |
|---|---|---|---|---|
| `addresses` | `gateway=<tailscale-ip>:<gateway_port>` is where the auth gateway listens. `engine=<ip>:<port>` is the inference engine. | setup, once only (`write_addresses`, `host/bin/ug-setup`) | setup (`stage_config`, `start_services`, `host/bin/ug-agent-setup`) | Only at the next setup. Setup never rewrites the file, so after a tailscale IP change you must edit it by hand. |
| `backup/password` | The restic repo password | setup, once only (`setup_backup`, `host/bin/ug-setup`) | `RESTIC_PASSWORD_FILE`, `host/bin/ug-backup` | If you lose it, you cannot open the backup. |
| `backup/last` | The time of the last good backup | `backup/last`, `host/bin/ug-backup` | `backup_stale`, `host/bin/ug-watch` reports it after 36 hours | at once |
| `github-app.pem`, `github-app.json` | A new gh-broker app key and client ID, waiting for setup | `scripts/gh-broker-app-wizard.sh` | root moves each into the gh-broker home and deletes it here (`github-app.pem`, `host/bin/ug-agent-setup`) | at the next setup |
| `watch/status` | The time of the last watch run and one line for each problem it found | `status`, `host/bin/ug-watch` | `status`, `host/bin/ug-agent` prints each problem at launch, and warns when it is older than 15 minutes | at once |
| `services/` | Setup's copy of `ug-backup`, `ug-watch`, `ug-auth`, `ug.bash`, `backup-target.bash`, and `VERSIONS` | setup deletes and remakes it (`install_service_code`, `host/bin/ug-setup`) | the services in `host/services` | Only at the next setup. An edit in your checkout does not change the running services. |
| `restic/<pin>/restic` | The pinned restic | `install_restic`, `host/bin/ug-setup` | `restic_bin`, `host/bin/ug-backup` | at the next setup |
| `gh/<pin>/gh` | The pinned gh, downloaded and checked | `stage_gh`, `host/bin/ug-setup` | root, which installs a copy in `root/gh/` (`gh_staged`, `host/bin/ug-agent-setup`) | at the next setup |
| `agent-ssh/` | Your key for the agent login, and `known_hosts` for the agent sshd on loopback | `known_hosts`, `host/bin/ug-agent-setup` | `known_hosts`, `host/bin/ug-agent` | at once |
| `agent/bin/ug-agent` | The launcher. `~/.local/bin/omp` links to it. | `agent_dir`, `host/bin/ug-agent-setup` | your shell | at the next setup |
| `state/`, `backup/backup.log`, `watch/watch.log` | Setup fingerprints and the service logs | setup, launchd | you | none |

Nothing reads `protected-paths/` any more; you may delete it.

## Root folder: `root` (root-owned)

Setup builds `code/` fresh from the checkout at each run, swaps it in, and at its end deletes each entry at the top of `root` that it does not make (`code.new` and `ssh_host_ed25519_key.pub`, `host/bin/ug-agent-setup`; `docs/adr/0024-state-over-incident-lists.md`).

| path | what it is for | who writes it | who reads it |
|---|---|---|---|
| `config/` | The staged agent config. `models.yml` holds the gateway address and its bearer. It is `root:ugagent`, so you cannot read it. | `stage_config`, `host/bin/ug-agent-setup` | `config-names`, `host/agent/agent-start`, at each start |
| `omp/<pin>/omp`, `omp.sha256` | The one pinned omp, owner and mode set by `ug_ensure_owner_mode` (`host/bin/ug-agent-setup`), group `omp_group` | `omp_bin`, `host/bin/ug-agent-setup` | `omp_bin`, `host/agent/agent-start` checks the hash at each start |
| `code/facts`, `code/config-names`, `code/addresses` | The host facts, the names that the agent config owns in `agent_home/.omp/agent`, and a root-owned copy of your `addresses`. The usage broker runs as the login user and cannot read your home. | `code.new`, `host/bin/ug-agent-setup` | `config-names`, `host/agent/agent-start`, `host/agent/agent-home-tar`; `addressesFile`, `host/gh-broker/usage-broker.ts` |
| `code/bin/omp`, `code/bin/gh-broker`, `code/gh-broker/*.ts` | The link to the pinned omp, the gh-broker client for the agent, and the usage broker code, which the pinned omp runs | `code.new`, `host/bin/ug-agent-setup` | `omp_bin` and `gh-broker`, `host/agent/agent-start`; `sync_clone`, `host/agent/agent-refresh`; the usage broker service |
| `code/bin/agent-home-tar` | The backup helper. It runs as the agent user, not as root. | `code.new`, `host/bin/ug-agent-setup` | `agent_tar`, `host/bin/ug-backup`, through `sudo -n -u <agent_user>` and `/etc/sudoers.d/underground-backup` (System files) |
| `code/pin.sb`, `code/agent-session`, `code/agent-start`, `code/agent-refresh`, `code/sshd_config`, `code/authorized_keys/ugagent`, `ssh_host_ed25519_key` | The agent login, its sandbox, and the clone refresh. Setup makes the host key once. | `code.new` and `ssh-keygen`, `host/bin/ug-agent-setup` | the agent sshd, `sandbox-exec`, `host/agent/agent-session`, and the refresh service |
| `code/pf.conf`, `code/pf-load` | The firewall line that refuses the agent user as the listener on the auth broker's port (`auth_broker_port`), and its loader (`docs/adr/0022-loopback-one-firewall-line.md`) | `code.new`, `host/bin/ug-agent-setup` | the firewall service in `host/services`, at load and every 30 s (`StartInterval`, `host/agent/com.underground.agent-pf.plist`) |
| `gh/<pin>/gh` | The pinned gh that the gh-broker runs, `root:wheel` mode 555. Its path is a program argument of the gh-broker job, so the trust check covers it. | `gh_bin`, `host/bin/ug-agent-setup` | the gh-broker (`ghPath`, `host/gh-broker/server.ts`) |
| `run/` | The folder of the gh-broker socket and status. The gh-broker user owns it, group `agent_group`, mode 711. Root writes nothing in it: the agent sshd keeps no pid file (`PidFile`, `host/agent/sshd_config`). | `710`, `host/bin/ug-agent-setup` | the gh-broker and its client |
| `run/gh-broker.sock` | The gh-broker socket, mode 660 (`gh_broker_socket`, `host/facts`). It gets the group of its folder, so only the agent user can connect. | the gh-broker (`listenUnix`, `socketPath`, `host/gh-broker/server.ts`) | the agent's gh-broker client |
| `run/gh-broker.status` | The time of the last 30 s refresh, the repos that failed in it, and the socket answer of the tick, mode 644 (`gh_broker_status`, `host/facts`) | the gh-broker, each tick (`writeRefreshStatus`, `host/gh-broker/server.ts`) | `broker_stale`, `host/bin/ug-watch` reports it after 120 s |
| `logs/` | The logs of the gh-broker, the auth broker, the auth gateway, and the usage broker, which launchd opens before the job runs. The folder is `root:wheel` mode 711, so a service user cannot put a link in it. Setup makes each log, owned by the user of its service, mode 600 (`start_services`, `host/bin/ug-agent-setup`). Read a log with `sudo cat`. | launchd | you, with `sudo` |

## Login user: `auth_home` (mode 700, not readable by you)

| path | what it is for | who writes it | when a change takes effect |
|---|---|---|---|
| `.omp/` (omp's default profile) | The model logins and API keys | omp, through `ug-auth login` and `ug-auth key` (`UG_KEY_NAME`, `host/bin/ug-auth`), and the auth broker, through `ug-auth revoke` (`revoke`, `host/bin/ug-auth`) | at once, in the auth broker |
| `.omp/auth-gateway.token` | The bearer for the auth gateway. Setup puts it into `models.yml`. The owner rotates it with `ug-auth auth-gateway token --regenerate`, which `host/bin/ug-auth` passes through to omp (`docs/adr/0005-model-auth-gateway.md`). | setup, if it is empty (`auth-gateway.token`, `host/bin/ug-agent-setup`), and the owner's rotation | Sessions get the bearer after the next setup (`gateway_token`, `host/bin/ug-agent-setup`). |
| `.omp/auth-broker.token` | The bearer that the auth broker asks its clients for | omp, not this repo | Setup uses it only to look for leaks in the config (`auth-broker.token`, `host/bin/ug-agent-setup`) and as a restart input (`auth-broker.token`, `host/bin/ug-agent-setup`). |
| `logs/` | The old service logs, from before the logs moved to `root/logs/`. Nothing writes it now; you may delete it. | nothing | none |

## gh-broker user: `gh_broker_home` (mode 700, not readable by you)

| path | what it is for | who writes it | when a change takes effect |
|---|---|---|---|
| `github-app.pem`, `github-app.json` | The app key and client ID, mode 600 | setup as the gh-broker user, from the wizard's copy in your data folder (`ug_write_as`, `host/lib/ug.bash`) | at the next token mint (`appFiles`, `host/gh-broker/github-app.ts`) |
| `repos/`, `pushes/`, `reviews/`, `tmp/` | The mirrors, the push records, and the old review records. Setup copied them once from your data folder: it reads them with your rights, writes the copy with the gh-broker user's rights, and then deletes the old folder (`old_broker`, `host/bin/ug-agent-setup`). Nothing reads `reviews/` since the merge gate is deleted (`docs/adr/0026-delete-the-merge-gate.md`). | the gh-broker (`defaultConfig`, `host/gh-broker/server.ts`) | at once. Nothing runs `git gc` on the mirrors. |
| `logs/` | The old gh-broker log, from before the log moved to `root/logs/`. Nothing writes it now; you may delete it. | nothing | none |

Setup reads and writes in this home and in the login user's home only with that user's rights (`ug_read_as` and `ug_write_as`, `host/lib/ug.bash`), so a link that the user plants reaches only files that the user can already read or change. A restart input in these homes is read with that user's rights too (`ug_fingerprint`, `host/lib/ug.bash`).

## Agent user: `agent_home`

| path | what it is for | who writes it |
|---|---|---|
| `.omp/agent/` | The agent's omp config. Each start replaces the `config-names` entries with the staged copy (`config-names`, `host/agent/agent-start`). | `agent-start`, then omp |
| `work/<owner>/<repo>` | The agent's clone of each repo (`clone`, `host/agent/agent-start`). Each start touches `.git/ug-launched` (`ug-launched`, `host/agent/agent-start`). The refresh syncs only clones whose marker is less than 7 days old (`-mtime`, `host/agent/agent-refresh`). | `agent-start`, the refresh, and the agent |
| `logs/agent-refresh.log` | The refresh log. The refresh empties it when it is over 1 MiB (`log` and `1048576`, `host/agent/agent-refresh`). | the refresh |
| everything else | Sessions, caches, worktrees. The nightly backup saves it, without the config names (`--exclude`, `host/agent/agent-home-tar`). | the agent |

## System files

| path | what it is for | who writes it |
|---|---|---|
| The daemons, as LaunchDaemons in `/Library/LaunchDaemons/` | The gh-broker, the auth broker, the auth gateway, the usage broker, the agent sshd, and the clone refresh. After setup loads one, it checks that launchd runs it as the user of its row (`ug_service_runs_as`, `host/lib/ug.bash`). Before setup loads one, it checks each program, folder, and `PATH` entry that the service names: root or the service's own user must own it and each folder above it, and no group, other user, or access rule may let another user write it. A launchd log must not be a link, root or the service's user must own it, and only root may own its folder and each folder above it (`ug_trusted_daemon`, `host/lib/ug.bash`). If not, setup stops. The names are in `host/services`. | `start_services`, `host/bin/ug-agent-setup` |
| The owner's services as LaunchAgents in `~/Library/LaunchAgents/` | The nightly backup and the watch. Setup boots out and deletes any other underground LaunchAgent (`retire_agents`, `host/bin/ug-setup`). The names are in `host/services`. | `start_services`, `host/bin/ug-setup` |
| `/etc/ssh/sshd_config.d/010-underground-deny-ugagent.conf` | It keeps the agent user out of the system sshd. | `DenyUsers`, `host/bin/ug-agent-setup` |
| `/etc/sudoers.d/underground-backup` | It lets you run the backup helper in `root/code/bin/` as the agent user, with no password. | `NOPASSWD`, `host/bin/ug-agent-setup` |
| The firewall loader, a LaunchDaemon in `host/services` | The firewall loader, as root. Setup checks it with `ug_trusted_daemon` like the other services, and stops unless pf is on and the anchor holds the line (`ug_pf_refuses_listener`, `host/lib/ug.bash`). | `agent-pf`, `host/bin/ug-agent-setup` |
| the pf anchor `com.apple/underground` (kernel state, not a file) | It holds the line of `pf.conf`. The main ruleset of `/etc/pf.conf` evaluates it through `anchor "com.apple/*"`; setup changes no file in `/etc`. To see it: `sudo pfctl -a com.apple/underground -sr`. | `pfctl`, `host/agent/agent-pf-load` |

## Host facts

`host/facts` holds each value that more than one file of the code needs: the install root, your data folder, the agent, login, and gh-broker users with their homes and groups, the ports of the agent sshd, the auth broker, the usage broker, and the auth gateway, and the gh-broker socket and status. The code reads these values only from it. This page names the keys and does not copy the values. Setup installs the new value at its next run, but it does not move what the old value made: a user, a home, or the old install root stays until you move it.

| reader | how it gets the values |
|---|---|
| the shell scripts | `ug_fact`, `host/lib/ug.bash`. It reads the `facts` file one folder above the `ug.bash` that the script sources, so setup installs a copy beside each installed `ug.bash`. |
| templates: the plists, `sshd_config`, `pin.sb`, `agent-start`, `agent-refresh`, `agent-session`, `agent-home-tar`, `agent-pf.conf`, `agent-pf-load` | `ug_render`, `host/lib/ug.bash`. Each `key=value` line fills `@KEY@`; setup stops on a placeholder that nothing fills. |
| the gh-broker and the usage broker | `readHostFacts`, `host/gh-broker/facts.ts`. It reads `../facts` next to the code: the gh-broker and the usage broker read the copy in `root/code/`. |

## Service table

`host/services` lists each launchd job, one per line, with 10 fields split by `|`: label, name, scope, user, template, health, log, inputs, agent input, and follows. Setup, the watch, `ug-agent`, and the tests read it (`ug_services` and `ug_service_field`, `host/lib/ug.bash`). Both setups turn the health field into a check with one function, which refuses a kind that the job's scope cannot use (`ug_service_probe`, `host/lib/ug.bash`), and setup and the watch map the user field to a login with one function (`ug_service_login`). Setup installs a copy beside each installed `ug.bash`. A new job needs one line and a plist template.

| field | what it holds |
|---|---|
| label | The launchd label. |
| name | The short name in setup lines and watch alerts. |
| scope | `agent`: `ug-setup` loads it as your LaunchAgent. `daemon`: `ug-agent-setup` loads it as a root LaunchDaemon. |
| user | `owner`, `root`, or a key of `host/facts`. A daemon runs as `root` or as the value of that key. |
| template | The plist template, from the repo root. |
| health | How the job shows that it works: `http <url>`, `socket <path>` (the job answers its own check, and the watch reads that answer), `port <host:port>`, `launchd` (loaded, and its last exit code), `pf <port>` (the firewall refuses the agent user as the listener on that port; the watch is not root, so it checks this job like `launchd`), or `none`. An owner job can use `http`, `port`, `launchd`, or `none`; a daemon can use each kind except `none`. |
| log | The job's log, or empty. |
| inputs | The files whose change restarts the job. `@KEY@` is a value of `host/facts`; `@DATA@` is your data folder; `@GATEWAY@` is the `gateway=` line of `addresses`; `@OMP_SHA@` is the hash file of the pinned omp; a leading `?` keeps a file only when it exists, and setup tests it as the job's user (`ug_service_inputs`, `host/lib/ug.bash`). A home placeholder must be the home of the job's own user, and an input that names a home holds no glob character. |
| agent input | What the job reads that the agent makes: `none`, `socket`, `port`, or `files`. A job that is not the agent's and reads agent input adds the id of the threat row that covers it, such as `files U40`; otherwise setup stops before it changes anything (`ug_services_allowed`, `ug_service_allowed`, `host/lib/ug.bash`; `docs/adr/0027-enforce-least-rights.md`). |
| follows | Empty, or the label of a daemon on a line above. When root setup restarts that daemon, it restarts this one too. Only a daemon can follow. |

The watch keeps two named cases, because no field can hold them: it reads the gh-broker's record, its socket answer included, and the backup's age.
