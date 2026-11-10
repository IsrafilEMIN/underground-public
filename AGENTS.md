# AGENTS.md

## North star

The agent works like a coworker. The owner and the agent do the design together; the agent turns each ready ticket into a merged change on its own. Whatever the agent does without the owner's approval, in either way of working, the owner can undo.

## Redesign phase

Owner decision, 2026-11-07. We are redesigning the architecture from the problem up. The code and most docs describe the srt design: the arena, the zones, the wrapper, and srt as the sandbox. That design is wrong in part, so nothing in it is the base of the new one.

- Given: the north star, the gate, and the scope (`docs/PRODUCT-BRIEF.md`, "User and scope"). Everything else is open.
- Decide the base first: the harms that cannot be undone, what the agent needs to do its work, and the mechanism that handles both. Only then look at what exists.
- What exists is aid, not anchor: the code, the ADRs, the brief's principles, zones, and flows, the spec's build rows, and the threat model's controls. Take a part in only when the new base needs it, and change it to fit that base.
- A part does not stay because it exists, is built, or works today. A "kept", "stays", or "gone" line in a doc is a candidate until the base is decided.
- Argue a design choice from the problem, a threat, or evidence, never from today's code or an earlier ADR alone.
- The threat model's rows are a checklist for the new base: it handles each irreversible row or accepts it by name. The list can change with the base.

The old docs still say what today's code does. Read them for that, not for the new design. A change to the architecture starts here, not from `docs/SPEC.md`.

The base is decided and recorded (owner decisions of 2026-11-10). `docs/PRODUCT-BRIEF.md` holds it: the harms that cannot be undone, what the agent needs to do its work, and the mechanism that handles each harm or accepts it by name. `docs/SPEC.md` says what runs now, with no history. Of the earlier design, the merge gate is deleted (owner decision, 2026-11-10, `docs/adr/0026-delete-the-merge-gate.md`); the gh-broker, auto merge, and a merge queue stay open, in redesign.

## Where to look

Open a file only when the task needs it. Each doc has one job; do not start a second home for a fact.

- `docs/PRODUCT-BRIEF.md`: the base: the problem, scope, north star, the gate, the harms that cannot be undone, what the agent needs to do its work, and the mechanism that handles each harm or accepts it by name. Open it when a decision touches scope or a harm.
- `docs/SPEC.md`: what runs now, the onboarding checks, the checks that run, and what is deferred. No history. Open it before you plan or test a change, and when a change touches a workflow file, the repo settings, or the gh-broker app.
- `docs/THREAT-MODEL.md`: the threat checklist: each row with its control today, or its acceptance by name. Open it when a change touches the sandbox or the gh-broker.
- `docs/HOST-STATE.md`: the map of host files outside the repo and who writes them, and how a change reaches the running system. It names `host/facts` and `host/services` instead of copying values. Open it when a change touches a host path, a launchd job, or a file the owner writes by hand.
- `docs/adr/`: a dated record of why a decision was made, never the source for today's state. Open an ADR when you change the thing it covers.
- `GLOSSARY.md`: the live terms. Open it when you write docs.
- `host/facts` and the service table (`host/services`): the only homes of each shared host value and of the launchd job list. Code reads them; docs name them. A value in a doc is a second home and a future lie.

## The gate

Before each decision, the agent and the owner ask: does this bring us closer to the north star, or further away? It does only if it stops an irreversible harm, or keeps undo and work possible. If not, it waits.

Keep it as simple as possible, as complicated as needed.

## Work a change

Read `origin` with `git remote get-url origin`. Extract `<owner/repo>` from its GitHub SSH or HTTPS URL, without `.git`. Use that value in every command below. Do not copy a repo name from another checkout.

Each session starts in its own worktree on a `wt/<timestamp>` branch, which omp made from the clone's `origin/main` at start and removes at exit when nothing is in it. The clone is the agent user's `~/work/<owner>/<repo>` (`host/agent/agent-start`). Read the branch with `git branch --show-current`. If the cwd is the clone and not a `wt/*` worktree, stop and tell the owner: `/wt` moves the session into one. Never check out, commit, or edit in the clone, and do not touch the worktrees of other sessions.

1. Commit in your worktree.
2. Push: `gh-broker push <owner/repo> wt/<name>`.
3. Open one PR for the branch: `gh-broker pr-create <owner/repo> wt/<name> <title> <body>`. To update it, push the same branch again.
4. Check status with `gh-broker pr-status <owner/repo> <n>`. If a CI check failed, `gh-broker ci-log <owner/repo> <n>` shows its failed steps; fix them on a new head and push again. When CI is green, report the PR link to the owner, who merges on GitHub.
5. After the owner merges on GitHub, the gh-broker deletes the remote branch within 30 s, unless the branch moved. Your own worktree stays until a later session start sweeps it. The sweep keeps a worktree or branch with unsaved files or commits not in main, and lists it in `ug-kept.json` in the clone's git folder (`git rev-parse --git-common-dir`). Before it removes a worktree, it moves the worktree's ignored files to `ug-held/` in that folder, where they stay 14 days.

When the owner asks to review the kept branches, read `ug-kept.json` and show each branch with what it holds. Then do what the owner picks for each one: push it and open a PR, or park it with `git config branch.<name>.ugParked true`. A drop is not built yet: the guard blocks the forced delete it needs (`docs/adr/0020-state-based-branch-cleanup.md`, "Decision", item 4), so report the branch to the owner.

When the branch needs the current `main`, for a rebase, a conflict, or a PR that GitHub cannot merge: `gh-broker sync <owner/repo>`, then `git rebase origin/main` in your worktree.

If the gh-broker refuses, stop and report the exact error. Never run `host/bin/ug-setup`: it changes the host, and only the owner runs it.

There are no reviewer sessions. A reviewer is a skill (`docs/adr/0011-one-agent-arena.md`, "One trust level"). It reads a PR with `gh-broker sync <owner/repo> --pr <n>`.

On underground itself, GitHub refuses every merge to `main` without the owner's approval, and a push after an approval needs a new one (`docs/adr/0021-github-holds-the-wall-on-main.md`). `host/bin/ug-setup` checks that rule before it pulls.

## Evidence

Mark each claim in a doc, a commit message, a PR body, or a review reason with a source: a file of this repo with the name that holds the fact (`` (`ug_trusted_daemon`, `host/lib/ug.bash`) ``; for a doc, its section), command output, or a doc URL with the read date. Cite a section of a repo doc by its exact heading or bold label, `` `docs/SPEC.md`, "Backup" ``, or by a row id of that doc, `` `docs/THREAT-MODEL.md`, U14 ``. Do not cite a line number of a file in this repo: a name survives an edit, and a line number does not. A file outside this repo keeps its line, with its version or read date. `scripts/check-doc-citations.mjs` enforces these forms in the docs and in the messages in `host/` and `scripts/`. Otherwise mark the claim `[inference]`. In a chat reply, name a source only for a claim the owner may want to check, and say plainly when a claim is a guess.

Give host commands one per line, without `#` comments.

The owner never runs host tools (git, editors, direnv) in the agent user's home `/Users/ugagent`: agents write all of it. Agent work reaches the owner only through GitHub.
