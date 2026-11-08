# AGENTS.md

## North star

The agent works like a coworker. The owner and the agent do the design together; the agent turns each ready ticket into a merged change on its own. Whatever the agent does without the owner's approval, in either way of working, the owner can undo.

## Redesign phase

Owner decision, 2026-11-07. We are redesigning the architecture from the problem up. The code and most docs describe the srt design: the arena, the zones, the wrapper, and srt as the sandbox. That design is wrong in part, so nothing in it is the base of the new one.

- Given: the north star, the gate, and the scope (`docs/PRODUCT-BRIEF.md`, user and scope). Everything else is open.
- Decide the base first: the harms that cannot be undone, what the agent needs to do its work, and the mechanism that handles both. Only then look at what exists.
- What exists is aid, not anchor: the code, the ADRs, the brief's principles, zones, and flows, the spec's build rows, and the threat model's controls. Take a part in only when the new base needs it, and change it to fit that base.
- A part does not stay because it exists, is built, or works today. A "kept", "stays", or "gone" line in a doc is a candidate until the base is decided.
- Argue a design choice from the problem, a threat, or evidence, never from today's code or an earlier ADR alone.
- The threat model's rows are a checklist for the new base: it handles each irreversible row or accepts it by name. The list can change with the base.

The old docs still say what today's code does. Read them for that, not for the new design. A change to the architecture starts here, not from `docs/SPEC.md`.

## Where to look

Open a file only when the task needs it.

- `docs/PRODUCT-BRIEF.md`: the problem and why. Open it when a decision touches scope.
- `docs/SPEC.md`: what MVP 0.5 builds, the onboarding checks, and the checks of the build. Open it before you plan or test a change, and when a change touches a workflow file, the repo settings, or the broker app.
- `docs/THREAT-MODEL.md`: the threats, split by underground and arkan, and by MVP. Open it when a change touches the sandbox, the broker, or the merge gate.
- `docs/adr/`: why we built a thing one way. Open an ADR when you change the thing it covers.
- `GLOSSARY.md`: the terms. Open it when you write docs.

## The gate

Before each decision, the agent and the owner ask: does this bring us closer to the north star, or further away? It does only if it stops an irreversible harm, or keeps undo and work possible. If not, it waits.

Keep it as simple as possible, as complicated as needed.

## Work a change

Read `origin` with `git remote get-url origin`. Extract `<owner/repo>` from its GitHub SSH or HTTPS URL, without `.git`. Use that value in every command below. Do not copy a repo name from another checkout.

Each session starts in its own worktree on a `wt/<timestamp>` branch, which omp made from the arena clone's `origin/main` at start and removes at exit when nothing is in it. Read the branch with `git branch --show-current`. If the cwd is the arena clone and not a `wt/*` worktree, stop and tell the owner: `/wt` moves the session into one. Never check out, commit, or edit in the clone, and do not touch the worktrees of other sessions.

1. Commit in your worktree.
2. Push: `broker push <owner/repo> wt/<name>`.
3. Open one PR for the branch: `broker pr-create <owner/repo> wt/<name> <title> <body>`. To update it, push the same branch again.
4. Check status with `broker pr-status <owner/repo> <n>`. If a CI check failed, `broker ci-log <owner/repo> <n>` shows its failed steps; fix them on a new head and push again. The broker merges only an auto PR: green CI, the head that the broker pushed, no hold, and a `pass` on the head from `code-review`, `security-review`, and `risk-review`. Then merge: `broker merge <owner/repo> <n>`. The owner merges every other PR on GitHub. If `broker merge` refuses with a hold, report the PR and the reason to the owner, and stop.
5. After `broker merge`, the broker deletes the remote branch, or finds it gone already. Then `broker` removes your worktree and local branch, if the branch still points at the merged commit and the worktree has no uncommitted change. Run `broker merge` from your worktree; the cwd can be the worktree that it removes. If the merge reply says that the broker kept a branch or a worktree, report that to the owner.

When the branch needs the current `main`, for a rebase, a conflict, or a PR that GitHub cannot merge: `broker sync <owner/repo>`, then `git rebase origin/main` in your worktree.

If the broker refuses, stop and report the exact error. Never run `host/bin/ug-setup`: it changes the host, and only the owner runs it.

There are no reviewer sessions: `omp --role` is gone (`docs/SPEC.md`, B8). A reviewer is a skill. It reads a PR with `broker sync <owner/repo> --pr <n>` and names its role in `broker review <owner/repo> <n> <sha> <role> <verdict> [reason]`. Until the merge gate gets its review, no skill writes a verdict, so `broker merge` refuses every PR and the owner merges each one on GitHub.

## Evidence

Mark each claim in a doc, a commit message, a PR body, or a review reason with a source: `file:line`, command output, or a doc URL with the read date. Otherwise mark it `[inference]`. In a chat reply, name a source only for a claim the owner may want to check, and say plainly when a claim is a guess.

Give host commands one per line, without `#` comments.

The owner never runs host tools (git, editors, direnv) in the arena `~/.ug/home`: agents write all of it, and the arena wrapper refuses to start there. Agent work reaches the owner only through GitHub.
