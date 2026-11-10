# The gh-broker acts as a GitHub App

Date: 2026-10-31. Owner decision.

Superseded in part by `0026-delete-the-merge-gate.md` (2026-11-10): the auto-merge path is gone; the app facts stand.

Holds under the redesign (2026-11-02). The key moves to `~/.ug/host/github-app.pem` (`../SPEC.md`, "gh-broker"). The onboarding list is now in `../SPEC.md`.

GitHub suspended the bot account that the gh-broker acted as. The cause is unknown. Until now, the gh-broker's token belonged to that bot (`ONBOARDING.md`, check 4, before this change), and the owner's approval of the head was a merge path of the gate (`docs/adr/0006-reviewer-roles-gate.md`). Earlier on 2026-10-31, the first version of this ADR moved the gh-broker to a fine-grained token of the owner's own account. The owner then chose a GitHub App instead.

Decision:

- The gh-broker acts as a GitHub App that the owner's personal account owns. The app is registered with "Only on this account", so no other account can install it, and with its webhook not active (S1).
- The owner installs the app with "Only select repositories": the repos that agents work in (S6).
- Repository permissions: Contents read and write, Pull requests read and write, Metadata read, Checks read, Commit statuses read. No Workflows permission and no Administration permission. Every other repository permission and every account permission stays at no access.
- The app's private key is `~/.ug/host/github-app.pem`, mode 600, owned by the owner's host user, in a folder with mode 700 (`appFiles`, `host/gh-broker/github-app.ts`). The gh-broker refuses a key file that another user can read or that the owner does not own (`readPrivateKey`, `host/gh-broker/github-app.ts`). The app config is `~/.ug/host/github-app.json`: `{"client_id": "...", "installation_id": ...}`; `installation_id` is optional. No sandbox, omp root, or session gets the key or a token.
- For each repo, the gh-broker signs an RS256 JWT with the key: `iat` 60 seconds ago, `exp` 9 minutes ahead, `iss` the client ID (`appJwt`, `host/gh-broker/github-app.ts`; S2). GitHub refuses an `exp` more than 10 minutes ahead (S2), so the gh-broker keeps one minute for host clock drift. It reads the installation from the config, or else from `GET /repos/{owner}/{repo}/installation`. Then `POST /app/installations/{id}/access_tokens` with `repositories` set to the request's repo, so each token reaches one repo (`createAppTokens`, `host/gh-broker/github-app.ts`; S3). A token lasts one hour (S3). The gh-broker keeps it in memory until 5 minutes before it expires (`REFRESH_BEFORE_MS`, `host/gh-broker/github-app.ts`). When a read fails with a 401, the gh-broker drops the token and runs the call once more with a new one. The reads are `gh repo view`, `gh pr view`, `gh api` GET, `git fetch`, and `git ls-remote`. A write (`gh pr create`, `gh pr merge`, `git push`) runs once, because it may have landed before the 401. A write's 401 still drops the token, so the next call gets a new one and not the revoked one (`asApp`, `host/gh-broker/server.ts`).
- `gh` gets the token in `GH_TOKEN`, with `GH_CONFIG_DIR` set to the empty folder `/var/empty`, so `gh` never uses a stored login (`EMPTY_GH_CONFIG`, `host/gh-broker/server.ts`). `git` reaches GitHub through `https://x-access-token:<token>@github.com/<repo>.git`, built for each call and with no credential helper (`gitRemote`, `host/gh-broker/server.ts`; S4, S5).
- The gh-broker removes every `ghs_` token from the stderr of `gh` and `git`, from the stdout that a reply passes on, and from its own errors, before a reply leaves it (`redactTokens`, `host/gh-broker/github-app.ts`; `forward`, `runChild`, and `asApp`, `host/gh-broker/server.ts`). The gh-broker parses the stdout before redaction, so a changed file named like a token still matches a protected path. Tokens are about 520 characters since GitHub's stateless format (`ghs_APPID_JWT`), so nothing in the gh-broker assumes a length (S3).
- The gh-broker merges only on the auto path: green CI, the head is the push record of its branch, no hold, and a latest `pass` on the head from `code-review`, `security-review`, and `risk-review`.
- Every other PR goes to the owner on GitHub: a `manual`, a changed protected path, a fourth blocked head, or a missing or non-`pass` verdict. `gh-broker merge` refuses it, and the owner merges it on GitHub by hand. Nothing in the gh-broker ends a hold.

What it changes:

- GitHub shows the gh-broker's pushes, PRs, comments, and merges as `<app slug>[bot]`, not as the owner. The commits that the gh-broker pushes are the agent's: their author and committer are what the agent's git wrote.
- The app is not the owner, so the owner can approve the app's PRs on GitHub. The gate still counts no approval: the owner keeps the auto path only, and merges every other PR on GitHub.
- Without Workflows, the app cannot add or change a file in `.github/workflows` (S4) (U28). Without Administration, it cannot change the repo settings or branch rules (U17).
- The app can still write every selected repo.

Accepted risks:

- A stolen private key acts as the app until the owner deletes that key on GitHub. App private keys do not expire (S5). The key is a file on the host, so any process of the owner's host user outside the sandbox can read it.
- [inference] While a call runs, the token is in the arguments of `git` and in the environment of `gh`. A process of the owner's host user can read them, and use the token for up to one hour on that one repo. No one has checked whether the sandbox lets a session read the arguments of other processes.
- It is unknown whether a flag on the app affects the account that owns it. GitHub documents nothing about it.
- The cause of the bot suspension is unknown, so the same activity can get the app flagged.

Rejected: a personal access token of the owner. A fine-grained token has no Checks permission, so the gh-broker cannot read check runs with it. A classic token with the `repo` scope reaches every repo of the account, and also its collaborators and webhooks. Both act as the owner: a flag on the token's activity hits the owner's main account, and the owner cannot approve the gh-broker's PRs.

Rejected: omp's native `github` tool in the session. The agent would hold the token and could skip the gate: merge, push to `main`, or change a PR without the gh-broker.

Supersedes: the owner's fine-grained token of the first version of this ADR, the bot account as the gh-broker's identity, and the owner-approval merge path and the owner change-request check in `docs/adr/0006-reviewer-roles-gate.md`.

Sources, read in their source in `github/docs` on the `main` branch, on 2026-10-31:

- S1: [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), steps "Active" and "Where can this GitHub App be installed?".
- S2: [Generating a JSON Web Token (JWT) for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), the claims table.
- S3: [Generating an installation access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), with the reusables `generate-installation-access-token` and `ghs-stateless-token-format`.
- S4: [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), "Choosing permissions for Git access".
- S5: [Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps), and [Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) for the `x-access-token` URL.
- S6: [Reviewing and modifying installed GitHub Apps](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps).

## Amendment 2026-11-08: paths

The app's private key is `~/.local/share/underground/github-app.pem`, beside its config `github-app.json`, in the data folder (`appFiles`, `host/gh-broker/github-app.ts`; `docs/adr/0017-one-omp-binary-and-no-ug-folder.md`). This replaces `~/.ug/host/github-app.pem` and `~/.ug/host/github-app.json` above.
