# Fast launch: the gh-broker keeps main current, the launch reads it locally

Date: 2026-11-08. Status: proposed, not built. Owner decisions of 2026-11-08: the gh-broker refreshes each repo every 30 s; the refresh gets its own read-only token; a repo with no launch for 7 days drops out of the refresh; the first launch of a repo keeps the full sync.

## Context

A launch takes about 2 s from enter to a ready prompt. The parts, measured on 2026-11-08:

| Part | Time | Source |
|---|---|---|
| `ug-agent --version` in a repo (whole launch path, no TUI) | 1.34 s, 1.74 s | owner runs with `$EPOCHREALTIME` |
| `ug-agent --version` outside a repo (no sync) | 0.58 s | owner run |
| `gh-broker sync` alone | 0.96 s, 1.00 s, 1.24 s | agent run |
| config copy loop (`agent-start:28-32`) | 0.25 s, 0.26 s, 0.28 s | agent run |
| one copy of the whole config (`ditto`) | 0.08 s | agent run |
| one GitHub round trip (`git ls-remote --symref <url> HEAD`) | 0.26 s, 0.28 s; 0.09 s CPU each over 10 runs | agent runs |
| `git bundle create` plus import of the full branch (900 KB) | 0.14 s | agent run |
| omp from start to ready (`--mode rpc`) | 0.26 s | agent run, `PI_DEBUG_STARTUP` |
| omp in the TUI: first log line to first skill compression | 0.2 s to 0.4 s | `~/.omp/logs`, owner launches of 2026-11-08 |
| terminal return after omp removes its worktree | under 0.02 s | agent-side watcher against owner timestamps |

So the sync is about half of the launch. It costs four steps in series, and three of them reach GitHub: `gh repo view` for the default branch (`defaultBranch`, `host/gh-broker/server.ts:200-208`), a fetch into the bare repo (`:237`), a bundle of the full branch history (`:239`), and the import in the clone (`importSync`, `host/gh-broker/client.ts:199-211`). The config loop starts about 60 processes, one `rm` and one `cp` per name.

The 30 skill description compression calls fail at each start (429 from the `smol` model), but omp starts them after the TUI is up and does not wait for them at exit (omp 18.18.1 bundle: `deferSkillDescriptionCompression`, `startSkillDescriptionCompression`, `void sd.waitForPending()`). They are not part of the wait.

## Decision (proposed)

1. **The gh-broker refreshes main on a timer.** Every 30 s, for each repo synced in the last 7 days, the gh-broker runs `git ls-remote --symref <url> HEAD`. It returns the default branch and its commit in one round trip (agent run, 2026-11-08: `ref: refs/heads/main	HEAD`, then the commit). The branch name goes through the same check as today (`DEFAULT_BRANCH_RE`, `host/gh-broker/protocol.ts:55`). When the commit differs from the bare repo's ref, the gh-broker fetches. It records the time of each good check per repo, in memory. A repo with no sync for 7 days drops out; its next launch adds it back.
2. **The timer uses a read-only token.** The gh-broker mints it with `permissions: {"contents": "read"}` and caches it apart from the token that pushes and merges. Today one token per repo has all of the app's permissions, because the request names only the repo (`host/gh-broker/github-app.ts:120-126`), and GitHub gives such a token "all of the permissions that were granted to the app" (https://docs.github.com/en/rest/apps/apps, "Create an installation access token for an app", read 2026-11-08). The other verbs keep their token.
3. **A launch sync reads the bare repo.** The client sends the commit that its `refs/remotes/origin/<branch>` already points at, as an optional `have`. The gh-broker accepts only a 40-hex commit (`isSha`, `host/gh-broker/protocol.ts:73`). If its last good check of the repo is at most 40 s old, it answers from local disk: "unchanged" with no bundle when `have` is the branch commit, else a bundle of `refs/heads/<branch> ^<have>`, else the full bundle when it does not have `have`. If the last check is older or missing, as after a broker restart or a wake from sleep, it first runs the check of step 1 once. The client prints the same line as today, `origin/<branch> is now <commit>`, so `agent-start:54`, the setup wizard, and the tests that read it do not change.
4. **The first launch of a repo keeps the full sync.** A new clone has no `origin/<branch>` (`agent-start:42-47`), so the client sends no `have` and gets the full bundle, as today.
5. **One queue per repo.** Every write to a bare repo (the timer fetch, a sync fetch, `sync --pr`, push, the branch cleanup after a merge) runs through one promise chain per repo. Today the gh-broker has none (no lock, queue, or mutex in `host/gh-broker/server.ts`), so a timer fetch and a sync could move `refs/heads/main` at the same moment.
6. **The config copy is one step.** `agent-start` deletes every name in `config-names` in one `rm`, then copies the staged config in one command. The reset of the agent's own config at each start stays (`../THREAT-MODEL.md`, U6). A hash compare is not used: hashing both sides took 0.15 s and 0.19 s, more than the copy (agent runs, 2026-11-08).

Expected result: a launch of about 1.0 s to 1.2 s, with the sync part at about 0.15 s, or about 0.35 s when the check of step 1 runs at launch. [inference: the sum of the parts above; not run.]

## Accepted risk

A launch within 30 s of a merge that the owner makes on GitHub starts from the old `main`, with the old `AGENTS.md` in the system prompt for that session. We accept it. It can be undone: CI runs on every pull request (`.github/workflows/ci.yml:3-4`), GitHub refuses a merge with conflicts [inference: GitHub's default, not read today], and an agent syncs and rebases when its branch needs the current `main` (`../../AGENTS.md`, "Work a change"). The next launch after the next refresh gets the new rules.

## Rejected

- **A hook at the first turn that syncs and moves the worktree.** omp loads `AGENTS.md` into the system prompt at start, so the session keeps the old rules unless the hook rebuilds the prompt. It needs a second PR in the config repo, a guard against later turns and subagents, and a timeout for a failed sync. The owner chose the timer.
- **No sync at launch; the agent syncs first.** The same stale-rules gap, and a rule in `AGENTS.md` is a request, not a control.
- **A fetch after each session exits.** In `agent-start` it moves the wait to the exit (`start_omp` ends in `exit 0`, `agent-start:20`); in the background under sshd it can be killed. It also misses the owner's merges on GitHub.
- **A GitHub webhook.** It needs a public address or an outside relay that sees the repo's events.
- **A session started ahead of time.** Its `main` and config are stale before use, and it holds resources all day.

## Cost

GitHub: the check of step 1 is a git operation. "Git operations do not consume part of your API rate limit" (GitHub support, quoted in https://github.com/orgs/community/discussions/44515, read 2026-11-08; not an official doc). The read-only token adds about one token request per repo per hour, against at least 5,000 API requests per hour per installation and 2,000 token requests per hour per app (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api, read 2026-11-08). CPU: about 0.09 s per check, so about 4 to 5 minutes a day per repo at one check every 30 s.

Code: `host/gh-broker/server.ts` (timer, check, local sync, queue), `host/gh-broker/github-app.ts` (read-only token), `host/gh-broker/protocol.ts` (`have`, the "unchanged" reply), `host/gh-broker/client.ts` (send `have`, accept "unchanged"), `host/agent/agent-start` (the copy). One PR. The owner merges it and runs `host/bin/ug-setup` once.

Docs: `../SPEC.md` B3 and B4 (the copy and the sync, and their line numbers), `../THREAT-MODEL.md` (a line for the new `have` input from the agent, and this accepted risk).

## Checks before merge

- Broker tests: "unchanged", a delta bundle, the full bundle for an unknown `have`, a `have` that is not a commit (refused), a timer fetch and a sync at the same moment, a check older than 40 s that runs the GitHub check first.
- Facts already run with real git (agent run, 2026-11-08): a delta bundle imports into a clone that has the base; `git bundle create` refuses an empty bundle (`Refusing to create empty bundle`) and an unknown base (`bad object`); a clone without the base refuses the import (`Repository lacks these prerequisite commits`).
- Not run yet: a push with the read-only token fails; the race of step 5 over the network; the full launch timing after setup. The owner reruns the timing test of 2026-11-08 after setup.
- A throwaway check that an edit by the agent to a staged skill is gone after the next start (U6).
