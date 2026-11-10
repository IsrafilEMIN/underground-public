# Spec: underground

This page says what runs now: each built part with what it does and the file that holds it, the steps of the first setup and of a restore, the onboarding checks, the checks that run, and what is deferred. The base is in `docs/PRODUCT-BRIEF.md`. The reasons are dated records in `docs/adr/`. The launchd jobs are listed only in the service table (`host/services`). A host path, port, user, or mode that more than one file needs lives only in the host facts (`host/facts`). This doc names those files and copies no value.

## Parts built

**Setup.** `host/bin/ug-setup` runs as the owner; `host/bin/ug-agent-setup` runs as root at its end. Setup first asks GitHub whether `main` of the checkout's repo needs the owner's approval for every merge and stops if not (`ug_check_main_rule`, `host/lib/ug.bash`), then fast-forwards `main` in its own checkout (`ug_pull_main`, `host/lib/ug.bash`), downloads the pinned omp and restic (`install_restic`, `host/bin/ug-setup`), stages the config (`stage_config`, `host/bin/ug-agent-setup`), makes the agent user, the login user, and the gh-broker user (`make_user`, `host/bin/ug-agent-setup`), builds the root code folder fresh and swaps it in (`code.new`, `host/bin/ug-agent-setup`), installs the jobs from the service table, and at its end checks as the owner that the owner cannot run the omp binary, read the staged config, or list the login home or the gh-broker home (`check_walls`, `host/bin/ug-setup`). Setup runs no tests: CI runs them on a macOS runner (owner decision, 2026-11-10). Only the owner runs setup.

**Pinned omp.** `VERSIONS` holds the omp version and its SHA-256, the restic version and hash, and the gh version and hashes (`docs/adr/0012-pinned-omp-and-setup.md`). Setup downloads the file and checks the hash as the owner; root installs it (`docs/adr/0017-one-omp-binary-and-no-ug-folder.md`, `docs/adr/0018-login-user.md`). The install sets its owner and mode so only the agent user, the login user, and the gh-broker user can run it, and stops when a check after the change still differs (`ug_ensure_owner_mode`, `host/bin/ug-agent-setup`). Each start checks the binary's hash before omp runs (`omp_bin`, `host/agent/agent-start`).

**omp launcher.** `~/.local/bin/omp` is a link to `host/bin/ug-agent`. While the system's Remote Login runs, it checks the effective sshd config and refuses to launch unless that config denies the agent user (`ug_sshd_denies_agent`, `host/bin/ug-agent`); without the denial, the agent could log in there outside the sandbox profile. It prints the problems in the watch status (`status`, `host/bin/ug-agent`), logs into the agent's own sshd on the port of the facts (`agent_sshd_port`, `host/facts`), and runs the session start there.

**Session start.** `host/agent/agent-session` starts the session under the pin; `host/agent/agent-start` checks the binary, resets the config names in the agent home to the staged copy with one delete and one clone (`config-names`, `host/agent/agent-start`), syncs the repo clone (`gh-broker sync --cached`), checks out the base branch, and starts a branch and worktree sweep in the background (`docs/adr/0019-fast-launch-sync.md`).

**Pin.** `host/agent/pin.sb`, rendered with the facts and installed as the root code copy. It holds writes to the agent home and the session's own temp folder, refuses reads under `/Volumes`, refuses a listener on the auth broker's port (`auth_broker_port`, `host/facts`), and refuses `launchctl`, `at`, `crontab`, and `batch`. Every agent process starts under it, the clone refresh at boot included (`docs/adr/0016-agent-user.md`, `docs/adr/0022-loopback-one-firewall-line.md`, `docs/adr/0024-state-over-incident-lists.md`).

**Agent login.** `host/agent/sshd_config` with the agent sshd: key-only, loopback, forced to `agent-session`, `PermitUserRC no`. Setup writes the file that keeps the agent user out of the system sshd, and checks the effective config (`docs/adr/0016-agent-user.md`).

**Login services.** The auth broker, the auth gateway, and the usage broker run as the login user from the service table. The ports and the gateway address come from the facts. The logins and the two tokens live in the login user's home, which the owner cannot read (`docs/adr/0018-login-user.md`). The usage broker (`host/gh-broker/usage-broker.ts`) holds no credential and answers the native `/usage` through the gateway. `host/bin/ug-auth` is the owner's sudo command for provider logins, API keys, listing, and revoke.

**Loopback line.** The pin refuses the agent a bind on the auth broker's port; the one pf line refuses the agent user as a listener there outside the pin (`host/agent/agent-pf.conf`, loader `host/agent/agent-pf-load`, a root job in the service table, `docs/adr/0022-loopback-one-firewall-line.md`). Setup stops unless pf is on and the anchor holds the line (`ug_pf_refuses_listener`, `host/lib/ug.bash`).

**Config staging.** Setup reads the last commit of the config repo (named by a hand-written pointer in the data folder) and of each skill repo named in the config repo, refuses a link, a special file, or a token shape in either (`vet_item`, `host/bin/ug-agent-setup`; shapes in `host/secret-patterns`), fills the gateway address and bearer into `models.yml`, and stages the result in a root folder the agent user alone can read among non-root users (`stage_config`, `host/bin/ug-agent-setup`). Each start copies it over the agent's own config, so the agent's config edits die at the next start.

**Clone refresh.** `host/agent/agent-refresh` runs every 30 s as the agent user under the pin: it syncs each clone a session used in the last 7 days, with git hooks off, so agent-planted hooks never run between sessions (`docs/adr/0019-fast-launch-sync.md`, "Decision", item 8).

**gh-broker.** Open, in redesign (owner decision, 2026-11-10). The merge gate is deleted (`docs/adr/0026-delete-the-merge-gate.md`): the gh-broker has no merge verb and no review verb (`VERBS`, `host/gh-broker/protocol.ts`), and the owner merges every PR on GitHub. What runs today: one host service answers the agent's GitHub calls over the socket of the facts (`gh_broker_socket`, `host/facts`). It runs as the gh-broker user on the pinned omp, `/usr/bin/git`, and the pinned gh, and its home holds the app key, the mirrors, and the push records (`docs/adr/0025-agent-input-runs-with-least-rights.md`). It holds the app key and the only GitHub token an agent uses, keeps each used repo's main current, serves the launch sync, ends the branches it pushed once their commit is in main, and caps what a CI log can return (`host/gh-broker/`).

**Branch and worktree cleanup.** The sweep (`sweep`, `host/gh-broker/sweep.ts`) removes a worktree only when its work is in main, it is not young, no process works in it, and it holds no unsaved files; it moves ignored files to a held folder for 14 days (`holdIgnored`, `host/gh-broker/sweep.ts`) and lists what it kept, with the reason, in `ug-kept.json` in the clone's git folder (`docs/adr/0020-state-based-branch-cleanup.md`).

**Backup.** Once a day the backup job in the service table (`host/bin/ug-backup`) reads the agent home through the root helper `host/agent/agent-home-tar`, which a sudoers rule allows, excludes the staged config names and live sockets (`--exclude`, `host/agent/agent-home-tar`), and stores the tar stream in the restic repo the owner names in the backup settings, through the pinned restic. Every snapshot stays (`docs/adr/0016-agent-user.md`, "Step 4 (2026-11-08): the switch").

**Watch.** `host/bin/ug-watch` runs every 5 minutes as the owner from the service table: it reads each job's record, asks the login services and the agent sshd, rechecks after 60 s, writes the status (`status`, `host/bin/ug-watch`), and pings the outside check whose address the owner writes by hand. The outside check alerts the owner on a failure and when no ping arrives within its period, so a dead mac or a dead watch cannot stay silent. The launcher prints the written status at each start, so the owner sees the problems before the first answer (`docs/adr/0023-failures-reach-the-owner.md`).

## First setup

The owner does these steps once on a new mac. At its end, setup lists each step that it cannot do itself under "still to do" (`later`, `host/bin/ug-setup`).

1. Get the tools: an Apple silicon mac (`omp-darwin-arm64`, `host/bin/ug-setup`), `gh` with your GitHub login and `jq` (`ug_check_main_rule`, `host/lib/ug.bash`), and Tailscale with an IPv4 address (`write_addresses`, `host/bin/ug-setup`).
2. Clone underground into your home, outside the data folder (`owner_data`, `host/facts`). Setup refuses to run from inside it (`ug-setup`, `host/bin/ug-setup`). On GitHub, make the ruleset on `main` of onboarding check 6. Without it, setup stops before it pulls (`ug_check_main_rule`, `host/lib/ug.bash`).
3. Make the agent config repo: a git repo in your home whose last commit holds `models.yml`. Setup fills `@GATEWAY@` and `@GATEWAY_TOKEN@` in it, and reads the skill repos from its `skill-repos` file (`stage_config`, `host/bin/ug-agent-setup`). Make the data folder with mode 700, and write the path of the config repo into its `config-repo` file (`docs/HOST-STATE.md`, "Files that you write by hand"). Without that file, the root step of setup stops.
4. Run `scripts/gh-broker-app-wizard.sh` from your checkout. It registers the gh-broker app, makes its key, installs it on the repos that you pick, writes the key and the app config into the data folder, and then runs setup (`docs/adr/0007-gh-broker-github-app.md`). Setup asks for the address of the inference engine when the data folder has no `addresses` file (`write_addresses`, `host/bin/ug-setup`). sudo asks for your password once, for the root step.
5. Log in to each model provider with `ug-auth login <provider>`, or store an API key with `ug-auth key <NAME>_API_KEY` (`usage`, `host/bin/ug-auth`). Setup puts `ug-auth` on `PATH` (`install_service_code`, `host/bin/ug-setup`).
6. Do each item of "still to do": put `~/.local/bin` on `PATH` before any other omp (`check_path`, `host/bin/ug-setup`), write the backup settings and keep a copy of the backup password in your password manager (`setup_backup`, `host/bin/ug-setup`), and write the ping address (`prepare_services`, `host/bin/ug-setup`). The formats are in `docs/HOST-STATE.md`, "Files that you write by hand". The backup and the watch read these files at each run, so setup need not run again.
7. Type `omp`. The launcher prints the problems that the watch found before the session starts (`status`, `host/bin/ug-agent`).

Before agents work alone in another repo, the owner makes the onboarding checks below.

## Restore

A restore undoes harm to the agent home (`docs/PRODUCT-BRIEF.md`, H4). Each snapshot is one tar stream with the tag `ug-agent` (`--stdin-filename`, `host/bin/ug-backup`), so `restic restore` gives only the tar file; `restic dump` into `tar -x` unpacks it. A snapshot restores cleanly only to the home path it came from (`docs/PRODUCT-BRIEF.md`, "Backup").

In the commands, `restic` is the pinned restic in the data folder (`restic_bin`, `host/bin/ug-backup`), `<repo>` is the `repo=` line of the backup settings, and `<agent_home>` and `<agent_user>` are the values of `host/facts`.

1. On a new mac, do the first setup, then write the backup settings and put the copy of the backup password into the data folder (`docs/HOST-STATE.md`, "Data folder: `owner_data` (yours, mode 700)").
2. Run the `wake=` command of the backup settings, and wait until the backup machine answers ssh (`backup_target_wake`, `host/lib/backup-target.bash`).
3. Set `RESTIC_PASSWORD_FILE` to the backup password file. Pick a snapshot from `restic -r <repo> snapshots --tag ug-agent`.
4. To get back some files, or to test the backup, unpack into a scratch folder of yours: `restic -r <repo> dump <id> ug-agent-home.tar | tar -x -C <scratch>`. This writes nothing in the live home. Delete the folder afterwards, because it holds a full copy of the agent home. The owner ran this step on 2026-11-08 (`docs/adr/0016-agent-user.md`, "Step 4 (2026-11-08): the switch").
5. To restore the whole home, end each omp session, and stop the clone refresh, because it writes in the agent home every 30 s: `sudo launchctl bootout system/<label>`, with the label of the agent refresh row of `host/services`. Then run `restic -r <repo> dump <id> ug-agent-home.tar | sudo tar -x -C <agent_home>`, then `sudo chown -R <agent_user>:staff <agent_home>` (`PrimaryGroupID`, `host/bin/ug-agent-setup`). This writes over the live home: each file of the snapshot comes back, and each file that the snapshot does not hold stays. The ADR records no run of this step on the agent home.
6. After a whole-home restore, run `host/bin/ug-setup`. It loads the clone refresh again, because launchd no longer has it (`ug_ensure_service`, `host/lib/ug.bash`). The next session start copies the staged config over the config names, which the snapshot does not hold (`--exclude`, `host/agent/agent-home-tar`).
7. Run the `sleep=` command of the backup settings.

Open: root unpacks agent-made bytes in step 5, and the owner in step 4 (`docs/THREAT-MODEL.md`, U40).

## Onboarding checks

The owner checks each repo on GitHub before agents work alone in it.

1. No Actions secrets and no credential variables for `pull_request` jobs. No `id-token: write`.
2. The default `GITHUB_TOKEN` is read-only.
3. GitHub-hosted runners only.
4. The gh-broker app is a GitHub App of the owner's account, installed on selected repos, with no Workflows and no Administration permission (`docs/adr/0007-gh-broker-github-app.md`).
5. Each workflow that deploys, publishes, or uses secrets on `main` waits for the owner's approval in a GitHub environment. So a merge has no effect that a revert cannot undo.
6. A repo whose code runs on the host, such as underground: the owner merges each PR on GitHub and reads the merged change before the host runs it. GitHub enforces this: a ruleset on `main` needs the owner's approval as code owner for every merge, and setup stops before it pulls when that ruleset is missing or weaker (`ug_check_main_rule`, `host/lib/ug.bash`; `docs/adr/0021-github-holds-the-wall-on-main.md`). Setup runs no test file as the owner, so test code that the agent writes runs only on GitHub's runners (owner decision, 2026-11-10). The ruleset therefore requires the CI jobs `checks` and `tests` by name, from GitHub Actions, and setup stops when either is missing (`ug_main_rule_gaps`, `host/lib/ug.bash`). The ruleset also needs approval of the most recent push from someone other than its pusher, and GitHub counts only a push that changes the PR's diff. So after the owner pushes to an agent PR, the agent pushes a change before the owner can approve it ([GitHub Docs, "Available rules for rulesets"](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), read 2026-11-10; the "reviewable push" reading is [inference] from PR 167).

A repo is onboarded when the owner has made these checks and installed the gh-broker app on it: the app's installation is the list (owner decision, 2026-11-03).

Live run before trust: in a throwaway repo that passes the checks, one task from branch to merge, one revert, and one PR with a planted defect that `security-review` must find.

## Checks that run

**CI.** `.github/workflows/ci.yml` runs on each PR head and each push to `main`. The `checks` job runs on Linux: bash and sh syntax, shellcheck, and `xmllint` on the plist templates. The `tests` job runs on macOS, where the code runs: the broker tests and the host tests, and it fails when a `[mac]` test skips, because a skip checks nothing (owner decision, 2026-11-10). When a test fails, the job prints the list of failed tests as the last lines of its log, so the tail that `gh-broker ci-log` shows names them (owner decision, 2026-11-10). The suite uses fake data only: temp homes, local bare repos in place of GitHub, and a fake `gh`. The host tests include the doc citation check (`scripts/check-doc-citations.mjs`, run by `tests/host/doc-citations.test.ts`) and the fixed-identity check (`scripts/check-repo-references.mjs`, run by `tests/host/repo-references.test.ts`).

**Setup.** Before it changes anything: the service table rule, which refuses a job of the owner or root that reads agent input and names no threat row (`ug_services_allowed`, `host/lib/ug.bash`), the ruleset check (`ug_check_main_rule`), a hash match for each download, and `pfctl -n` on the rendered firewall file. Before it loads a job from the service table: root or the job's own user must own each program, folder, and `PATH` entry it names, only root may own the folder of its launchd log, and none may be writable by another user (`ug_trusted_daemon`, `host/lib/ug.bash`). After it loads a daemon: launchd runs it as the user of its row (`ug_service_runs_as`, `host/lib/ug.bash`). Before it ends: the pf anchor holds the firewall line (`ug_pf_refuses_listener`), and the walls hold from the owner's account (`check_walls`). A render stops on a placeholder nothing fills (`ug_render`, `host/lib/ug.bash`).

**Watch.** The status above, with the user of each daemon, the firewall job's last exit code, and the socket answer from the gh-broker's own check (`problems`, `host/bin/ug-watch`). For the user of a daemon it takes launchd's `username` line; else `ps` of the daemon's pid; else, when the daemon does not run, the `UserName` key of the installed plist. When it cannot read the user, it reports a problem instead of passing (`ug_service_runs_as`, `host/lib/ug.bash`). Every 5 minutes on the mac, and outside it through the ping check that alerts when the pings stop (`docs/adr/0023-failures-reach-the-owner.md`).

## Deferred

- The gh-broker, auto merge, and a merge queue: open, in redesign.
- A test of a program that talks to launchd directly, without the `launchctl` path the pin refuses (`docs/adr/0016-agent-user.md`, "Open"; `docs/adr/0021-github-holds-the-wall-on-main.md`, "Amendment 2026-11-10: the rule against the other controls", item 3).
- Per-repo network allowlists, with the data-out question (`docs/THREAT-MODEL.md`, U14).
- A check that the owner has set a spend cap at each provider (`docs/adr/0021-github-holds-the-wall-on-main.md`, "Amendment 2026-11-10: the rule against the other controls", item 4).
- The notice at session start for kept branches (`docs/adr/0020-state-based-branch-cleanup.md`, "Decision", item 4).
- A feature request: `/usage` through the auth gateway, so the usage broker can go.
- The MVPF rows of `docs/THREAT-MODEL.md`.
