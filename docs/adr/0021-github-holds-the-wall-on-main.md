# GitHub holds the wall on underground's main, and setup checks it

Date: 2026-11-09. Status: built; the ruleset is active on GitHub; the setup check and the git login form are not run on the owner's mac. Owner decisions of 2026-11-09, in the session that built it: underground needs the owner's approval for every PR, enforced by GitHub and not by a list in the gh-broker; other repos keep the gh-broker's merge gate; setup checks the rule with the owner's `gh` login before it pulls.

## Context

Two findings of an agent scan, 2026-11-09, both confirmed in that session:

1. The installation token was on git's command line. `gitRemote` put it in the remote URL (`host/gh-broker/server.ts:209` before this change). From a pinned session, `/usr/bin/pgrep -lf x-access-token` in a loop during `gh-broker sync` printed the owner's `git`, `git remote-https`, and `git-remote-https` with the token URL (agent run, 2026-11-09; the token was masked before it reached the session output). `sync --pr` and `push` used the token that pushes and merges.
2. The merge gate is self-attested. `handleReview` takes a verdict of any role from any session (`host/gh-broker/server.ts:594`), so a session can write its own three `pass` verdicts.

Both are holes in one wall. The spec already decided that underground gets no auto merge and that the owner reads each change before the host runs it (`../SPEC.md`, onboarding check 6). Nothing enforced either part: the gh-broker was the only thing between an agent and `main`, and setup installs what `main` holds. It pulls `main` (`host/bin/ug-setup:46`), runs `tests/broker` and `tests/host` from that checkout as the owner (`run_mac_only_tests`, `:74`), and runs `ug-agent-setup` with `sudo` (`:307`). So a merge that skips the gh-broker reaches the owner's account and root, and a revert does not undo code that ran.

## Decision

A wall sits where the agent has no presence. GitHub holds the walls; the gh-broker is a helper that applies the owner's merge rules.

1. **A ruleset on underground's `main` needs the owner's approval for every merge.** A pull request with 1 approval, review from code owners, approval of the most recent push, stale approvals dismissed, the check `checks` from GitHub Actions, no force push, no deletion. The owner set it on 2026-11-09; the public API showed these rules that day (agent run, `curl https://api.github.com/repos/IsrafilEMIN/underground-public/rules/branches/main`). `.github/CODEOWNERS` holds `* @IsrafilEMIN`, so only the owner's approval counts. The app has no Administration permission (`0007-gh-broker-github-app.md`), so its token cannot change the ruleset. Neither a leaked token nor self-written verdicts merge without the owner.
2. **The class of a repo is a setting on GitHub, not a list on the mac.** A repo with this rule is owner-merged. A repo without it keeps the gh-broker's gate. Onboarding check 6 says which repos need the rule. A list in the gh-broker would be the same single wall again.
3. **Setup checks the rule before it pulls** (`ug_check_main_rule`, `host/lib/ug.bash:102`, called at `:63` before the fetch). It runs in the code of the last install, so a new `main` cannot remove it before it runs. It stops with "a wall is open" unless:
   - every line of the checkout's `CODEOWNERS` names only the `gh` login, and one line is `* @<login>`;
   - one active branch ruleset targets `main`, excludes nothing, and has the rules of point 1 (`ug_main_rule_gaps`, `:84`);
   - its bypass list holds only the repository admin role. The list needs the owner's login: the public API does not send `bypass_actors` (agent run, 2026-11-09).
   Setup therefore needs `gh` with the owner's login, and `jq`.
4. **The token leaves git's command line.** git gets the plain URL, and the token as `http.https://github.com/.extraheader` through `GIT_CONFIG_*` in its environment (`gitRemote`, `host/gh-broker/server.ts:201-219`). `actions/checkout` sends an installation token in the same form (`src/git-auth-helper.ts`, `main`, read 2026-11-09). `redactTokens` also removes the Base64 form (`host/gh-broker/github-app.ts:36`). With a rejected header, git prints `could not read Username` (agent run against github.com with a made-up token, 2026-11-09), so that text now counts as a 401 (`server.ts:64`).
5. **`sync --pr` uses the read-only token** (`server.ts:443`).

Agent run, 2026-11-09: a `sync` through the new `handleRequest` with a made-up token, against github.com, while `/usr/bin/pgrep -lf` ran in a loop. No git process of that run showed the token or its Base64 form; the reply was `could not read Username`, after one retry with a fresh token. The same loop caught the installed gh-broker's 30 s refresh with a real read-only token in its URL, so that token reached the session's output. It reads one public repo and ends within the hour.

## Not covered

- The check proves that the rule is on now, not that it was on since the last setup. Only the owner can turn the rule off. A step that shows the commits since the last install and waits for a yes is not built (proposal; the owner accepted the gap on 2026-11-09).
- Whether GitHub refuses a merge through the API with the app token under this rule is not tested. [inference] The app opens the PRs, and GitHub does not count an author's approval of their own PR.
- GitHub may not enforce rulesets on a private repo on a free plan [inference, not read in the docs on 2026-11-09]. `underground-public` is public.
- On the other repos a leaked token still merges without the gh-broker's checks. That is revertable there by onboarding check 5. A token for push only, and a shorter token life, are not built.
- The owner's own PR on underground needs the admin bypass, because an author cannot approve their own PR.
- The new login form has not run with a real installation token. If it fails after the install, the agent cannot push, and the owner reverts on GitHub.
