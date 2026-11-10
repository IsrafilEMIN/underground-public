# underground

A safe environment for the omp coding agent on one macOS laptop. The owner designs with the agent. The agent then implements ready tickets on its own, up to the merge. The design is in `docs/PRODUCT-BRIEF.md`. Terms describe what runs today. Where a part is being redesigned (`AGENTS.md`, "Redesign phase"), the term says "In redesign." Sessions run as the agent user (`docs/adr/0016-agent-user.md`).

## Language

### Places

**Host**:
The owner's macOS user session, apart from the agent user. Only the owner runs commands on the host.
_Avoid_: outside, plain terminal (as a place)

**Agent home omp binary**:
The one omp file on the mac. It is in the `omp/<pin>` folder of the root folder (`root`, `host/facts`). Only the agent user and the login user can run it. Its pinned SHA-256 is in `omp.sha256` beside it. Setup downloads it, and `ug-agent-setup` installs it as root (`omp_bin`, `host/bin/ug-agent-setup`). Each agent session checks its hash at start (`omp_bin`, `host/agent/agent-start`). The login services run it too (`docs/adr/0018-login-user.md`).
_Avoid_: omp copy

**omp launcher**:
`host/bin/ug-agent`, linked as `~/.local/bin/omp`. Typing `omp` logs in as the agent user and starts the agent home omp binary there. The launcher is not omp.
_Avoid_: ug-agent command

**Agent user**:
The macOS user `ugagent` (`agent_user`, `host/facts`). It is standard and hidden. Its home is `agent_home`. It logs in through its own sshd on the agent sshd port (`agent_sshd_port`, `host/facts`), set up by `docs/adr/0016-agent-user.md` and `host/bin/ug-agent-setup`.
_Avoid_: agent account, bot user

**Login user**:
The hidden macOS user `ugauth` (`auth_user`, `host/facts`). It owns the model logins and the two bearer tokens, in its home `auth_home`. It runs the auth broker, the auth gateway, and the usage broker as LaunchDaemons. The owner's user cannot read its home (`docs/adr/0018-login-user.md`).
_Avoid_: auth root, ug-auth profile

**Data folder**:
The owner's data folder `owner_data` (`host/facts`), mode 700. It holds the gh-broker app key and config, the gh-broker records, the protected-paths lists, the backup settings and password, the agent's ssh key, the addresses file, `config-repo`, the pinned restic, and setup's copy of the service code. It does not hold the model logins; the login user owns those (`docs/adr/0017-one-omp-binary-and-no-ug-folder.md`).
_Avoid_: vault, keys dir

**Owner's home**:
The owner's home folder, outside the data folder. It holds the owner's checkouts, the config repo, `~/.ssh`, `~/Library`, and the rest. The agent user and the login user cannot read it (mode 700).
_Avoid_: host files, user space

**Owner's checkout**:
The owner's own Git checkout of a repo, in the owner's home. Setup runs from underground's checkout. It copies the code that the services need into the data folder (`install_service_code`, `host/bin/ug-setup`).
_Avoid_: repo folder, main checkout, primary checkout

**Agent clone**:
The agent user's clone of one repo, at `work/<owner>/<repo>` in the agent home (`clone`, `host/agent/agent-start`). The agent never works in the owner's checkout.
_Avoid_: task clone, copy, mirror

**Agent worktree**:
A Git worktree that a session makes from its clone, on its own `wt/<timestamp>` branch, under omp's default worktree folder `~/.omp/wt` [inference] in the agent home (`AGENTS.md`, "Work a change"). Everything in it is agent-written. Other sessions can write it too.
_Avoid_: ticket worktree, workspace

**Omp root**:
omp's default root, `~/.omp`. For the agent user it is `.omp` in the agent home. At each start, `config-names` in `host/agent/agent-start` copies the config names from the root folder into `~/.omp/agent`. omp runs on it unchanged, on its default profile.
_Avoid_: role home, profile, owner part

**Config repo**:
The owner's private repo of agent configs, in the owner's home, named by the first line of `config-repo` in the data folder (`config-repo`, `host/bin/ug-agent-setup`). It holds skills, hooks, `AGENTS.md`, `config.yml`, `models.yml` with the gateway markers, and other settings, laid out like omp's `~/.omp/agent`. It holds what the agent does inside the walls; underground holds the walls. It holds no secret: `ug-agent-setup` refuses a link, a special file, or a token in it (`vet_item`, `host/bin/ug-agent-setup`). Setup stages its last commit into the root folder (`stage_config`, `host/bin/ug-agent-setup`). The owner's local folder is the source of truth. GitHub keeps a private backup.
_Avoid_: dotfiles, role config

**Skill repo**:
An owner's repo of skills, kept apart from the config repo. The config repo's `skill-repos` file names one path per line, read at its last commit. Setup takes only paths inside the owner's home, after it resolves links. It keeps each folder with a `SKILL.md` at its top or under `skills/`, and refuses a link, a special file, or a token in it. A name that the config repo or an earlier skill repo already has stops setup (`stage_config`, `host/bin/ug-agent-setup`).
_Avoid_: skill pack, plugin

### Running omp

**Version pin**:
A version and a SHA-256 in `VERSIONS`. Setup downloads the pinned omp, checks its hash, and installs it as the agent home omp binary (`docs/adr/0012-pinned-omp-and-setup.md`).
_Avoid_: lock, current version

**Vanilla omp**:
An omp that the owner starts by its full path, outside any session. It finds no login and no bearer, because the login user owns both. It still finds the keyless built-in providers (`apple`, and a local `lm-studio`, `ollama`, or `llama.cpp` server), unless `~/.omp/agent/config.yml` turns them off (`docs/adr/0018-login-user.md`, "Not covered, accepted by name").
_Avoid_: raw omp, plain omp, unwrapped session

**ug-auth**:
The owner's command for the auth services. `ug-auth login <provider>` runs the OAuth login of a provider. `ug-auth key ANTHROPIC_API_KEY` stores an API key: the login user's shell reads it hidden from the terminal and hands it to `omp auth-broker migrate --from-local --include-env` in its environment, so the key is in no argument, file, or shell history (`UG_KEY_NAME`, `host/bin/ug-auth`). `ug-auth list` shows each active credential of the auth broker, with its id, provider, type, and account. An API key shows only its first and last characters. `ug-auth revoke <id>` turns off that one credential (`docs/adr/0005-model-auth-gateway.md`, "Amendment 2026-11-09: turn off one credential"). Any other command runs the agent home omp binary as the login user through `sudo` (`host/bin/ug-auth`).
_Avoid_: vanilla omp, admin omp

**Agent home backup**:
The daily restic snapshot of the agent home. It goes to one repo on the owner's other machine. The tar stream is read through the root helper `agent-home-tar` (`host/agent/agent-home-tar`), and the job is in `host/services`. Settings are in `~/.local/share/underground/backup/config` (`host/bin/ug-backup`). The repo keeps every snapshot, so harm to the home can be undone (`docs/SPEC.md`, "Backup").
_Avoid_: archive, sync, Time Machine

**Setup**:
The host script that does what `git pull` cannot. It downloads the pinned omp and restic, makes the data folder and the backup password, and runs `sudo host/bin/ug-agent-setup`. That step asks for the owner's password. It installs the agent home omp binary, the agent user, the login user and its services, the omp launcher, and the backup helper. Then it restarts the host services and checks, as the owner, that the owner cannot run omp or read a login or the bearer. It first fast-forwards `main` in its own checkout from `origin`. It runs no tests; CI runs them on macOS. It runs when underground's `main`, a pin, a host service, or macOS changes (`docs/adr/0012-pinned-omp-and-setup.md`).
_Avoid_: install, installer, bootstrap

**Crossing**:
A way into or out of the agent's sessions: code out, model calls, `/usage`, web out, config in, repos in, unix sockets, localhost, and merge effects. Each crossing has one control (a principle that an earlier version of `docs/PRODUCT-BRIEF.md` held).
_Avoid_: hole, exception, bypass

### GitHub and the merge

**gh-broker**:
Runs today: a host service that does GitHub operations for the sessions. It holds the GitHub credential, and each session reaches it through one socket (`socketPath`, `host/gh-broker/server.ts`). It serves each repo where the gh-broker app is installed. In redesign.
_Avoid_: broker (alone), agent-gh, proxy

**Reviewer role**:
One of `code-review`, `security-review`, and `risk-review`. A reviewer is a skill from the config repo, not a separate session. Any omp session can run it, with the same home and trust level as every other session. It reads a PR with `gh-broker sync <owner/repo> --pr <n>`, and writes its verdict with `gh-broker review`, which names the role. It is a quality step, not a safety wall (`docs/adr/0011-one-agent-arena.md`). In redesign.
_Avoid_: reviewer session, review agent, bug bot, security bot

**Review verdict**:
A record that a reviewer writes with `gh-broker review <owner/repo> <n> <sha> <role> <verdict> [reason]`, for one PR and one full head sha. The verdict is `pass`, `manual`, or `block`. A `manual` or `block` needs a reason. `code-review` and `security-review` give `pass` or `block`. `risk-review` gives `pass` (auto) or `manual`. The gh-broker appends each verdict to the file of its PR in the gh-broker's `reviews` folder, and keeps the file after the merge. In redesign.
_Avoid_: reviewer result, finding, approval

**Attempt**:
One head of a PR with a `block` from any reviewer role. Two roles that block one head count as one attempt. A head with no `block` is not an attempt. In redesign.
_Avoid_: round, try

**Hold**:
A state of a PR that makes `gh-broker merge` refuse, with a reason that says the owner merges this PR on GitHub. A `manual` on any head makes a hold. So does each blocked head from the fourth attempt on, which holds every later head. A changed protected path on the head also makes a hold. Nothing in the gh-broker ends a hold. Runs today: the owner merges the PR on GitHub by hand. In redesign.
_Avoid_: lock, freeze

**Protected path**:
A path that the auto merge never accepts: `.github/**`, every `CODEOWNERS` file, and each glob in the owner's protected-paths list for the repo, in the data folder (`isProtectedPath`, `host/gh-broker/protocol.ts`). A rename counts its old path and its new path.
_Avoid_: manual path, sensitive path

**Auto merge**:
Runs today: `gh-broker merge` does one kind of merge. It merges when the CI checks are green, the head is the push record of its branch, no hold applies, no `block` is on the head, and the latest verdict on the head from each of `code-review`, `security-review`, and `risk-review` is `pass`. The owner's approval plays no part. Every other PR is merged by the owner on GitHub. A repo whose code runs on the host, such as underground, gets no auto merge (onboarding check 6, `docs/SPEC.md`). In redesign.
_Avoid_: auto tier, bot merge, owner-approved merge

**Push record**:
The commit that the gh-broker last pushed to one branch of one repo. A later push replaces it. The gh-broker keeps it in its `pushes` folder, in the data folder, with the `/` in the branch name written as `%2F` (`dropPushRecord`, `host/gh-broker/push-record.ts`).
_Avoid_: push log, provenance record

**gh-broker app**:
The GitHub App that the gh-broker acts as. The owner's personal account owns it. It is installed only on the selected repos, with Contents and Pull requests read and write, Metadata, Checks, and Commit statuses read, and no Workflows or Administration permission. Its private key is `github-app.pem` in the data folder, with `github-app.json` beside it (`appFiles`, `host/gh-broker/github-app.ts`). GitHub shows the gh-broker's actions as `<app slug>[bot]` (`docs/adr/0007-gh-broker-github-app.md`).
_Avoid_: bot account, bot token, gh-broker token, machine user, service account

**Installation token**:
A token of the gh-broker app for one repo, which the gh-broker gets with the app's private key. It lasts one hour. Only the gh-broker holds it, in memory.
_Avoid_: app token, gh-broker token, PAT

**Onboarding checks**:
The six checks in `docs/SPEC.md` that the owner makes on GitHub for each repo before agents merge alone in it. A repo is onboarded when the owner has made them and installed the gh-broker app on it. The app's installation is the list.
_Avoid_: onboarding list, repo setup

### Models

**Auth broker**:
The host service `omp auth-broker serve`. It runs as the login user, on the auth broker port (`auth_broker_port`, `host/facts`). It holds the owner's model logins in the login user's home, and does every OAuth refresh. The owner reaches it with `ug-auth`. Only the auth gateway talks to it. No session is a broker client, because a broker client receives access tokens and API keys.
_Avoid_: credential store, vault

**Auth gateway**:
The host service `omp auth-gateway serve`, on the tailscale address of this mac (the `gateway=` line of the addresses file). It runs as the login user, on the gateway port (`gateway_port`, `host/facts`). It makes model calls for the sessions with the logins of the auth broker. Every call needs the gateway bearer.
_Avoid_: model proxy, LLM proxy

**Usage broker**:
The host service `host/gh-broker/usage-broker.ts`, run as the login user from the pinned omp (`host/agent/com.underground.usage-broker.plist`). It speaks omp's broker protocol with no credentials. It passes `/v1/usage` to the auth gateway, so omp's native `/usage` works. It listens on the usage broker port (`usage_broker_port`, `host/facts`) on loopback only (`USAGE_BROKER_HOST`, `host/gh-broker/usage-broker.ts`).
_Avoid_: usage proxy, fake broker

**Gateway bearer**:
The shared token that lets a session use the auth gateway. It authorizes every session for all models and accounts that the gateway serves, plus usage and credential health. It does not expose provider secrets or credential management. The agent user reads it from the root folder's `config` folder. The owner accepted this cost (U30, `docs/adr/0005-model-auth-gateway.md`). The separate auth-broker bearer stays in the login user's home.
_Avoid_: client token, API key, gateway key

**Gateway provider**:
A provider in a session's `models.yml`, with `transport: pi-native`, `baseUrl` set to the auth gateway, and `apiKey` set to the gateway bearer. Setup fills `@GATEWAY@` and `@GATEWAY_TOKEN@` into the staged `models.yml` (`@GATEWAY_TOKEN@`, `host/bin/ug-agent-setup`). Each model setting of a session names a model of a gateway provider.
_Avoid_: proxy provider

**Inference engine**:
The model server on another machine on the tailnet, at the `engine=` line of the addresses file. It needs an API key, which the auth broker holds under omp's built-in `lm-studio` provider. Sessions reach it only through the auth gateway (`docs/adr/0005-model-auth-gateway.md`, "Amendment 2026-11-01: the inference engine behind the gateway").
_Avoid_: local model, llama

**Addresses file**:
The owner-only file with two lines: `gateway=<ip>:<port>`, the auth gateway on the tailscale address of this mac, and `engine=<ip>:<port>`, the inference engine. Setup writes it only when it is missing. The gateway comes from the first line of `tailscale ip -4`, with the gateway port (`gateway_port`, `host/facts`). The engine comes from the owner's answer at a prompt. Without a terminal, setup stops and writes nothing (`write_addresses`, `host/bin/ug-setup`). The owner edits it later. It is `addresses` in the data folder.
_Avoid_: address config, hosts file

### Decisions

**Agent-written**:
Describes any file, branch, or setting that the agent could change: everything in its home. Treat it as untrusted until the owner reviews it on GitHub.
_Avoid_: local work, dirty

**One trust level**:
Every role shares the agent user's home and can change what another role loads. The reviewers improve quality. They are not a safety wall. The onboarding checks keep a merge reversible instead (`docs/adr/0011-one-agent-arena.md`).
_Avoid_: role isolation, shared trust

**Accepted risk**:
A threat that the project does not control, with the reason written in an ADR in `docs/adr/`.
_Avoid_: known issue, wontfix

**North star**:
The one direction that every decision follows, in `AGENTS.md` and `docs/PRODUCT-BRIEF.md`: the agent works like a coworker. The owner and the agent do the design together. The agent turns each ready ticket into a merged change on its own. Whatever the agent does without the owner's approval, in either way of working, the owner can undo.
_Avoid_: vision, goal, mission

**Ready ticket**:
A user story or ticket that the specs and ADRs have broken down into the smallest unit of work, with no design decision left in it. Only a ready ticket goes to the agent to do on its own (`docs/PRODUCT-BRIEF.md`, "User and scope").
_Avoid_: task, job, issue

**Gate**:
The question before each decision: does this bring us closer to the north star, or further away? Yes only if it stops an irreversible harm, or keeps undo and work possible.
_Avoid_: review, approval

**MVPF**:
The future underground MVP after 0.5. A threat marked MVPF has no control in 0.5.
_Avoid_: later, backlog, v1
