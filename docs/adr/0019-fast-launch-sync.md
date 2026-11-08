# Fast launch: the gh-broker keeps main current, the launch reads it locally

Date: 2026-11-08. Status: built, not run on the owner's mac. Owner decisions of 2026-11-08: the gh-broker refreshes each repo every 30 s; the refresh gets its own read-only token; a repo with no launch for 7 days drops out of the refresh; the first launch of a repo keeps the full sync.

## Context

A launch takes about 2 s from enter to a ready prompt. The parts, measured on 2026-11-08:

| Part | Time | Source |
|---|---|---|
| `ug-agent --version` in a repo (whole launch path, no TUI; the launcher before `0017-one-omp-binary-and-no-ug-folder.md`) | 1.34 s, 1.74 s | owner runs with `$EPOCHREALTIME` |
| `ug-agent --version` outside a repo (no sync) | 0.58 s | owner run |
| `gh-broker sync` alone | 0.96 s, 1.00 s, 1.24 s | agent run |
| config copy loop (`agent-start:33-37` before this change) | 0.25 s, 0.26 s, 0.28 s; 0.24 s, 0.27 s, 0.28 s in a fresh bash | agent runs |
| one `rm` plus one `cp -R` of the staged names (this change, `agent-start:33-41`) | 0.17 s, 0.18 s, 0.19 s in a fresh bash | agent runs |
| one copy of the whole config folder (`ditto`) | 0.08 s; it merges folders instead of replacing them, so it is not used | agent run |
| one GitHub round trip (`git ls-remote --symref <url> HEAD`) | 0.26 s, 0.28 s; 0.09 s CPU each over 10 runs | agent runs |
| `git bundle create` plus import of the full branch (900 KB) | 0.14 s | agent run |
| omp from start to ready (`--mode rpc`) | 0.26 s | agent run, `PI_DEBUG_STARTUP` |
| omp in the TUI: first log line to first skill compression | 0.2 s to 0.4 s | `~/.omp/logs`, owner launches of 2026-11-08 |
| terminal return after omp removes its worktree | under 0.02 s | agent-side watcher against owner timestamps |
| SHA-256 of the omp binary (`agent-start:16-19`, added by `0017-one-omp-binary-and-no-ug-folder.md`, not in the owner runs above) | 0.13 s, 0.18 s | agent runs |

So the sync was about half of the launch. It cost four steps in series, and two of them reached GitHub: `gh repo view` for the default branch (`defaultBranch`, `host/gh-broker/server.ts:200-208` before this change) and a fetch into the bare repo (`:237`). Then a bundle of the full branch history (`:239`) and the import in the clone (`importSync`, `host/gh-broker/client.ts:199-211`) ran on local disk. The config loop started about 60 processes, one `rm` and one `cp` per name.

The 30 skill description compression calls fail at each start (429 from the `smol` model), but omp starts them after the TUI is up and does not wait for them at exit (omp 18.18.1 bundle: `deferSkillDescriptionCompression`, `startSkillDescriptionCompression`, `void sd.waitForPending()`). They are not part of the wait.

## Decision

1. **The gh-broker refreshes main on a timer.** Every 30 s, for each repo synced in the last 7 days, the gh-broker runs `git ls-remote --symref <url> HEAD` (`refreshRepos` and `refreshMain`, `host/gh-broker/server.ts`). It returns the default branch and its commit in one round trip (agent run, 2026-11-08: `ref: refs/heads/main	HEAD`, then the commit). The branch name goes through the same check as before (`parseRemoteHead` with `isDefaultBranchName`, `host/gh-broker/protocol.ts`). When the commit differs from the copy's ref, the gh-broker fetches. A check counts as good only when the listing and any fetch it needed both succeeded; the gh-broker records the start time of each good check per repo, in memory. A repo with no sync for 7 days drops out; its next launch adds it back. A broker restart forgets every repo, so the first sync after it asks GitHub. Each timer check stops after 20 s (`REFRESH_TIMEOUT_MS`), so a stalled fetch holds the repo's queue for at most that long, and a failed check is logged, never thrown.
2. **The timer uses a read-only token.** The gh-broker mints it with `permissions: {"contents": "read"}` and caches it apart from the token that pushes and merges (`TokenScope`, `createAppTokens`, `host/gh-broker/github-app.ts`). Before, one token per repo had all of the app's permissions, because the request named only the repo, and GitHub gives such a token "all of the permissions that were granted to the app" (https://docs.github.com/en/rest/apps/apps, "Create an installation access token for an app", read 2026-11-08). The other verbs keep the app token. A sync that must ask GitHub uses the read-only token too.
3. **Only a launch sync reads the gh-broker's copy.** `agent-start` runs `gh-broker sync <repo> --cached` (`agent-start:59`). A plain `gh-broker sync`, as an agent runs it before a rebase (`../../AGENTS.md`, "Work a change"), always asks GitHub first, so it gets the main of that moment; it is still faster than before, with one GitHub call and no full history. After a merge through the gh-broker, the copy no longer counts as current, so the next launch asks GitHub. Either way the client sends the commits of its `refs/remotes/origin/*` refs, without `origin/pr/*`, as `have` (`originHeads`, `host/gh-broker/client.ts`). The gh-broker accepts at most 16 full 40-hex commits, and `cached` only as `true` (`MAX_SYNC_HAVES`, `validateRequest`, `host/gh-broker/protocol.ts`). For a `--cached` sync within 40 s of its last good check, it answers from local disk: no bundle when a known `have` already contains the branch commit, else a bundle of `refs/heads/<branch>` minus the known `have` commits, else the full bundle. If the last check is older or missing, as after a broker restart, a wake from sleep, or a merge, it first runs the check of step 1 once. Every reply names the branch and its commit; the client sets `origin/<branch>` to that commit and refuses when the result differs. When an import fails, the client asks once more with no `have` and imports the full bundle. It prints the same line as before, `origin/<branch> is now <commit>`, so `agent-start:63`, the setup wizard, and the tests that read it do not change.
4. **The first launch of a repo keeps the full sync.** A new clone has no `origin/*` ref (`agent-start:51-57`), so the client sends an empty `have` and gets the full bundle, as before.
5. **One queue per repo.** Every write to a repo's copy runs through one promise chain per repo: the timer check, a sync, `sync --pr`, and push (`inRepoQueue`, `host/gh-broker/server.ts`). The branch cleanup after a merge writes nothing in the copy, so it stays outside. Before, the gh-broker had no lock, queue, or mutex, so a timer fetch and a sync could move `refs/heads/main` at the same moment.
6. **The config copy is two commands.** `agent-start` deletes every name in `config-names` with one `rm`, then copies the staged names with one `cp -R` (`agent-start:33-41`). The reset of the agent's own config at each start stays (`../THREAT-MODEL.md`, U6). A hash compare is not used: hashing both sides took 0.15 s and 0.19 s, as long as the copy (agent runs, 2026-11-08).

Expected result: a launch of about 1.1 s to 1.3 s, with the sync part at about 0.15 s, or about 0.35 s when the check of step 1 runs at launch. The sum includes the 0.13 s hash of the omp binary. [inference: the sum of the parts above; not run.]

## Accepted risk

A launch within 30 s of a merge that the owner makes on GitHub starts from the old `main`, with the old `AGENTS.md` in the system prompt for that session. We accept it. It can be undone: CI runs on every pull request (`.github/workflows/ci.yml:3-4`), GitHub refuses a merge with conflicts [inference: GitHub's default, not read today], and an agent syncs and rebases when its branch needs the current `main` (`../../AGENTS.md`, "Work a change"). The next launch after the next refresh gets the new rules.

## Rejected

- **A hook at the first turn that syncs and moves the worktree.** omp loads `AGENTS.md` into the system prompt at start, so the session keeps the old rules unless the hook rebuilds the prompt. It needs a second PR in the config repo, a guard against later turns and subagents, and a timeout for a failed sync. The owner chose the timer.
- **No sync at launch; the agent syncs first.** The same stale-rules gap, and a rule in `AGENTS.md` is a request, not a control.
- **A fetch after each session exits.** In `agent-start` it moves the wait to the exit (`start_omp` ends in `exit 0`, `agent-start:25`); in the background under sshd it can be killed. It also misses the owner's merges on GitHub.
- **A GitHub webhook.** It needs a public address or an outside relay that sees the repo's events.
- **A session started ahead of time.** Its `main` and config are stale before use, and it holds resources all day.

## Cost

GitHub: the check of step 1 is a git operation. "Git operations do not consume part of your API rate limit" (GitHub support, quoted in https://github.com/orgs/community/discussions/44515, read 2026-11-08; not an official doc). The read-only token adds about one token request per repo per hour, against at least 5,000 API requests per hour per installation and 2,000 token requests per hour per app (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api, read 2026-11-08). CPU: about 0.09 s per check, so about 4 to 5 minutes a day per repo at one check every 30 s.

Code: `host/gh-broker/server.ts` (timer, check, local sync, queue), `host/gh-broker/github-app.ts` (read-only token), `host/gh-broker/protocol.ts` (`have`, `parseRemoteHead`, the reply with `head` and an optional bundle), `host/gh-broker/client.ts` (send `have`, import or set the ref, retry once), `host/agent/agent-start` (the copy). One PR. The owner merges it and runs `host/bin/ug-setup` once, which installs the client and restarts the gh-broker. A launch while setup runs can meet a new client and an old gh-broker; the old one ignores `have` and sends no `head`, so that one sync fails, and the next launch works.

Docs: `../SPEC.md` B3 and B4, `../THREAT-MODEL.md` (the agent user table: the new `have` input and this accepted risk).

## Checks

- Broker tests (`tests/broker/sync-pr.test.ts`): a second sync gets no bundle; a `--cached` sync within 40 s gets the copy, after 40 s the gh-broker asks GitHub and sends only the new commits; a plain sync asks GitHub even 1 s after a check; a refresh lets the next `--cached` sync skip GitHub; the refresh asks only with the read-only token and skips a repo with no sync for 7 days; a refresh and a sync at the same moment both succeed; an unknown `have` gets the full history; `have` refuses `--all`, `^<sha>`, a short sha, 17 shas, and a PR sync, and `cached` refuses anything but `true`. `tests/broker/server-failures.test.ts`: an unreadable default branch from GitHub fetches nothing. `tests/broker/github-app.test.ts`: the read-only token request and its own cache. `tests/broker/flow.test.ts`, with a sync after a merge (`:466`), passed in a scratch copy whose fake `gh` ran under the pinned omp's bun (agent run, 2026-11-08: 14 pass, 0 fail); in the checkout it needs node, so CI runs it.
- Facts run with real git (agent run, 2026-11-08): a delta bundle imports into a clone that has the base; `git bundle create` refuses an empty bundle (`Refusing to create empty bundle`) and an unknown base (`bad object`); a clone without the base refuses the import (`Repository lacks these prerequisite commits`).
- A throwaway run of the new copy (agent run, 2026-11-08): an agent edit to a staged skill, a planted file in a staged folder, and a folder that the config lacks were gone after it; a file outside `config-names` stayed; the copy of the real staged config matched it (`diff -r`).
- Not run yet: a push with the read-only token, which GitHub should refuse; the race of step 5 over the network; shellcheck of `agent-start`, which is not on this mac, so CI runs it; the full launch timing after setup. The owner reruns the timing test of 2026-11-08 after setup.
