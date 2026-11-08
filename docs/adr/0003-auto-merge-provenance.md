# Auto merge needs the commit that the gh-broker pushed

Date: 2026-10-30. Owner decision.

Holds under the redesign (2026-11-02, `0011-one-agent-arena.md`).

Superseded in part on 2026-10-31 by `docs/adr/0007-gh-broker-github-app.md`: the gh-broker acts as a GitHub App, not a bot account, and the owner's approval no longer merges. So every `gh-broker merge`, not only an auto merge, needs the PR head to be the push record.

The gate accepts an `agent/*` branch in the same repo, but any account with write access can push to that branch (U29).

Decision: the gh-broker records the commit that it last pushed to each branch. Auto merge needs the PR head to be that commit. After the merge, the gh-broker deletes the branch only if it still points at the merged commit (a push with `--force-with-lease`), then drops the record.

What it adds: head-sha binding (U13) already voids every `pass` when the head changes, and the gh-broker pushes with `--force` (`handlePush`, `host/gh-broker/server.ts:295`), so the author's next push replaces a foreign tip instead of building on it. The gh-broker checks the pushed tip, not its ancestry (`handlePush`, `host/gh-broker/server.ts:294`), so a foreign commit stays only if the author imports it on purpose, and then the three reviewers see it in the diff. B4 guarantees one thing: the merged head is the last head that the gh-broker pushed. The one case it closes is a foreign head that all three reviewers pass.

Rejected: a check of the PR author. Another writer can push to a PR that the gh-broker opened, and the author stays the gh-broker's account (the bot, before ADR 0007; the owner, after it). Rejected: an onboarding check of the repo writers. It is checked once and can drift.
