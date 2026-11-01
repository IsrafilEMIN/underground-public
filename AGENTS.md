# AGENTS.md

## North star

An unattended agent can only do harm that you can undo.

## Where to look

Open a file only when the task needs it.

- `docs/PRODUCT-BRIEF.md`: the problem and why. Open it when a decision touches scope.
- `docs/SPEC.md`: what MVP 0.5 builds, and "good enough". Open it before you plan a change.
- `docs/TEST-PLAN.md`: how we check the build before the live run. Open it before you test a build item.
- `docs/THREAT-MODEL.md`: the threats, split by underground and arkan, and by MVP. Open it when a change touches the sandbox, the broker, or the merge gate.
- `docs/ONBOARDING.md`: the owner's checks on GitHub for each repo before agents merge alone in it. Open it when a change touches a workflow file, the repo settings, or the broker app.
- `docs/adr/`: why we built a thing one way. Open an ADR when you change the thing it covers.
- `GLOSSARY.md`: the terms. Open it when you write docs.

## The gate

Before each decision, the agent and the owner ask: does this bring us closer to the north star, or further away? It does only if it stops an irreversible harm, or keeps undo and work possible. If not, it waits.

Keep it as simple as possible, as complicated as needed.

## Work a change

Read `origin` with `git remote get-url origin`. Extract `<owner/repo>` from its GitHub SSH or HTTPS URL, without `.git`. Use that value in every command below. Do not copy a repo name from another checkout.

1. Make your own worktree: `git worktree add -b agent/<name> "$OMP_WORKTREE_DIR/<name>" origin/main`. Use a `<name>` that no branch and no folder uses. Do not touch the worktrees or branches of other sessions.
2. Get `main`: `broker sync <owner/repo>`, then `git rebase origin/main`.
3. Push: `broker push <owner/repo> agent/<name>`.
4. Open one PR for the branch: `broker pr-create <owner/repo> agent/<name> <title> <body>`. To update it, push the same branch again.
5. Check status with `broker pr-status <owner/repo> <n>`. If a CI check failed, `broker ci-log <owner/repo> <n>` shows its failed steps; fix them on a new head and push again. The broker merges only an auto PR: green CI, the head that the broker pushed, no hold, and a `pass` on the head from `code-review`, `security-review`, and `risk-review`. Then merge: `broker merge <owner/repo> <n>`. The owner merges every other PR on GitHub. If `broker merge` refuses with a hold, report the PR and the reason to the owner, and stop.
6. After `broker merge`, the broker deletes the remote branch, or finds it gone already. Then `broker` removes your worktree and local branch, if the branch still points at the merged commit and the worktree has no uncommitted change. Run `broker merge` from your worktree or from the repo folder; the cwd can be the worktree that it removes. If the merge reply says that the broker kept a branch or a worktree, report that to the owner. A PR that the owner merges on GitHub keeps its remote branch until GitHub deletes it (the repo setting "Automatically delete head branches") or the owner deletes it there; clean up its local worktree and branch as below.

`git branch -d` deletes a branch only if `HEAD` contains it. `broker sync` updates `origin/main`, but not the local `main`. So run `git branch -d` only in a worktree that contains `origin/main`, never in the repo folder.

A session often ends before the owner merges its PR. So at the start of each session, after steps 1 and 2, clean up each merged branch that still has a local worktree or branch. A local `agent/<name>` branch is merged when `git log origin/main --merges --format=%s` shows `Merge pull request #<n> from <owner>/agent/<name>`, with `<owner>` from the repo identity above. This cleanup also applies to merged branches of other sessions. Find the worktree path of the branch with `git worktree list`, because another session can use another `$OMP_WORKTREE_DIR`. Run `git worktree remove <path>`. Then, in your worktree, run `git branch -d agent/<name>`. If the branch has no worktree, run only `git branch -d`.

If the broker refuses, stop and report the exact error. Never run `install.sh` or `ug-install`.

A reviewer session (`omp --role <name>`, where the roles table maps the name to `code-review`, `security-review`, or `risk-review`) does not follow this file. The owner starts it in the repo folder, and the wrapper starts it new in its store folder `~/.ug/git/<name>`, never in a checkout, and refuses `--resume`, `--continue`, `--session`, and the other resume flags. It follows only the owner's rules of its role, `~/.agents/roles/<role>/AGENTS.md`, which the wrapper passes with `--append-system-prompt`. It gets the PR with `broker sync <owner/repo> --pr <n>` and reads it only with `git -C "$UG_REVIEW_STORE"` (`log`, `diff`, `show`). It never runs PR code: no build, test, install, or tool that loads PR code or config. It writes its verdict with `broker review`.

## Evidence

Mark each claim in a doc, a commit message, a PR body, or a review reason with a source: `file:line`, command output, or a doc URL with the read date. Otherwise mark it `[inference]`. In a chat reply, name a source only for a claim the owner may want to check, and say plainly when a claim is a guess.

Give host commands one per line, without `#` comments.

The owner never runs host tools (git, editors, direnv) in `~/.omp/wt`, in the omp root `~/.ug/omp` outside its owner part `agent` (`underground/cache`, `underground/tmp`, `underground/state`, and the sessions folder `agent/sessions`), or in the reviewer stores `~/.ug/git`. Agents write these folders. Agent work reaches the owner only through GitHub.
