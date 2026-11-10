# Spec: underground

This page says what runs now: each built part with what it does and the file that holds it, the onboarding checks, the checks that run, and what is deferred. The base is in `docs/PRODUCT-BRIEF.md`. The reasons are dated records in `docs/adr/`. The launchd jobs are listed only in the service table (`host/services`). A host path, port, user, or mode that more than one file needs lives only in the host facts (`host/facts`). This doc names those files and copies no value.

## Parts built

**Setup.** `host/bin/ug-setup` runs as the owner; `host/bin/ug-agent-setup` runs as root at its end. Setup first asks GitHub whether `main` of the checkout's repo needs the owner's approval for every merge and stops if not (`ug_check_main_rule`, `host/lib/ug.bash`), then fast-forwards `main` in its own checkout (`ug_pull_main`, `host/lib/ug.bash`), downloads the pinned omp and restic (`install_restic`, `host/bin/ug-setup`), stages the config (`stage_config`, `host/bin/ug-agent-setup`), makes the agent user and the login user (`make_user`, `host/bin/ug-agent-setup`), builds the root code folder fresh and swaps it in (`code.new`, `host/bin/ug-agent-setup`), installs the jobs from the service table, and at its end checks as the owner that the owner cannot run the omp binary, read the staged config, or list the login home (`check_walls`, `host/bin/ug-setup`). Setup runs no tests: CI runs them on a macOS runner (owner decision, 2026-11-10). Only the owner runs setup.

**Pinned omp.** `VERSIONS` holds the omp version and its SHA-256, and the restic version and hash (`docs/adr/0012-pinned-omp-and-setup.md`). Setup downloads the file and checks the hash as the owner; root installs it (`docs/adr/0017-one-omp-binary-and-no-ug-folder.md`, `docs/adr/0018-login-user.md`). The install sets its owner and mode so only the agent user and the login user can run it, and stops when a check after the change still differs (`ug_ensure_owner_mode`, `host/bin/ug-agent-setup`). Each start checks the binary's hash before omp runs (`omp_bin`, `host/agent/agent-start`).

**omp launcher.** `~/.local/bin/omp` is a link to `host/bin/ug-agent`. While the system's Remote Login runs, it checks the effective sshd config and refuses to launch unless that config denies the agent user (`ug_sshd_denies_agent`, `host/bin/ug-agent`); without the denial, the agent could log in there outside the sandbox profile. It prints the problems in the watch status (`status`, `host/bin/ug-agent`), logs into the agent's own sshd on the port of the facts (`agent_sshd_port`, `host/facts`), and runs the session start there.

**Session start.** `host/agent/agent-session` starts the session under the pin; `host/agent/agent-start` checks the binary, resets the config names in the agent home to the staged copy with one delete and one clone (`config-names`, `host/agent/agent-start`), syncs the repo clone (`gh-broker sync --cached`), checks out the base branch, and starts a branch and worktree sweep in the background (`docs/adr/0019-fast-launch-sync.md`).

**Pin.** `host/agent/pin.sb`, rendered with the facts and installed as the root code copy. It holds writes to the agent home and the session's own temp folder, refuses reads under `/Volumes`, refuses a listener on the auth broker's port (`auth_broker_port`, `host/facts`), and refuses `launchctl`, `at`, `crontab`, and `batch`. Every agent process starts under it, the clone refresh at boot included (`docs/adr/0016-agent-user.md`, `docs/adr/0022-loopback-one-firewall-line.md`, `docs/adr/0024-state-over-incident-lists.md`).

**Agent login.** `host/agent/sshd_config` with the agent sshd: key-only, loopback, forced to `agent-session`, `PermitUserRC no`. Setup writes the file that keeps the agent user out of the system sshd, and checks the effective config (`docs/adr/0016-agent-user.md`).

**Login services.** The auth broker, the auth gateway, and the usage broker run as the login user from the service table. The ports and the gateway address come from the facts. The logins and the two tokens live in the login user's home, which the owner cannot read (`docs/adr/0018-login-user.md`). The usage broker (`host/gh-broker/usage-broker.ts`) holds no credential and answers the native `/usage` through the gateway. `host/bin/ug-auth` is the owner's sudo command for provider logins, API keys, listing, and revoke.

**Loopback line.** The pin refuses the agent a bind on the auth broker's port; the one pf line refuses the agent user as a listener there outside the pin (`host/agent/agent-pf.conf`, loader `host/agent/agent-pf-load`, a root job in the service table, `docs/adr/0022-loopback-one-firewall-line.md`). Setup stops unless pf is on and the anchor holds the line (`ug_pf_refuses_listener`, `host/lib/ug.bash`).

**Config staging.** Setup reads the last commit of the config repo (named by a hand-written pointer in the data folder) and of each skill repo named in the config repo, refuses a link, a special file, or a token shape in either (`vet_item`, `host/bin/ug-agent-setup`; shapes in `host/secret-patterns`), fills the gateway address and bearer into `models.yml`, and stages the result in a root folder the agent user alone can read among non-root users (`stage_config`, `host/bin/ug-agent-setup`). Each start copies it over the agent's own config, so the agent's config edits die at the next start.

**Clone refresh.** `host/agent/agent-refresh` runs every 30 s as the agent user under the pin: it syncs each clone a session used in the last 7 days, with git hooks off, so agent-planted hooks never run between sessions (`docs/adr/0019-fast-launch-sync.md`, decision 8).

**gh-broker and the merge gate.** Open, in redesign (owner decision, 2026-11-10). What runs today: one host service answers the agent's GitHub calls over the socket of the facts (`gh_broker_socket`, `host/facts`), holds the app key and the only GitHub token an agent uses, keeps each used repo's main current, serves the launch sync, ends the branches it pushed once their commit is in main, and caps what a CI log can return (`host/gh-broker/`).

**Branch and worktree cleanup.** The sweep (`sweep`, `host/gh-broker/sweep.ts`) removes a worktree only when its work is in main, it is not young, no process works in it, and it holds no unsaved files; it moves ignored files to a held folder for 14 days (`holdIgnored`, `host/gh-broker/sweep.ts`) and lists what it kept, with the reason, in `ug-kept.json` in the clone's git folder (`docs/adr/0020-state-based-branch-cleanup.md`).

**Backup.** Once a day the backup job in the service table (`host/bin/ug-backup`) reads the agent home through the root helper `host/agent/agent-home-tar`, which a sudoers rule allows, excludes the staged config names and live sockets (`--exclude`, `host/agent/agent-home-tar`), and stores the tar stream in the restic repo the owner names in the backup settings, through the pinned restic. Every snapshot stays (`docs/adr/0016-agent-user.md`, Step 4).

**Watch.** `host/bin/ug-watch` runs every 5 minutes as the owner from the service table: it reads each job's record, asks the login services and the agent sshd, rechecks after 60 s, writes the status (`status`, `host/bin/ug-watch`), and pings the outside check whose address the owner writes by hand. The outside check alerts the owner on a failure and when no ping arrives within its period, so a dead mac or a dead watch cannot stay silent. The launcher prints the written status at each start, so the owner sees the problems before the first answer (`docs/adr/0023-failures-reach-the-owner.md`).

## Onboarding checks

The owner checks each repo on GitHub before agents merge alone in it.

1. No Actions secrets and no credential variables for `pull_request` jobs. No `id-token: write`.
2. The default `GITHUB_TOKEN` is read-only.
3. GitHub-hosted runners only.
4. The gh-broker app is a GitHub App of the owner's account, installed on selected repos, with no Workflows and no Administration permission (`docs/adr/0007-gh-broker-github-app.md`).
5. Each workflow that deploys, publishes, or uses secrets on `main` waits for the owner's approval in a GitHub environment. So a merge has no effect that a revert cannot undo.
6. A repo whose code runs on the host, such as underground, gets no auto merge. The owner merges each PR and reads the merged change before the host runs it. GitHub enforces this: a ruleset on `main` needs the owner's approval as code owner for every merge, and setup stops before it pulls when that ruleset is missing or weaker (`ug_check_main_rule`, `host/lib/ug.bash`; `docs/adr/0021-github-holds-the-wall-on-main.md`). Setup runs no test file as the owner, so test code that the agent writes runs only on GitHub's runners (owner decision, 2026-11-10). The ruleset also needs approval of the most recent push from someone other than its pusher, and GitHub counts only a push that changes the PR's diff. So after the owner pushes to an agent PR, the agent pushes a change before the owner can approve it ([GitHub Docs, "Available rules for rulesets"](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), read 2026-11-10; the "reviewable push" reading is [inference] from PR 167).

A repo is onboarded when the owner has made these checks and installed the gh-broker app on it: the app's installation is the list (owner decision, 2026-11-03).

Live run before trust: in a throwaway repo that passes the checks, one task from branch to merge, one revert, and one PR with a planted defect that `security-review` must block.

## Checks that run

**CI.** `.github/workflows/ci.yml` runs on each PR head and each push to `main`. The `checks` job runs on Linux: bash and sh syntax, shellcheck, and `xmllint` on the plist templates. The `tests` job runs on macOS, where the code runs: the broker tests and the host tests, and it fails when a `[mac]` test skips, because a skip checks nothing (owner decision, 2026-11-10). The suite uses fake data only: temp homes, local bare repos in place of GitHub, and a fake `gh`. The host tests include the doc citation check (`scripts/check-doc-citations.mjs`, run by `tests/host/doc-citations.test.ts`) and the fixed-identity check (`scripts/check-repo-references.mjs`, run by `tests/host/repo-references.test.ts`).

**Setup.** Before it changes anything: the ruleset check (`ug_check_main_rule`), a hash match for each download, and `pfctl -n` on the rendered firewall file. Before it loads a job from the service table: root or the job's own user must own each program, folder, and `PATH` entry it names, and none may be writable by another user (`ug_trusted_daemon`, `host/lib/ug.bash`). Before it ends: the pf anchor holds the firewall line (`ug_pf_refuses_listener`), and the walls hold from the owner's account (`check_walls`). A render stops on a placeholder nothing fills (`ug_render`, `host/lib/ug.bash`).

**Watch.** The status above: every 5 minutes on the mac, and outside it through the ping check that alerts when the pings stop (`docs/adr/0023-failures-reach-the-owner.md`).

## Deferred

- The gh-broker, the merge gate, auto merge, and a merge queue: open, in redesign.
- A test of a program that talks to launchd directly, without the `launchctl` path the pin refuses (`docs/adr/0016-agent-user.md`, Open; `docs/adr/0021-github-holds-the-wall-on-main.md`, amendment 2026-11-10, item 3).
- Per-repo network allowlists, with the data-out question (`docs/THREAT-MODEL.md`, U14).
- A check that the owner has set a spend cap at each provider (`docs/adr/0021-github-holds-the-wall-on-main.md`, amendment 2026-11-10, item 4).
- The notice at session start for kept branches (`docs/adr/0020-state-based-branch-cleanup.md`, decision 4).
- A feature request: `/usage` through the auth gateway, so the usage broker can go.
- The MVPF rows of `docs/THREAT-MODEL.md`.
