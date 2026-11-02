# underground

A safe environment for running the omp coding agent unattended on one macOS laptop.

## Language

**Sandbox**:
The single boundary around the whole omp process. Everything the agent starts runs inside it.
_Avoid_: jail, container, lock

**Host**:
The owner's macOS user session outside the sandbox. Only the owner runs commands on the host.
_Avoid_: outside, plain terminal (as a place)

**Wrapper**:
The `omp` command the owner runs. It starts omp inside the sandbox.
_Avoid_: launcher, omp-srt

**Repo folder**:
The folder that holds the main Git checkout of a repo: the nearest folder, at or above the folder where the owner types `omp`, that has a `.git` folder. omp starts here, in any git repo. The sandbox can read it but cannot write it, except the git paths that a worktree needs in its `.git` folder.
_Avoid_: main checkout, primary checkout

**Repo id**:
The name of the folder of a repo in `~/.omp/wt`: the repo folder name, a `-`, and the first 8 hex characters of the SHA-256 of the real repo folder path.
_Avoid_: repo hash, slug

**Worktree folder**:
The folder `~/.omp/wt/<repo id>` of one repo. The wrapper passes it to omp in `OMP_WORKTREE_DIR`. Every author session of the repo can write the whole folder. A reviewer session cannot read it.
_Avoid_: ticket folder, wt root

**Agent worktree**:
A Git worktree that a session makes for itself in the worktree folder, on its own `agent/*` branch: `git worktree add -b agent/<name> "$OMP_WORKTREE_DIR/<name>" origin/main`. Everything in it is agent-written. The other sessions of the same repo can write it too.
_Avoid_: ticket worktree, task clone, copy, workspace

**Session folder**:
The one omp session folder of a repo in the write area: `~/.ug/omp/agent/sessions/ug-<repo id>`. All sessions of a repo share it, whatever their role name. The wrapper passes it to omp only as the `--session-dir` default. A session can open the session files of every other role (`docs/adr/0010-shared-sessions-and-state.md`).
_Avoid_: session bucket, sessions dir

**Write area**:
The set of folders that the sandbox can write to. All other paths are read-only or hidden.
_Avoid_: allowed paths, writable roots

**Cache root**:
The one folder that holds package and build caches for sandbox runs of every role name: `~/.ug/omp/underground/cache`. A role can plant a program there that a later session of any role runs (`docs/adr/0009-one-omp-root.md`). The host never runs a program from it.
_Avoid_: tool cache, home cache

**Broker**:
The host service that does GitHub operations for the sandbox. It holds the only GitHub credential that agents use.
_Avoid_: gh-broker, agent-gh, proxy

**Broker binding**:
One repo and one role name that one broker socket serves. The wrapper registers one binding for each repo folder and role name. Its socket is `~/.agents/broker/run/<name>-<hash>/<role name>.sock`, where `<hash>` comes from the repo folder path. The binding holds the role name and the binding role that the roles table maps it to. All sessions of that repo and role name share it. It allows the verbs of its binding role on that repo only. A session can connect only to the socket of the binding of its repo and role name. On each request and at a broker restart, the broker refuses a binding whose role name left the roles table or now maps to another binding role.
_Avoid_: ticket token, shared socket, scope

**Binding role**:
The role of a broker binding: `author`, or one reviewer role: `code-review`, `security-review`, or `risk-review`. The roles table maps each role name to one binding role. An author binding can use `sync`, `push`, `pr-create`, `pr-status`, `ci-log`, and `merge`. A reviewer binding can use `sync`, `pr-status`, and `review`.
_Avoid_: socket type, mode

**Reviewer session**:
An omp session that the owner starts with `omp --role <name>`, where the roles table maps the name to a reviewer role. It uses the omp root, the rules of its binding role, the one network allowlist, and the broker binding of that role name. It starts new in its store folder `~/.ug/git/<role name>`, never in a checkout, and reads the PR only with `git -C` on its reviewer store. Its sandbox has no grant on the repo folder or the worktree folder. It never runs PR code.
_Avoid_: review agent, bug bot, security bot

**Review verdict**:
A record that a reviewer session writes with `broker review` for one PR and one full head sha: `pass`, `manual`, or `block`, with a reason for `manual` and `block`, and the role name and binding role of the session. `code-review` and `security-review` give `pass` or `block`; `risk-review` gives `pass` (auto) or `manual`. The broker appends each verdict as one line to the file of its PR on the host, `~/.agents/broker/reviews/<owner>/<repo>/<pr>.jsonl`, and keeps the file after the merge. A verdict from before role names has role name `null`: its `block` and `manual` count, and its `pass` counts for no role.
_Avoid_: reviewer result, finding, approval

**Attempt**:
One head of a PR with a `block` from any reviewer role. Two roles that block one head are one attempt. A head with no `block` is not an attempt.
_Avoid_: round, try

**Hold**:
A state of a PR that makes `broker merge` refuse with a reason that says the owner merges this PR on GitHub. A `manual` on any head makes a hold, and so does each blocked head from the fourth attempt on; it holds every later head. A changed protected path on the head also makes a hold. Nothing in the broker ends a hold: the owner merges the PR on GitHub by hand.
_Avoid_: lock, freeze

**Protected path**:
A path that the auto merge never accepts: `.github/**`, every `CODEOWNERS` file, and each glob in the host list `~/.config/underground-broker/protected-paths/<owner>/<repo>`. A rename counts its old path and its new path.
_Avoid_: manual path, sensitive path

**Auto merge**:
The only merge that `broker merge` does: green checks, a head that is the push record of its branch, no hold, no `block` on the head, and a latest verdict of `pass` on the head from each of `code-review`, `security-review`, and `risk-review`. The owner's approval plays no part. Every other PR is merged by the owner on GitHub.
_Avoid_: auto tier, bot merge, owner-approved merge

**Push record**:
The commit that the broker last pushed to one branch of one repo. A later push replaces it. The broker keeps it on the host in `~/.agents/broker/pushes/<owner>/<repo>/<branch>`, with the `/` in the branch name written as `%2F`.
_Avoid_: push log, provenance record

**Broker app**:
The GitHub App that the broker acts as. The owner's personal account owns it, and it is installed only on the selected repos, with Contents and Pull requests read and write, Metadata, Checks, and Commit statuses read, and no Workflows or Administration permission. Its private key is `~/.config/underground-broker/github-app.pem` on the host. GitHub shows the broker's actions as `<app slug>[bot]` (`docs/adr/0007-broker-github-app.md`).
_Avoid_: bot account, bot token, broker token, machine user, service account

**Installation token**:
A token of the broker app for one repo, which the broker gets with the app's private key. It lasts one hour, and only the broker holds it, in memory.
_Avoid_: app token, broker token, PAT

**Agent-written**:
Describes any file, branch, or setting that the sandbox could change. Treat it as untrusted until the owner reviews it on GitHub.
_Avoid_: local work, dirty

**Accepted risk**:
A threat that we do not control, with the reason written in an ADR in `docs/adr/`.
_Avoid_: known issue, wontfix

**North star**:
The one direction that every decision follows, in `AGENTS.md` and `docs/PRODUCT-BRIEF.md`: an unattended agent can only do harm that you can undo.
_Avoid_: vision, goal, mission

**Gate**:
The question before each decision: does this bring us closer to the north star, or further away? Yes only if it stops an irreversible harm, or keeps undo and work possible.
_Avoid_: review, approval

**MVPF**:
The future underground MVP after 0.5. A threat marked MVPF has no control in 0.5.
_Avoid_: later, backlog, v1

**Omp root**:
The one omp root of every role name: `~/.ug/omp` (`PI_CONFIG_DIR=.ug/omp`). It holds the owner part `agent`, omp's own files (`agent/config.yml`, `agent.db`, `history.db`, caches), the session folders `agent/sessions/ug-<repo id>`, and underground's folders in `underground`: the cache root `cache`, the temp folder `tmp` (`TMPDIR`), and the state folders `state/<hash>`, one per repo for every role. Every role writes it, except the owner part. Agents write it, so the owner runs no host tool there. It replaced the per-role homes (`docs/adr/0009-one-omp-root.md`, `docs/adr/0010-shared-sessions-and-state.md`).
_Avoid_: role home, profile, sandbox dir

**Owner part**:
The files of the omp root that only the owner writes, in `~/.ug/omp/agent`: the role policy `policy.yml`, `prefs.yml`, `models.yml`, the hooks `hooks/pre/concise-reply.ts` and `hooks/pre/role-rules.ts`, and the loader paths that `render-settings` denies (skills, extensions, rule and prompt files). The wrapper and the installer write them from `~/.agents/roles` at each session start and install. The role reads them but cannot write them. Rules and the network allowlist are not in it: rules stay per binding role in `~/.agents/roles/<binding role>`, and `render-settings` reads the allowlist at `~/.agents/roles/network-allowlist`.
_Avoid_: config dir, read-only part

**Role rules**:
The rules of one binding role, `~/.agents/roles/<binding role>/AGENTS.md`, owner-owned. The wrapper passes the file to omp with `--append-system-prompt` and names it in `UG_ROLE_RULES`; the hook `role-rules.ts` appends the same file to the system prompt of each task subagent, because omp does not pass `--append-system-prompt` to subagents. The wrapper refuses a reviewer role without rules and a caller's own `--append-system-prompt`.
_Avoid_: role AGENTS.md, omp/agent/AGENTS.md

**Role policy**:
The owner's omp settings of every role, `~/.ug/omp/agent/policy.yml` in the owner part. The wrapper writes it from `~/.agents/roles/policy.yml` at each session start and sets `PI_CONFIG_FILES` to it, so omp loads it as a read-only overlay above the shared writable `config.yml`. It pins each setting that loads rules, skills, extensions, hooks, MCP servers, tools, prompts, memory, or notes from a path, keeps state across sessions, or turns off a source of the owner part (`docs/adr/0002-role-homes.md`). A setting it does not pin carries from one role's sessions into every other role's (`docs/adr/0009-one-omp-root.md`). The wrapper refuses a policy that misses a pin, that does not set `memory.backend: off` and `autolearn.enabled: false`, or that selects a model outside the gateway, and it refuses `--config` and `--profile`.
_Avoid_: role config, config.yml

**Role table**:
The owner-only file `~/.config/underground-broker/roles`. Each line holds a role name and its binding role, for example `security-review security-review`. A role name is `a-z`, `0-9`, and `-`, up to 32 characters. The wrapper and the broker refuse a name that is not in it. `omp` with no `--role` uses the name `author`.
_Avoid_: role list, profile list

**Reviewer store**:
The bare git repo of one reviewer role name for one repo folder, `~/.ug/git/<role name>/<hash>.git`, outside the omp root. The wrapper makes it and puts its path in `UG_REVIEW_STORE`. Only that role name can write it, and not its `config` or `hooks`. `broker sync <repo> --pr <n>` imports the PR head into it as `origin/pr/<n>` and checks it against `headRefOid`; `broker sync <repo>` imports the default branch into it as `origin/<default branch>`.
_Avoid_: review clone, reviewer checkout

**Auth broker**:
The host service `omp auth-broker serve` (launchd `com.underground.auth-broker`, on `127.0.0.1:8765`). It holds the owner's model logins and does every OAuth refresh. No role has a login.
_Avoid_: credential store, vault

**Auth gateway**:
The host service `omp auth-gateway serve` (launchd `com.underground.auth-gateway`) on the tailscale address of this mac, the `gateway=` line of the addresses file. It makes model calls for the sandbox with the logins of the auth broker. Every call needs the gateway bearer.
_Avoid_: model proxy, LLM proxy

**Gateway bearer**:
The shared token in `~/.omp/auth-gateway.token`. `gateway-setup` creates it if missing and puts it in every role's `models.yml`. It authorizes every role for all models and accounts served by the gateway, usage, and credential health. It does not expose provider secrets or credential management. The separate auth-broker bearer stays on the host.
_Avoid_: client token, API key, gateway key

**Gateway provider**:
A provider in `~/.ug/omp/agent/models.yml`, the one `models.yml` of every role, with `transport: pi-native`, `baseUrl` the auth gateway, and `apiKey` the gateway bearer. The installer (`admin.ts gateway-setup`) writes it from `~/.agents/roles/models.yml`. Each model setting of the role names a model of a gateway provider; the wrapper refuses any other. Model settings include the advisor and prewalk models of task agents (`task.agentAdvisor`, `task.agentPrewalk`, and agent frontmatter `advisor` and `prewalk`). Those selections do not limit gateway authorization.
_Avoid_: proxy provider

**Inference engine**:
The keyless model server on `v100-server`, another box on the tailnet, at the `engine=` line of the addresses file (today `100.64.0.99:8081`). It is the `strata` provider in `models.yml`, and it needs no login.
_Avoid_: local model, llama

**Addresses file**:
The owner-only file `~/.config/underground-broker/addresses` (mode 600) with two lines: `gateway=<ip>:<port>`, the auth gateway on the tailscale address of this mac, and `engine=<ip>:<port>`, the inference engine. The installer writes it only when it is missing, from the first line of `tailscale ip -4` with port `4000`; the owner edits it later. The installer renders the gateway plist and `models.yml` from it, and `render-settings` fills the network allowlist from it at each session start.
_Avoid_: address config, hosts file

**Network allowlist**:
The network destinations of every role, one per line in the owner-owned `~/.agents/roles/network-allowlist`. `render-settings` reads that file at each session start, puts its lines in the srt `allowedDomains`, and refuses an address without a port. A tailscale entry names the address and the port of one service, never the bare address. The template names the auth gateway as `@GATEWAY@`; `render-settings` fills `@GATEWAY@` and `@ENGINE@` from the addresses file. A literal address still works. Its entries: the auth gateway, `github.com`, the web search domains, and `registry.npmjs.org`. No role gets a model provider domain or the inference engine.
_Avoid_: domain list, egress list

**Install record**:
The file `~/.agents/install-manifest` that the installer writes last: each file it wrote with its mode and SHA-256, each folder it set a mode on, and the macOS build. The preflight compares this mac with it.
_Avoid_: manifest, lockfile, snapshot

**Preflight**:
The checks that the wrapper runs at each launch, before the sandbox starts: is this mac still in the state that the install proved? They read names, modes, and hashes, never a secret value, and change nothing. A broken control refuses the launch; a launchd job that is not running warns. The install checks behavior; the preflight checks state (`docs/adr/0008-preflight.md`).
_Avoid_: health check, doctor, self-test
