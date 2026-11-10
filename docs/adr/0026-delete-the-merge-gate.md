# 0026. Delete the merge gate

Status: Accepted (owner, 2026-11-10). Supersedes the decision of `0006-reviewer-roles-gate.md` in full, and the auto-merge path of `0007-gh-broker-github-app.md`.

## Context

The merge gate was self-attested. `startServer` passed socket input to `handleRequest` with no check of the peer, so `handleReview` took a verdict of any role from any caller: one session could write all three `pass` verdicts and merge its own PR. An agent run on 2026-11-10 proved it: a throwaway test against the real server code with a fake `gh` made the gh-broker call `gh pr merge` (agent run, 2026-11-10). `0021-github-holds-the-wall-on-main.md`, "Context", item 2, had already named this hole on 2026-11-09 and left the gate standing as a quality helper. In practice the gate merged nothing: no reviewer skill wrote verdicts. The gate was about a fifth of the broker code (429 deleted lines of 2295 in `host/gh-broker/` before the change, agent run, `git diff --shortstat`, 2026-11-10) and two whole test files.

## Decision

1. **The `review` and `merge` verbs are gone.** The verbs are sync, push, pr-create, pr-status, and ci-log (`VERBS`, `host/gh-broker/protocol.ts`). `gh-broker merge` and `gh-broker review` answer "unknown verb". No agent path merges through the gh-broker.
2. **Review records, holds, the attempt limit, and protected paths are gone.** `review-records.ts` is deleted, with the merge refusal, the merge and review handlers, the holds, the attempt limit, and the protected paths. The client's after-merge sync and sweep are gone.
3. **Push records stay, used only by the branch cleanup.** After the owner merges a PR on GitHub, the refresh deletes the remote agent branch within 30 s unless it moved, and drops the record (`refreshRepos`, `host/gh-broker/server.ts`; `dropPushRecord`, `host/gh-broker/push-record.ts`). The sweep of worktrees stays (`sweep`, `host/gh-broker/sweep.ts`). `gh-broker sync <owner/repo> --pr <n>` stays.
4. **The owner merges every PR on GitHub.** On underground the GitHub ruleset needs the owner's approval and dismisses stale approvals (`0021-github-holds-the-wall-on-main.md`). The gh-broker app has no Workflows and no Administration permission (`0007-gh-broker-github-app.md`).
5. **Setup keeps the owner's data and stops feeding the gate.** Setup no longer copies the protected-paths lists into root's code folder (`code.new`, `host/bin/ug-agent-setup`). The one-time move of the old gh-broker folder still copies `reviews/` into the gh-broker user's home, so no record is lost (`old_broker`, `host/bin/ug-agent-setup`); nothing reads it. The owner's `protected-paths/` stays in the data folder, unread.

## Undo

A git revert of the change.

## Open

Auto merge and a merge queue stay in redesign.
