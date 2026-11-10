# underground

A safe environment for the omp coding agent on one macOS laptop: the owner designs with it, and it implements ready tickets on its own, up to the merge. The design is in `docs/PRODUCT-BRIEF.md`. Where a term names a place that a build item in `docs/SPEC.md` moves, the term gives the new place and the build id. The architecture is being redesigned (`AGENTS.md`, "Redesign phase"). Terms marked (removed, #90) named parts of the srt design, which commit 54a418a1 removed on 2026-11-07. Terms marked (removed) named the box, which step 4 of `docs/adr/0016-agent-user.md` removed on 2026-11-08. Sessions run as the agent user (`docs/adr/0016-agent-user.md`).

## Language

### Places

**Sandbox** (removed, #90):
The single boundary that srt drew around the omp process. Commit 54a418a1 removed it; the box replaced it (`Box`, removed in step 4 of `docs/adr/0016-agent-user.md`).
_Avoid_: jail, container, lock

**Host**:
The owner's macOS user session, apart from the agent user. Only the owner runs commands on the host.
_Avoid_: outside, plain terminal (as a place)

**Arena** (removed, #90):
The agent's one home under the srt design, `~/.ug/home`. Commit 54a418a1 removed it. The box's home was the volume `ug-box-home`, mounted as `/home/agent` (`host/bin/ug-box`, removed in step 4 of `docs/adr/0016-agent-user.md`).
_Avoid_: workspace, sandbox dir, role home, write area

**Agent home omp binary**:
The one omp binary on the mac, `/Library/Underground/omp/<pin>/omp`, `root:ugomp`, mode 550, so only the agent user and the login user can run it, with its pinned SHA-256 in `omp.sha256` beside it. Setup downloads it as the owner and `ug-agent-setup` installs it as root. It serves the agent sessions, which check its hash at each start (`host/agent/agent-start`), and the login services (`docs/adr/0018-login-user.md`).
_Avoid_: omp copy, owner zone

**omp launcher**:
`host/bin/ug-agent`, linked as `~/.local/bin/omp`: typing `omp` logs in as the agent user and starts the agent home omp binary there. It is not omp.
_Avoid_: wrapper, ug-agent command

**Agent user**:
The macOS user `ugagent`, standard and hidden, that runs omp for the sessions after the box is removed. Its home `/Users/ugagent` is its own, and its login is an sshd of its own on `127.0.0.1:2222` (`docs/adr/0016-agent-user.md`, `host/bin/ug-agent-setup`).
_Avoid_: agent account, bot user

**Data folder**:
The folder `~/.local/share/underground`, mode 700: the gh-broker app's key and config, the gh-broker's records, the protected-paths lists, the backup settings and password, the agent's ssh key, the addresses file, `config-repo`, the pinned restic, and setup's copy of the service code. Setup moved it there from `~/.ug/host` on 2026-11-08 (`docs/adr/0017-one-omp-binary-and-no-ug-folder.md`). The model logins are not here; they are the login user's.
_Avoid_: host zone, vault, keys dir

**Login user**:
The hidden macOS user `ugauth`, which owns the model logins, `auth-broker.token`, and `auth-gateway.token` in its home `/Users/ugauth` (mode 700), and runs the auth broker, the auth gateway, and the usage broker as LaunchDaemons. The owner's user cannot read its home (`docs/adr/0018-login-user.md`).
_Avoid_: auth root, host zone, ug-auth profile

**Owner's zone**:
The owner's home outside the data folder: the owner's checkouts, the config repo, `~/.ssh`, `~/Library`, and the rest. The agent user and the login user cannot read the owner's home (mode 700).
_Avoid_: host files, user space

**Owner's checkout**:
The owner's own Git checkout of a repo, in the owner's zone. Setup runs from underground's checkout and copies the code that the services need into the data folder (`install_service_code`, `host/bin/ug-setup`).
_Avoid_: repo folder, main checkout, primary checkout

**Arena clone** (removed, #90):
The agent's clone of one repo in the removed arena, `~/.ug/home/work/<owner>/<repo>` (commit 54a418a1). The agent user clones the repo into `/Users/ugagent/work/<owner>/<repo>` (`host/agent/agent-start:62`).
_Avoid_: task clone, copy, mirror

**Agent worktree**:
A Git worktree that a session makes for itself from its clone, on its own `wt/<timestamp>` branch, under omp's default worktree folder `~/.omp/wt` [inference] in the agent user's home `/Users/ugagent` (`AGENTS.md`, "Work a change"). Everything in it is agent-written. Other sessions can write it too.
_Avoid_: ticket worktree, workspace

**Omp root**:
omp's default root, `~/.omp`. For the agent user it is `/Users/ugagent/.omp`, and `host/agent/agent-start:36-47` copies the config names from `/Library/Underground/config` into `~/.omp/agent` at each start. omp runs on it unchanged, on its default profile.
_Avoid_: role home, profile, owner part

**Config repo**:
The owner's private repo of agent configs, `~/Developer/Projects/agent-config` (moved from `~/Developer/agent-config`, owner in chat, 2026-11-08), in the owner's zone, named in `~/.local/share/underground/config-repo`: `AGENTS.md`, skills, hooks, `config.yml`, `models.yml` with the gateway markers, and other settings, laid out like omp's `~/.omp/agent`. It holds what the agent does inside the walls; underground holds the walls. It holds no secret: `ug-agent-setup` refuses to stage a link, a special file, or a token in it (`vet_item`, `host/bin/ug-agent-setup:196-203`). The owner's local folder is the source of truth; GitHub keeps a private backup. The pointer `~/.local/share/underground/config-repo` is hand-written (`host/bin/ug-agent-setup:207`). Setup copies the config repo's last commit into `/Library/Underground/config` (`stage_config`, `host/bin/ug-agent-setup:205-274`). A commit reaches sessions only after `host/bin/ug-setup` runs. Each start copies it into the agent user's `~/.omp/agent` (`host/agent/agent-start:36-47`), so a change that the agent makes to its config lasts until the next start.
_Avoid_: dotfiles, role config

**Skill repo**:
An owner's repo of skills kept apart from the config repo, named one path per line in the config repo's `skill-repos` file, at its last commit. Setup takes only paths inside the owner's home, after it resolves links. Like the config repo, setup reads its last commit, keeps each folder with a `SKILL.md` at its top or under `skills/`, refuses a link, a special file, or a token in it, and adds those folders to the config's `skills/`. A name that the config repo or an earlier skill repo already has stops setup (`stage_config`, `host/bin/ug-agent-setup:205-274`). The list chooses which of the owner's repos root setup reads, so the owner reviews any PR on the config repo that changes it.
_Avoid_: skill pack, plugin

**Box** (removed, 2026-11-08):
The agent's own machine as built on 2026-11-07: one long-running Apple `container` VM with no network. Step 4 of `docs/adr/0016-agent-user.md` removed it; the agent runs as its own macOS user now. The term stays for the history.
_Avoid_: sandbox, arena, VM per session

**Door** (removed, 2026-11-08):
A unix socket that the host owned and mounted into the box: the egress door and the gh-broker door. The box is removed; the gh-broker socket is `/Library/Underground/run/gh-broker.sock` (`host/gh-broker/server.ts:73`) (`docs/adr/0013-agent-box.md`).
_Avoid_: hole, port, tunnel

**Egress guard** (removed, 2026-11-08):
srt's HTTP proxy on the host, behind the egress door. The box, its door, and the srt pin are removed (`docs/adr/0016-agent-user.md`, step 4).
_Avoid_: firewall, filter, MITM proxy

**Rebuild** (removed, 2026-11-08):
A fresh home in the box from the pinned image and the config. The box is removed; restoring the home is in `docs/adr/0016-agent-user.md`, Step 4.
_Avoid_: reset, wipe, reinstall

### Running omp

**Wrapper** (removed, #90):
The `omp` command of the srt design, which commit 54a418a1 removed. The agent's `omp` is now `~/.local/bin/omp`, a link to `ug-agent` in `~/.local/share/underground/agent/bin/ug-agent` (`host/bin/ug-agent-setup:353`).
_Avoid_: launcher, omp-srt

**Clean environment** (removed, #90):
The environment that the removed wrapper gave omp: only the variables that it named (commit 54a418a1). No variable of the owner's shell reached the sandbox.
_Avoid_: env filter, scrubbed env

**Pin**:
A version and a SHA-256 in `VERSIONS`. The omp pin names the release file `omp-darwin-arm64` from GitHub; setup downloads it, checks the hash, and keeps its own copy in the owner zone (`docs/adr/0012-pinned-omp-and-setup.md`).
_Avoid_: lock, current version

**Vanilla omp**:
An omp that the owner starts as the owner, outside any session. The owner cannot run the agent home omp binary, so only a copy the owner downloads or Tern's can start. It finds no login and no gateway bearer, because both belong to other users. It still finds the keyless built-in providers (`apple`, and a local `lm-studio`, `ollama`, or `llama.cpp` server), unless `~/.omp/agent/config.yml` turns them off (`docs/adr/0018-login-user.md`, "Not covered").
_Avoid_: raw omp, plain omp, unwrapped session

**ug-auth**:
The owner's command for the auth services: it runs the agent home omp binary as the login user through `sudo`, limited to `auth-broker` and `auth-gateway`, for example `ug-auth auth-broker login anthropic`. `ug-auth key ANTHROPIC_API_KEY` stores an API key: the login user's shell reads it hidden from the terminal and hands it to `omp auth-broker migrate --from-local --include-env` in its environment, so the key is in no argument, file, or shell history. `ug-auth list` shows each active credential of the auth broker with its id, provider, type, and account, with an API key cut to its first and last characters. `ug-auth revoke <id>` turns off that one credential (`docs/adr/0005-model-auth-gateway.md`, amendment 2026-11-09). Each run asks for the owner's password. Setup links it as `~/.local/bin/ug-auth`.
_Avoid_: vanilla omp, admin omp

**Agent home backup** (was the arena backup):
The daily restic snapshot of the agent home `/Users/ugagent`, minus `.cache` and `node_modules`, in one repo on the owner's other machine (launchd `com.underground.backup`, `host/bin/ug-backup`, settings in `~/.local/share/underground/backup/config`). The tar stream is read through the root helper `/Library/Underground/bin/agent-home-tar` (`host/agent/agent-home-tar`). It keeps every snapshot, so harm to the home can be undone (`docs/SPEC.md`, B10).
_Avoid_: archive, sync, Time Machine

**Setup**:
The host script that does what `git pull` cannot: download the pinned omp and restic, make the data folder and the backup password, run `sudo host/bin/ug-agent-setup` (which asks for the owner's password and installs the agent home omp binary, the agent user, the login user and its services, the omp launcher, and the backup helper), restart the gh-broker and the backup, and check as the owner that the owner cannot run omp or read a login or the bearer. It first fast-forwards `main` in its own checkout from `origin`, then runs the `[mac]` tests. It runs when underground's `main`, a pin, a host service, or macOS changes. It replaces the install (`docs/adr/0012-pinned-omp-and-setup.md`).
_Avoid_: install, installer, bootstrap

**Preflight** (removed, #90):
The macOS build check of the removed wrapper: at each start, the build must be the one that setup recorded (commit 54a418a1). Setup removed the leftover `~/.ug/sys/macos-build` in a one-time step, which is gone since the owner's mac ran it (owner, 2026-11-08).
_Avoid_: health check, doctor, self-test

**Crossing**:
A way into or out of the agent's sessions: code out, model calls, `/usage`, web out, config in, repos in, unix sockets, localhost, and merge effects. Each crossing has one control (`docs/PRODUCT-BRIEF.md`, principle 4).
_Avoid_: hole, exception, bypass

**Network allowlist** (removed):
The list of network sites that sessions could reach, in `host/network-allowlist`. The file is gone (removed in step 4, `docs/adr/0016-agent-user.md:75`), and there is no network wall now, by owner decision (`docs/THREAT-MODEL.md:37`).
_Avoid_: domain list, egress list

### GitHub and the merge

**gh-broker**:
The host service that does GitHub operations for the sessions (launchd `com.underground.gh-broker`). It holds the only GitHub credential that agents use. One socket, `/Library/Underground/run/gh-broker.sock` (`host/gh-broker/server.ts:73`), serves every session, and the agent user reaches it through `/Library/Underground/bin/gh-broker`. The gh-broker has no roles and no list of repos: it serves each repo where the gh-broker app is installed (`docs/SPEC.md`, B7).
_Avoid_: broker (alone), agent-gh, proxy

**Reviewer role**:
One of `code-review`, `security-review`, and `risk-review`. A reviewer is a skill from the config repo, not a separate session: any omp session can run it, with the same home and trust level as every other session. It reads the PR with `gh-broker sync <owner/repo> --pr <n>`, which fetches the head into the repo of the current folder, and writes its verdict with `gh-broker review`, which names the role. It is a quality step, not a safety wall (`docs/adr/0011-one-agent-arena.md`).
_Avoid_: reviewer session, review agent, bug bot, security bot

**Review verdict**:
A record that a reviewer writes with `gh-broker review <owner/repo> <n> <sha> <role> <verdict> [reason]` for one PR and one full head sha: `pass`, `manual`, or `block`, with a reason for `manual` and `block`, and the reviewer role. The gh-broker refuses a verdict that the role cannot give. `code-review` and `security-review` give `pass` or `block`; `risk-review` gives `pass` (auto) or `manual`. The gh-broker appends each verdict as one line to the file of its PR in `~/.local/share/underground/gh-broker/reviews` and keeps the file after the merge. A verdict from before reviewer roles has role `null`: its `block` and `manual` count, and its `pass` counts for no role. A record written before 2026-11-03 also holds `role_name`, the name from the old role table; the gh-broker reads it and drops it.
_Avoid_: reviewer result, finding, approval

**Attempt**:
One head of a PR with a `block` from any reviewer role. Two roles that block one head are one attempt. A head with no `block` is not an attempt.
_Avoid_: round, try

**Hold**:
A state of a PR that makes `gh-broker merge` refuse with a reason that says the owner merges this PR on GitHub. A `manual` on any head makes a hold, and so does each blocked head from the fourth attempt on; it holds every later head. A changed protected path on the head also makes a hold. Nothing in the gh-broker ends a hold: the owner merges the PR on GitHub by hand.
_Avoid_: lock, freeze

**Protected path**:
A path that the auto merge never accepts: `.github/**`, every `CODEOWNERS` file, and each glob in the owner's protected-paths list of the repo, `~/.local/share/underground/protected-paths/<owner>/<repo>`. A rename counts its old path and its new path.
_Avoid_: manual path, sensitive path

**Auto merge**:
The only merge that `gh-broker merge` does: green checks, a head that is the push record of its branch, no hold, no `block` on the head, and a latest verdict of `pass` on the head from each of `code-review`, `security-review`, and `risk-review`. The owner's approval plays no part. Every other PR is merged by the owner on GitHub. A repo whose code runs on the host, such as underground, gets no auto merge (onboarding check 6, `docs/SPEC.md`).
_Avoid_: auto tier, bot merge, owner-approved merge

**Push record**:
The commit that the gh-broker last pushed to one branch of one repo. A later push replaces it. The gh-broker keeps it in `~/.local/share/underground/gh-broker/pushes`, with the `/` in the branch name written as `%2F`.
_Avoid_: push log, provenance record

**gh-broker app**:
The GitHub App that the gh-broker acts as. The owner's personal account owns it, and it is installed only on the selected repos, with Contents and Pull requests read and write, Metadata, Checks, and Commit statuses read, and no Workflows or Administration permission. Its private key is `~/.local/share/underground/github-app.pem`, mode 600, beside `github-app.json` (`docs/SPEC.md`, B7). GitHub shows the gh-broker's actions as `<app slug>[bot]` (`docs/adr/0007-gh-broker-github-app.md`).
_Avoid_: bot account, bot token, gh-broker token, machine user, service account

**Installation token**:
A token of the gh-broker app for one repo, which the gh-broker gets with the app's private key. It lasts one hour, and only the gh-broker holds it, in memory.
_Avoid_: app token, gh-broker token, PAT

**Onboarding checks**:
The six checks in `docs/SPEC.md` that the owner makes on GitHub for each repo before agents merge alone in it. A repo is onboarded when the owner has made them and installed the gh-broker app on it: the app's installation is the list.
_Avoid_: onboarding list, repo setup

### Models

**Auth broker**:
The host service `omp auth-broker serve` (LaunchDaemon `com.underground.auth-broker`, run as the login user, on `127.0.0.1:8765`). It holds the owner's model logins in the login user's home, and does every OAuth refresh. The owner reaches it with `ug-auth`. Only the auth gateway talks to it; no session is a broker client, because a broker client receives access tokens and API keys.
_Avoid_: credential store, vault

**Auth gateway**:
The host service `omp auth-gateway serve` (launchd `com.underground.auth-gateway`) on the tailscale address of this mac, the `gateway=` line of the addresses file. It makes model calls for the sessions with the logins of the auth broker. Every call needs the gateway bearer.
_Avoid_: model proxy, LLM proxy

**Usage broker**:
The host service `host/gh-broker/usage-broker.ts` (launchd `com.underground.usage-broker`). It speaks omp's broker protocol with no credentials and passes `/v1/usage` to the auth gateway, so omp's native `/usage` works. It listens on `127.0.0.1:18765` and stays there, because localhost stays on for omp's own features (`docs/SPEC.md`, B5 and B6).
_Avoid_: usage proxy, fake broker

**Gateway bearer**:
The shared token that lets a session use the auth gateway. It authorizes every session for all models and accounts served by the gateway, usage, and credential health. It does not expose provider secrets or credential management. It is not in the box, which is removed (`docs/adr/0016-agent-user.md`). The agent user reads it from `/Library/Underground/config`, an accepted cost (U30, `docs/adr/0005-model-auth-gateway.md`). The separate auth-broker bearer stays on the host.
_Avoid_: client token, API key, gateway key

**Gateway provider**:
A provider in a session's `models.yml`, with `transport: pi-native`, `baseUrl` the auth gateway, and `apiKey` the gateway bearer. Setup fills `@GATEWAY@` and `@GATEWAY_TOKEN@` into the staged `models.yml` (`host/bin/ug-agent-setup:263`). Each model setting of a session names a model of a gateway provider.
_Avoid_: proxy provider

**Inference engine**:
The model server on another box on the tailnet, at the `engine=` line of the addresses file. It needs an API key, which the auth broker holds under omp's built-in `lm-studio` provider. Sessions reach it only through the auth gateway (`docs/adr/0005-model-auth-gateway.md`, amendment 2026-11-01).
_Avoid_: local model, llama

**Addresses file**:
The owner-only file with two lines: `gateway=<ip>:<port>`, the auth gateway on the tailscale address of this mac, and `engine=<ip>:<port>`, the inference engine. Setup writes it only when it is missing: the gateway from the first line of `tailscale ip -4` with port `4000`, and the engine from the owner's answer at a prompt. Without a terminal, setup stops and writes nothing (`write_addresses`, `host/bin/ug-setup`). The owner edits it later. It is `~/.local/share/underground/addresses`.
_Avoid_: address config, hosts file

### Decisions

**Agent-written**:
Describes any file, branch, or setting that the agent could change: everything in its home, `/Users/ugagent`. Treat it as untrusted until the owner reviews it on GitHub.
_Avoid_: local work, dirty

**One trust level**:
Every role shares the agent user's home and can change what another role loads. The reviewers improve quality; they are not a safety wall. The onboarding checks keep a merge reversible instead (`docs/adr/0011-one-agent-arena.md`).
_Avoid_: role isolation, shared trust

**Accepted risk**:
A threat that we do not control, with the reason written in an ADR in `docs/adr/`.
_Avoid_: known issue, wontfix

**North star**:
The one direction that every decision follows, in `AGENTS.md` and `docs/PRODUCT-BRIEF.md`: the agent works like a coworker. The owner and the agent do the design together; the agent turns each ready ticket into a merged change on its own. Whatever the agent does without the owner's approval, in either way of working, the owner can undo.
_Avoid_: vision, goal, mission

**Ready ticket**:
A user story or ticket that the specs and ADRs have broken down into the smallest unit of work, with no design decision left in it. Only a ready ticket goes to the agent to do on its own (`docs/PRODUCT-BRIEF.md`, "Two ways of working").
_Avoid_: task, job, issue

**Gate**:
The question before each decision: does this bring us closer to the north star, or further away? Yes only if it stops an irreversible harm, or keeps undo and work possible.
_Avoid_: review, approval

**MVPF**:
The future underground MVP after 0.5. A threat marked MVPF has no control in 0.5.
_Avoid_: later, backlog, v1

## Retired terms

These terms name parts of the first design. The ADRs from before 2026-11-02 use them.

- **Repo folder**: now the owner's checkout. The agent no longer works in it.
- **Repo id**, **worktree folder**, **session folder**, **cache root**: omp's default paths in the arena (removed, #90) replaced them.
- **Write area**: was the arena, removed in #90.
- **Owner part**, **role policy**: omp runs unchanged on its default root, with no pins (`docs/adr/0002-role-homes.md`, superseded).
- **Role rules**: now a skill in the config repo.
- **Reviewer store**: reviewers read the PR in the arena clone (removed, #90).
- **Install record**: setup replaces the install, and `git status` shows a changed file (`docs/adr/0012-pinned-omp-and-setup.md`).
- **Session container**, **state layer**: one home in the box (removed 2026-11-08), with no container per session (`docs/adr/0015-box-layout.md`).
