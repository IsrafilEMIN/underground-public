# underground

A safe environment for the omp coding agent on one macOS laptop: the owner designs with it, and it implements ready tickets on its own, up to the merge. The design is in `docs/PRODUCT-BRIEF.md`. Where a term names a place that a build item in `docs/SPEC.md` moves, the term gives the new place and the build id. The architecture is being redesigned (`AGENTS.md`, "Redesign phase"). Terms marked (removed, #90) named the srt design, which commit 54a418a1 removed on 2026-11-07. Terms marked (removed) named the box, which step 4 of `docs/adr/0016-agent-user.md` removed on 2026-11-08. Sessions run as the agent user (`docs/adr/0016-agent-user.md`).

## Language

### Places

**Sandbox** (removed, #90):
The single boundary that srt drew around the omp process. Commit 54a418a1 removed it; the box replaces it (`Box`).
_Avoid_: jail, container, lock

**Host**:
The owner's macOS user session outside the sandbox. Only the owner runs commands on the host.
_Avoid_: outside, plain terminal (as a place)

**Arena** (removed, #90):
The agent's one home under the srt design, `~/.ug/home`. Commit 54a418a1 removed it. The box's home is the volume `ug-box-home`, mounted as `/home/agent` (`host/bin/ug-box`).
_Avoid_: workspace, sandbox dir, role home, write area

**Owner zone**:
The folder `~/.ug/sys`: the pinned omp binary, the pinned restic, and `bin/omp`, the link to `ug-agent` (`host/bin/ug-agent-setup`). `bin/` is on `PATH`. Only setup writes it.
_Avoid_: install dir, owner part

**Sockets folder**:
The folder `~/.ug/run`: the egress socket `egress.sock` (`host/bin/ug-box:16-17`). The box can use only the two sockets it is given, and cannot write the folder, so it cannot plant a socket or a link here. The broker socket is not here; it is in `/Library/Underground/run`.
_Avoid_: run dir, socket dir

**Agent user**:
The macOS user `ugagent`, standard and hidden, that runs omp for the sessions after the box is removed. Its home `/Users/ugagent` is its own, and its login is an sshd of its own on `127.0.0.1:2222` (`docs/adr/0016-agent-user.md`, `host/bin/ug-agent-setup`).
_Avoid_: agent account, bot user

**Host zone**:
The folder `~/.ug/host`: everything the sandbox gets nothing of. The broker app's private key, the auth broker's own root with the model logins, the broker's records, and the owner's hand-edited broker files, such as the addresses file (owner decision, 2026-11-03). Setup moved them there from `~/.agents/broker`, `~/.config/underground-broker`, and `~/.omp` (`docs/SPEC.md`, B6 and B7).
_Avoid_: vault, keys dir

**Owner's zone**:
Everything outside `~/.ug`: the owner's checkouts, the config repo, `~/.ssh`, `~/Library`, and the rest of the home. The sandbox gets nothing here.
_Avoid_: host files, user space

**Owner's checkout**:
The owner's own Git checkout of a repo, in the owner's zone. The box never mounts it. Setup runs from underground's checkout and copies the code that the services and the box need into `~/.ug/sys` (`install_ug_box`, `install_service_code`, `host/bin/ug-setup:199-225`).
_Avoid_: repo folder, main checkout, primary checkout

**Arena clone** (removed, #90):
The agent's clone of one repo in the removed arena, `~/.ug/home/work/<owner>/<repo>` (commit 54a418a1). In the box, `box/ug-session` clones the repo into `~/work/<owner>/<repo>` (`clone=$HOME/work/$UG_REPO`, `box/ug-session:11`).
_Avoid_: task clone, copy, mirror

**Agent worktree**:
A Git worktree that a session makes for itself from its clone, on its own `wt/<timestamp>` branch, under omp's default worktree folder `~/.omp/wt` in the box home (`AGENTS.md`, "Work a change"; this session's cwd, `/home/agent/.omp/wt/wt-20261107-214617-1388904`, 2026-11-07). Everything in it is agent-written. Other sessions can write it too.
_Avoid_: ticket worktree, workspace

**Omp root**:
omp's default root, `~/.omp`. In the box it sits in the home volume at `/home/agent/.omp`, and `box/ug-config` swaps the config names into `~/.omp/agent` at each start (`host/bin/ug-box`, `box/ug-config`). omp runs on it unchanged, on its default profile.
_Avoid_: role home, profile, owner part

**Config repo**:
The owner's private repo of agent configs, `~/Developer/agent-config`, in the owner's zone, named in `~/.ug/host/config-repo`: `AGENTS.md`, skills, hooks, `config.yml`, `models.yml` with the gateway markers, and other settings, laid out like omp's `~/.omp/agent`. It holds what the agent does inside the walls; underground holds the walls, such as the network allowlist. It holds no secret: `ug-box` refuses to start on a link, a special file, or a token in it (`host/bin/ug-box`, `box_config`). The owner's local folder is the source of truth; GitHub keeps a private backup. `ug-box` takes its last commit at each start, and `box/ug-config` swaps its names into the box's `~/.omp/agent`, so a change that the agent makes to its config lasts until the next start (`docs/SPEC.md`, B3).
_Avoid_: dotfiles, role config

**Box** (removed, 2026-11-08):
The agent's own machine as built on 2026-11-07: one long-running Apple `container` VM with no network. Step 4 of `docs/adr/0016-agent-user.md` removed it; the agent runs as its own macOS user now. The term stays for the history.
_Avoid_: sandbox, arena, VM per session

**Door** (removed, 2026-11-08):
A unix socket that the host owned and mounted into the box: the egress door and the broker door. The box is removed; the broker socket is `/Library/Underground/run/broker.sock` (`host/broker/server.ts:73`) (`docs/adr/0013-agent-box.md`).
_Avoid_: hole, port, tunnel

**Egress guard** (removed, 2026-11-08):
srt's HTTP proxy on the host, behind the egress door. The box, its door, and the srt pin are removed (`docs/adr/0016-agent-user.md`, step 4).
_Avoid_: firewall, filter, MITM proxy

**Rebuild** (removed, 2026-11-08):
A fresh home in the box from the pinned image and the config. The box is removed; restoring the home is in `docs/adr/0016-agent-user.md`, Step 4.
_Avoid_: reset, wipe, reinstall

### Running omp

**Wrapper** (removed, #90):
The `omp` command of the srt design, which commit 54a418a1 removed. `ug-box` is now the `omp` on `PATH` (`host/bin/ug-setup:185`).
_Avoid_: launcher, omp-srt

**Clean environment** (removed, #90):
The environment that the removed wrapper gave omp: only the variables that it named (commit 54a418a1). No variable of the owner's shell reached the sandbox.
_Avoid_: env filter, scrubbed env

**Pin**:
A version and a SHA-256 in `VERSIONS`. The omp pin names the release file `omp-darwin-arm64` from GitHub; setup downloads it, checks the hash, and keeps its own copy in the owner zone (`docs/adr/0012-pinned-omp-and-setup.md`).
_Avoid_: lock, current version

**Raw omp**:
The pinned omp binary started by its full path, outside the box. Its home `~/.omp` holds no login and no token. Setup writes its `~/.omp/agent/config.yml` from the config repo's `raw-omp/config.yml`, whose `disabledProviders` line turns off the keyless built-in providers (`install_raw_config`, `host/bin/ug-setup:227-239`). The removed wrapper also rewrote that file at each start (commit 54a418a1). Its logins sit in `~/.ug/host/auth`, not in `~/.omp`. So it cannot call a model. The removed probe asked it for every model that it could call (`scripts/probe-arena.sh`, commit 54a418a1); nothing runs that check now.
_Avoid_: plain omp, unwrapped session

**ug-auth**:
The owner's command for the auth services: the pinned omp with its root in `~/.ug/host/auth`, limited to `auth-broker` and `auth-gateway`, for example `ug-auth auth-broker login anthropic` or `ug-auth auth-broker token --regenerate`. Setup links it as `~/.ug/sys/bin/ug-auth`.
_Avoid_: raw omp, admin omp

**Arena backup** (now the agent home backup):
The daily restic snapshot of the agent home `/Users/ugagent`, minus `.cache` and `node_modules`, in one repo on the owner's other machine (launchd `com.underground.backup`, `host/bin/ug-backup`, settings in `~/.ug/host/backup/config`). The tar stream is read through the root helper `/Library/Underground/bin/agent-home-tar` (`host/agent/agent-home-tar`). It keeps every snapshot, so harm to the home can be undone (`docs/SPEC.md`, B10).
_Avoid_: archive, sync, Time Machine

**Setup**:
The host script that does what `git pull` cannot: install the pinned omp and restic, make the zones and their modes, make the backup password, register and restart the launchd services, and write the raw omp's config. The agent user's omp link and backup helper are installed by `host/bin/ug-agent-setup`, run with sudo. It runs the `[mac]` tests first (`host/bin/ug-setup:82-86`). It runs when a pin changes, a host service changes, or macOS updates. It replaces the install (`docs/adr/0012-pinned-omp-and-setup.md`).
_Avoid_: install, installer, bootstrap

**Preflight** (removed, #90):
The macOS build check of the removed wrapper: at each start, the build must be the one that setup recorded (commit 54a418a1). Setup removed the leftover `~/.ug/sys/macos-build` in a one-time step, which is gone since the owner's mac ran it (owner, 2026-11-08).
_Avoid_: health check, doctor, self-test

**Crossing**:
A way into or out of the box: code out, model calls, `/usage`, web out, config in, repos in, unix sockets, localhost, and merge effects. Each crossing has one control (`docs/PRODUCT-BRIEF.md`, principle 4).
_Avoid_: hole, exception, bypass

**Network allowlist**:
The network destinations of every session, one per line in `host/network-allowlist` in the owner's checkout of underground. Setup copies the file to `~/.ug/sys/egress` (`install_egress`, `host/bin/ug-setup:193`), and the egress door allows a site by its name on 443 and the `.internal` names on their ports (`host/egress/rules.ts`). A tailscale entry names the address and the port of one service, never the bare address. The template names the auth gateway as `@GATEWAY@`; the egress door maps the name `gateway.internal` to the gateway's port (`host/egress/rules.ts:15-17`). Its entries: the auth gateway, `github.com`, the web search domains, and `registry.npmjs.org`.
_Avoid_: domain list, egress list

### GitHub and the merge

**Broker**:
The host service that does GitHub operations for the sessions (launchd `com.underground.broker`). It holds the only GitHub credential that agents use. One socket, `/Library/Underground/run/broker.sock` (`host/broker/server.ts:73`), serves every session; the box reaches it at `/tmp/ug-broker.sock` (`box/broker`, `host/bin/ug-box:17`), and the agent user reaches it through `/Library/Underground/bin/broker`. The broker has no roles and no list of repos: it serves each repo where the broker app is installed (`docs/SPEC.md`, B7).
_Avoid_: gh-broker, agent-gh, proxy

**Reviewer role**:
One of `code-review`, `security-review`, and `risk-review`. A reviewer is a skill from the config repo, not a separate session: any omp session can run it, with the arena and the trust level of every other session. It reads the PR with `broker sync <owner/repo> --pr <n>`, which fetches the head into the repo of the current folder, and writes its verdict with `broker review`, which names the role. It is a quality step, not a safety wall (`docs/adr/0011-one-agent-arena.md`).
_Avoid_: reviewer session, review agent, bug bot, security bot

**Review verdict**:
A record that a reviewer writes with `broker review <owner/repo> <n> <sha> <role> <verdict> [reason]` for one PR and one full head sha: `pass`, `manual`, or `block`, with a reason for `manual` and `block`, and the reviewer role. The broker refuses a verdict that the role cannot give. `code-review` and `security-review` give `pass` or `block`; `risk-review` gives `pass` (auto) or `manual`. The broker appends each verdict as one line to the file of its PR in `~/.ug/host/broker/reviews` and keeps the file after the merge. A verdict from before reviewer roles has role `null`: its `block` and `manual` count, and its `pass` counts for no role. A record written before 2026-11-03 also holds `role_name`, the name from the old role table; the broker reads it and drops it.
_Avoid_: reviewer result, finding, approval

**Attempt**:
One head of a PR with a `block` from any reviewer role. Two roles that block one head are one attempt. A head with no `block` is not an attempt.
_Avoid_: round, try

**Hold**:
A state of a PR that makes `broker merge` refuse with a reason that says the owner merges this PR on GitHub. A `manual` on any head makes a hold, and so does each blocked head from the fourth attempt on; it holds every later head. A changed protected path on the head also makes a hold. Nothing in the broker ends a hold: the owner merges the PR on GitHub by hand.
_Avoid_: lock, freeze

**Protected path**:
A path that the auto merge never accepts: `.github/**`, every `CODEOWNERS` file, and each glob in the owner's protected-paths list of the repo, `~/.ug/host/protected-paths/<owner>/<repo>`. A rename counts its old path and its new path.
_Avoid_: manual path, sensitive path

**Auto merge**:
The only merge that `broker merge` does: green checks, a head that is the push record of its branch, no hold, no `block` on the head, and a latest verdict of `pass` on the head from each of `code-review`, `security-review`, and `risk-review`. The owner's approval plays no part. Every other PR is merged by the owner on GitHub. A repo whose code runs on the host, such as underground, gets no auto merge (onboarding check 6, `docs/SPEC.md`).
_Avoid_: auto tier, bot merge, owner-approved merge

**Push record**:
The commit that the broker last pushed to one branch of one repo. A later push replaces it. The broker keeps it in `~/.ug/host/broker/pushes`, with the `/` in the branch name written as `%2F`.
_Avoid_: push log, provenance record

**Broker app**:
The GitHub App that the broker acts as. The owner's personal account owns it, and it is installed only on the selected repos, with Contents and Pull requests read and write, Metadata, Checks, and Commit statuses read, and no Workflows or Administration permission. Its private key is `~/.ug/host/github-app.pem`, mode 600, beside `github-app.json` (`docs/SPEC.md`, B7). GitHub shows the broker's actions as `<app slug>[bot]` (`docs/adr/0007-broker-github-app.md`).
_Avoid_: bot account, bot token, broker token, machine user, service account

**Installation token**:
A token of the broker app for one repo, which the broker gets with the app's private key. It lasts one hour, and only the broker holds it, in memory.
_Avoid_: app token, broker token, PAT

**Onboarding checks**:
The six checks in `docs/SPEC.md` that the owner makes on GitHub for each repo before agents merge alone in it. A repo is onboarded when the owner has made them and installed the broker app on it: the app's installation is the list.
_Avoid_: onboarding list, repo setup

### Models

**Auth broker**:
The host service `omp auth-broker serve` (launchd `com.underground.auth-broker`, on `127.0.0.1:8765`). It holds the owner's model logins in its own root, `~/.ug/host/auth` (`PI_CONFIG_DIR=.ug/host/auth` in its plist), and does every OAuth refresh. The owner reaches it with `ug-auth`. Only the auth gateway talks to it; no session is a broker client, because a broker client receives access tokens and API keys.
_Avoid_: credential store, vault

**Auth gateway**:
The host service `omp auth-gateway serve` (launchd `com.underground.auth-gateway`) on the tailscale address of this mac, the `gateway=` line of the addresses file. It makes model calls for the sandbox with the logins of the auth broker. Every call needs the gateway bearer.
_Avoid_: model proxy, LLM proxy

**Usage broker**:
The host service `host/broker/usage-broker.ts` (launchd `com.underground.usage-broker`). It speaks omp's broker protocol with no credentials and passes `/v1/usage` to the auth gateway, so omp's native `/usage` works. It listens on `127.0.0.1:18765` and stays there, because localhost stays on for omp's own features (`docs/SPEC.md`, B5 and B6).
_Avoid_: usage proxy, fake broker

**Gateway bearer**:
The shared token that lets a session use the auth gateway. It authorizes every session for all models and accounts served by the gateway, usage, and credential health. It does not expose provider secrets or credential management. It is not in the box, which is removed (`docs/adr/0016-agent-user.md`). The agent user reads it from `/Library/Underground/config`, an accepted cost (U30, `docs/adr/0005-model-auth-gateway.md`). The separate auth-broker bearer stays on the host.
_Avoid_: client token, API key, gateway key

**Gateway provider**:
A provider in a session's `models.yml`, with `transport: pi-native`, `baseUrl` the auth gateway, and `apiKey` the gateway bearer. In the box, `ug-box` writes the placeholder `ug-placeholder` as the key (`host/bin/ug-box:84`), and the egress door adds the bearer. Each model setting of a session names a model of a gateway provider.
_Avoid_: proxy provider

**Inference engine**:
The model server on `v100-server`, another box on the tailnet, at the `engine=` line of the addresses file. It needs an API key, which the auth broker holds under omp's built-in `lm-studio` provider. Sessions reach it only through the auth gateway (`docs/adr/0005-model-auth-gateway.md`, amendment 2026-11-01).
_Avoid_: local model, llama

**Addresses file**:
The owner-only file with two lines: `gateway=<ip>:<port>`, the auth gateway on the tailscale address of this mac, and `engine=<ip>:<port>`, the inference engine. Setup writes it only when it is missing, from the first line of `tailscale ip -4` with port `4000`; the owner edits it later. It is `~/.ug/host/addresses`; setup moved it there once from `~/.config/underground-broker/addresses` (`docs/SPEC.md`, B7).
_Avoid_: address config, hosts file

### Decisions

**Agent-written**:
Describes any file, branch, or setting that the agent could change: everything in its home, the box's `ug-box-home` volume. Treat it as untrusted until the owner reviews it on GitHub.
_Avoid_: local work, dirty

**One trust level**:
Every role shares the arena and can change what another role loads. The reviewers improve quality; they are not a safety wall. The onboarding checks keep a merge reversible instead (`docs/adr/0011-one-agent-arena.md`).
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
- **Repo id**, **worktree folder**, **session folder**, **cache root**: omp's default paths in the arena replace them.
- **Write area**: now the arena.
- **Owner part**, **role policy**: omp runs unchanged on its default root, with no pins (`docs/adr/0002-role-homes.md`, superseded).
- **Role rules**: now a skill in the config repo.
- **Reviewer store**: reviewers read the PR in the arena clone.
- **Install record**: setup replaces the install, and `git status` shows a changed file (`docs/adr/0012-pinned-omp-and-setup.md`).
- **Session container**, **state layer**: one home in the box, with no container per session (`docs/adr/0015-box-layout.md`).
