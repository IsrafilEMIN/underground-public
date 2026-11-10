# Branch and worktree cleanup follows the state of main, not the merge

Date: 2026-11-09. Status: built, not run on the owner's mac. Owner decisions of 2026-11-08 and 2026-11-09, in the session that built it: the cleanup must not depend on who merges or on a GitHub setting; the gh-broker owns the end of the branches it pushed; the agent side owns the local worktrees and branches; a clean worktree that nobody uses and whose work is in main goes; the start must not get slower; the owner sees the kept branches as one notice at session start.

## Context

Only `gh-broker merge` cleaned up a merged branch: it deleted the head branch on GitHub, dropped the push record, and removed the local worktree and branch (`cleanUpMergedBranch` in `host/gh-broker/server.ts` and `cleanUpLocal` in `host/gh-broker/client.ts`, before this change). omp removes a session worktree at exit only when it has no change and no commit, and never one with commits (`0011-one-agent-arena.md`, amendment "worktrees"). The owner merges underground on GitHub, by design (`../SPEC.md`, onboarding check 6), and `gh-broker merge` refuses every PR until the reviewer skills write verdicts (`../../AGENTS.md`). So no cleanup ran. On 2026-11-08 the clone held 37 `wt/*` worktrees (agent run, `git worktree list`): 19 never got a commit, so omp's exit cleanup did not run for them, and the rest were merged. The push records of those branches stayed too.

## Decision

One rule for every store: delete a thing only when its work is in main, nobody uses it, and it still is what the check saw. Each store has one writer, so each writer runs the rule for its own store.

1. **The gh-broker ends the branches it pushed.** Each 30 s refresh, and right after a merge through the gh-broker, it checks every push record of the repo (`refreshRepo`, `endMergedBranch`, `host/gh-broker/server.ts`):
   - The recorded commit is not in the gh-broker's copy of main: nothing happens.
   - The branch on GitHub is at another commit: the branch and its record stay. A new push after the merge writes a new record, so it stays too.
   - The branch is gone, for example because GitHub deleted it at the merge: the gh-broker drops the record. It uses only the read-only token.
   - The branch is at the recorded commit: the gh-broker deletes it with `--force-with-lease` on that commit, then drops the record.
   - A record is dropped only when it still holds the checked commit (`dropPushRecord`, `host/gh-broker/push-record.ts`). A failed step keeps the branch and the record, and the next refresh tries again.
   - The check runs in the repo's queue, the same queue as `push`, so no push lands between the check and the delete.
   - The refresh keeps the 7-day launch rule of `0019-fast-launch-sync.md`. A repo with a push record but no launch in 7 days gets one refresh after each start of the gh-broker, so a restart does not hide a merged record (`refreshRepos`, `host/gh-broker/server.ts`). After that, its records wait for the next launch of the repo.
2. **`gh-broker merge` has no cleanup of its own.** After the merge it runs the same refresh for the repo and adds its result to the reply (`handleMerge`, `host/gh-broker/server.ts`). A failed cleanup does not fail the merge. Then the client syncs main and runs the local sweep (`afterMerge`, `host/gh-broker/client.ts`).
3. **The agent side sweeps the clone.** `gh-broker sweep <default-branch>` (`sweep`, `host/gh-broker/sweep.ts`) runs in the background at each session start, after the sync and the checkout (`sweep "$base"`, `host/agent/agent-start`), so the start does not wait for it. It takes no lock: it writes neither `origin/*` nor the clone's checkout, and each delete names the commit it checked. For each `agent/*` or `wt/*` branch, except the one the clone has checked out and a locked worktree:
   - It first drops the entries of worktrees whose folder is gone (`git worktree prune`).
   - Younger than 10 minutes, by the branch's first reflog entry or the worktree's `.git` file: skip, so a session that is starting keeps its new worktree.
   - A process has its working folder in the worktree (`lsof -d cwd`, `lsofProbe`, `host/gh-broker/sweep.ts`): skip. If the probe fails, every worktree counts as used.
   - Uncommitted or untracked files: keep, listed as "unsaved files".
   - Ignored files: no reason to keep. `git worktree remove` deletes ignored files (`git help worktree`, "remove", read 2026-11-08), and a `.env` or a notes file can exist only there. So before the removal, the sweep moves them to `ug-held/<ms>-<branch>/` in the clone's git folder, and a later sweep deletes them there after 14 days (owner decision, 2026-11-10; `0024-state-over-incident-lists.md`). Before that, the sweep kept the worktree, listed as "ignored files", unless every ignored file was under a name in a cache list.
   - Its commits are not in `origin/<default>`: keep, listed as "not in main". A squash merge lands here.
   - Otherwise: `git worktree remove` without `--force`, then `git update-ref -d` with the checked commit.
4. **The kept list.** The sweep writes the kept branches, each with its reason, to `ug-kept.json` in the clone's git folder. A branch with `branch.<name>.ugParked=true` stays in the list, marked parked. The agent reads the list when the owner asks, and can push or park a kept branch. Not built yet:
   - The notice at session start. It would be an extension in the owner's config repo, and the agent gets no access to that repo (owner decision, 2026-11-09). So the notice is not built; the agent reads the kept list when the owner asks.
   - A drop of a kept branch. A kept branch is dirty or not in main, so its drop needs `git worktree remove --force` or `git update-ref -d`, and the guard extension blocks both in a session (`underground-guard.ts`, "destructive git"). How the owner approves a drop is open.

## The gate

The rule deletes only what is in main, or in the case of an empty worktree, a copy of a main commit. Every delete names the commit it checked, so a branch that moved stays. A doubt keeps the thing: a failed probe, a young worktree, an ignored file, a commit outside main.

## Cost

- The refresh can now mint a token that writes, which `0019-fast-launch-sync.md` (decision 2) kept out of it. It mints one only to delete a branch whose recorded commit is in main and that is still at that commit. A refresh with nothing to delete still uses only the read-only token (`tests/broker/branch-cleanup.test.ts`).
- A repo with a push record and no launch for 7 days keeps its merged branch on GitHub until its next launch or the next start of the gh-broker.
- A session that merges keeps its own worktree until a later start sweeps it, because it is young and in use. The old merge cleanup removed it at once.
- A resumed session whose worktree the sweep removed opens in the clone (already accepted, `0011-one-agent-arena.md`, "Known holes").
- Files written in a worktree after the last daily backup at 20:00 are not in the backup. The sweep never deletes a worktree that holds such files, unless they are caches.

## Evidence

- `tests/broker/branch-cleanup.test.ts`: a merge through the gh-broker, a merge on GitHub then a refresh, an unmerged branch, a branch GitHub deleted, a branch another writer moved, a push after the merge, a failed cleanup.
- `tests/broker/sweep.test.ts`: merged and clean, unsaved, ignored and cache files, not in main, young, in use, probe failure, missing folder, parked, other branches, no `origin/<default>`.
- `tests/broker/client.test.ts`: the merge, then the sync, then the sweep.
- Agent run, 2026-11-09: `lsofProbe` inside the pin listed this session's working folder and 14 folders under `~/.omp/wt/`.
- Not run: a sweep of the real clone, and the notice on the owner's screen.
