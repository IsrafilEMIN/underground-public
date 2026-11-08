# Three reviewer roles gate auto merge

Date: 2026-10-30. Owner decision.

Amended on 2026-11-02 by `0011-one-agent-arena.md`: the three reviewer roles stay, but as a quality step, not a safety wall. Their rules come as skills in the owner's config repo. The holds, attempts, and records stay as built until their review (`../SPEC.md`, Deferred).

Superseded in part on 2026-10-31 by `docs/adr/0007-gh-broker-github-app.md`: the gh-broker acts as a GitHub App, and the owner decided that `gh-broker merge` merges only the auto path. So the owner's approval no longer merges or ends a hold, and the owner change request is no longer checked. A hold refuses `gh-broker merge` for good, and the owner merges that PR on GitHub. The parts marked "superseded" below are the ones that changed.

The gate takes the latest verdict on the head from any reviewer (`mergeRefusal`, `host/gh-broker/protocol.ts:352`), and a review record had no role name in the first design (`ReviewRecord`, `host/gh-broker/protocol.ts:39`, which has `role` now). With more than one reviewer role, a `pass` from one role can merge a head that another role never saw (U10). The first design kept all verdicts in one file, `reviews.json`: each review rewrote it in full and each merge parsed it in full (`appendReviewRecord`, `host/gh-broker/review-records.ts:53`; `handleMerge`, `host/gh-broker/server.ts:433`). At hundreds of agents a day, each merge parses every record of every PR, and a damaged file stops every review and merge (`readReviewRecords`, `host/gh-broker/review-records.ts:31`). One file per PR bounds the parse to one PR and the damage to one PR; the records still grow in total, because they stay after the merge.

Decision:

- Three reviewer roles: `code-review` checks that the diff solves the task and is sound against the whole repo; `security-review` checks security; `risk-review` grades the PR as auto or manual.
- Auto merge needs a `pass` on the head from each of the three. A `block` binds to its head: the author fixes, and the new head needs a fresh `pass` from all three roles. A `manual` binds to the PR: only the owner's approval ends it. A changed protected path also needs the owner's approval of the head. (Superseded: nothing in the gh-broker ends a hold; the owner merges the PR on GitHub.)
- The author gets four attempts: three, then a step back to check that the implementation solves the task, then one last. A fourth head with a `block` holds the PR like a `manual`. Without it, an author that ignores its rule can push heads until a reviewer passes one by chance.
- No reviewer role can push or open a PR. The author fixes a finding.
- The gh-broker writes each verdict with its role name to one append-only file per PR on the host. The gate and `pr-status` read only that file. `pr-status` returns the verdicts and reasons, so the author can fix before the owner looks. Records stay after the merge.

Rejected: a reviewer pushes its fix. One agent then writes the code and judges it; a prompt injection in the PR can turn the fix into a backdoor.

Rejected: a same-head `pass` clears a `block`. A lenient or injected `pass` then overrides a finding. A newly reviewed head can pass.

Rejected: a `block` holds the PR until the owner approves, as today (`mergeRefusal`, `host/gh-broker/protocol.ts:352`). The owner then looks at every fixed PR, and the fix gets the same three reviews as any head.

Rejected: findings as PR comments. Any account with access to the repo can comment, author and reviewer post as the same bot, and a reason can disclose a security hole in public. A deleted comment stays in notifications and email.

Rejected: an advisory `code-review`. A logic bug can delete data or make payments, and a revert does not undo that (`docs/adr/0001-accepted-risks.md`).

Rejected: delete the records at merge. The records hold the head, reason, and time of each verdict that a revert needs to find.

Cost: the largest 0.5 build, with the deadline unchanged. The owner approves each PR that has a `manual`, a changed protected path, or four blocked heads. (Superseded: the owner merges each such PR on GitHub.)
