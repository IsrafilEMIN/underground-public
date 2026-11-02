# Spec: MVP 0.5

The design is in `PRODUCT-BRIEF.md` (owner decision, 2026-11-02). The rows come from `THREAT-MODEL.md`. The reasons are in `adr/`; the redesign is in `adr/0011-one-agent-arena.md` and `adr/0012-pinned-omp-and-setup.md`. Deadline: not set.

Status: **built** means the code exists today. **Change** means the code exists but must move to the redesign. **To build** means no code yet.

## Build

|id|build|rows|status|
|---|---|---|---|
|B1|Zones and setup. Setup makes `~/.ug/sys` (owner zone), `~/.ug/run` (sockets and rendered srt settings), `~/.ug/secrets` (secrets zone), and `~/.ug/home` (the arena), each with its mode. underground runs from the owner's checkout, so `git pull` updates its code. Setup runs only when a pin changes, a host service changes, or macOS updates. It installs the pinned omp and srt (B2), registers and restarts the launchd services, puts the wrapper on `PATH`, runs the U1 and U2 probes (Checks), and records the macOS build. At each start, the wrapper refuses when the macOS build differs from the recorded one. Setup replaces `install.sh`, `ug-install`, and the install record (`adr/0012-pinned-omp-and-setup.md`).|U4, U6|to build|
|B2|Pinned omp. `VERSIONS` holds the omp version and the SHA-256 of `omp-darwin-arm64`. Setup downloads that file from the omp GitHub release, checks the hash, and keeps its own copy in `~/.ug/sys/omp/<version>/omp`. The only `omp` on `PATH` is `~/.ug/sys/bin/omp`, a link to the wrapper in the owner's checkout. Tern's `omp/bin/omp` and `~/.local/bin/omp` come off `PATH`, and the zsh alias goes. `~/.omp` holds no login, so a raw omp cannot call a model (`adr/0012-pinned-omp-and-setup.md`). srt is pinned with its dependencies: `host/srt/package-lock.json` holds the SHA-512 of srt and of each dependency, and setup installs it with `npm ci` into `~/.ug/sys/srt/<version>`. Built: `host/bin/ug-setup` installs both pins. To build: the `PATH` change and the move of the logins.|U15, U36|change|
|B3|Wrapper. It reads `origin` of the owner's checkout. At each start it copies the owner's config repo into `~/.ug/home/.omp/agent`, sets `HOME=~/.ug/home`, starts a clean environment with named variables only, writes the srt settings into `~/.ug/run`, and starts srt with the pinned omp in the arena clone of the repo (B4). It sets no `PI_CONFIG_DIR`, `PI_CONFIG_FILES`, `XDG_*`, or `CARGO_HOME`. omp runs on its default profile (`adr/0011-one-agent-arena.md`).|U1, U6|to build|
|B4|Arena clone. Each repo has one clone in the arena, proposed at `~/.ug/home/work/<owner>/<repo>`. Git in the arena runs only inside the sandbox: the clone is made and updated with `broker sync`. The host never runs git in the arena. Agent worktrees fall under omp's default `~/.omp/wt`, which is now inside the arena (`adr/0011-one-agent-arena.md`).|U4, U31|to build|
|B5|Sandbox settings. `denyRead` of `~`. The sandbox reads the arena and the owner zone, and writes only the arena. `allowUnixSockets` is a strict list: the broker sockets in `~/.ug/run` and omp's helper sockets (paths: Checks). `allowLocalBinding: true` for now (`adr/0004-no-local-binding.md`). One network allowlist, `host/roles/network-allowlist` in the owner's checkout: the auth gateway with its port, `github.com`, the web search domains, and `registry.npmjs.org` (`adr/0001-accepted-risks.md`). `allowAppleEvents: false`. No `skillLinkRoots`, no per-role grants, no owner-path denies.|U1, U2, U3, U6, U7, U14|change|
|B6|Model auth. The auth broker (`omp auth-broker serve`) listens on `127.0.0.1:8765` and keeps its logins in its own root in `~/.ug/secrets/auth`. Only the auth gateway talks to it. The auth gateway (`omp auth-gateway serve`) listens on the tailscale address of this mac. No session is a broker client, because a broker client receives access tokens and API keys (omp `docs/auth-broker-gateway.md:3`, read 2026-11-02). The usage broker (`host/broker/usage-broker.ts`) holds no credentials and passes `/v1/usage` to the gateway; it moves to the tailscale address, so the auth path needs no localhost (`adr/0005-model-auth-gateway.md`).|U15, U30|change|
|B7|GitHub broker. A GitHub App (`adr/0007-broker-github-app.md`). Its key moves to `~/.ug/secrets/github-app.pem`, mode 600. It pushes `agent/*` only (`validateRequest`, `host/broker/protocol.ts:165`), keeps a push record per branch (`adr/0003-auto-merge-provenance.md`), deletes the head branch after a merge, and limits `ci-log`. The merge gate: green CI, the head is the push record, no hold, and a latest `pass` on the head from `code-review`, `security-review`, and `risk-review` (`mergeRefusal`, `host/broker/protocol.ts:420` to `:432`). To build: a repo-wide hold for underground, so `broker merge` refuses every underground PR and the owner merges it (onboarding check 6).|U10, U12, U13, U18, U28, U29, U35|change|
|B8|Reviewer roles. `code-review`, `security-review`, and `risk-review` write verdicts with `broker review`. They are a quality step, not a safety wall (`adr/0011-one-agent-arena.md`). Their rules come as skills in the owner's config repo. They read the PR in the arena clone, through `broker sync --pr`. The holds, attempts, and review records stay as built until their review (Deferred).|U10, U11|change|
|B9|Removal. The parts that the brief retires go: the owner part and the role policy with its pins (`PINNED_SETTINGS`, `host/broker/admin.ts:75`), the role rules files and the `role-rules.ts` hook, the reviewer stores `~/.ug/git` and the reviewer flag refusals, per-role sessions and state, `skillLinkRoots`, `drop_secret_env`, the install record and its preflight hash checks, and the reads and writes in `~/.agents` and `~/.config/underground-broker`. The macOS build check stays (B1).|U32|to build|

## Onboarding checks

The owner checks each repo on GitHub before agents merge alone in it.

1. No Actions secrets and no credential variables for `pull_request` jobs. No `id-token: write`.
2. The default `GITHUB_TOKEN` is read-only.
3. GitHub-hosted runners only.
4. The broker app is a GitHub App of the owner's account, installed on selected repos, with no Workflows and no Administration permission (`adr/0007-broker-github-app.md`).
5. Each workflow that deploys, publishes, or uses secrets on `main` waits for the owner's approval in a GitHub environment. So a merge has no effect that a revert cannot undo.
6. A repo whose code runs on the host, such as underground, gets no auto merge. The owner merges each PR and reads the merged change before the host runs it.

Source: the earlier onboarding list, checks 1 to 6 (`git show f16005c^:docs/ONBOARDING.md`).

## Checks

**Probes of the sandbox (U1, U2).** `scripts/probe-u1-u2.sh` plants canaries on the host: a keychain item, a preference, clipboard text. Each probe runs the same read twice. On the host it must succeed; if not, the probe is broken. In the sandbox the result is open (the canary is read), blocked (srt reports a denial), or inconclusive (anything else, for example a missing tool or a privacy prompt). Setup runs them on each new macOS build. Limits: one keychain item does not cover items with other access rules, a device list does not prove capture, and a screen capture counts only if the image shows the screen.

**Tests.** The suite in `tests/` uses fake data only: temp homes, local bare repos in place of GitHub, and a fake `gh`. CI runs it on each PR head and each push to `main` (`.github/workflows/ci.yml`). Setup runs it before it writes a file or a service.

**Probes of the redesign.** `scripts/probe-arena.sh` covers the `HOME` check below. It runs after `host/bin/ug-setup`, without touching the current install, and also checks the pin hash, `omp --version` in the sandbox, a prompt through the auth gateway, and omp files in the arena. Then it tries to break out: a read and a write of the real home, the same read through omp's runtime, a symlink and a hard link from the arena, the ssh agent socket directly and through a link, and a domain off the allowlist. Every deny check has a control, and a deny counts only with the sandbox's own error; anything else is inconclusive. It lists the paths outside the arena that omp peeked at and the sandbox blocked, from the system log, calibrated by a known deny; a blocked peek passes. On 2026-11-02 these were `~/.omp/agents` and `~/.ug` (omp looks for project agents in every folder up to `/`, `findAllNearestProjectConfigDirs` in omp `config.ts`) and the macOS global preference files. `tests/host/probe-arena.test.ts` runs the probe against a leaky and a broken fake srt, and requires a BREACH or no PASS.

- `HOME`: omp, bun, and git on the pinned omp use the arena as home. A tool that ignores `HOME` fails on the srt deny; it does not leak.
- omp's helper sockets: their paths under `~/.ug/home/.omp/run/daemons`, with `lsof -nP -U | grep '/.ug/home/'`.
- The arena clone step (B4).
- Localhost: turn `allowLocalBinding` off and record what fails.

**Live run.** In a throwaway repo that passes the onboarding checks: one task from branch to auto merge, one revert with green CI through the broker, one revert with red CI by the owner on GitHub, and one PR with a planted security defect, which `security-review` must `block`.

## Deferred

- Localhost: limit it, or accept it (`adr/0004-no-local-binding.md`).
- Per-repo network allowlists, with the data-out question (U14).
- The merge gate's machinery: what is still needed now that reviewers are quality only.
- The runtime for scripts (principle 9 of `PRODUCT-BRIEF.md`).
- A feature request to Stencil: `/usage` through the auth gateway.
- The MVPF rows in `THREAT-MODEL.md`.
