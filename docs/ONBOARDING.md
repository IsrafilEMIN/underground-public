# Onboarding list

The owner does these six checks on GitHub for each repo before agents merge alone in it. Do them again after a change to the repo settings, to a workflow file, or to the broker app. A repo is onboarded when every check passes.

The goal: merged code has no unattended path to an effect that a revert does not undo. Each check names its threat model rows (`THREAT-MODEL.md`).

In the paths below, `OWNER/REPO` is the repo, and **Settings** is the **Settings** tab under the repo name. Workflow files are at `https://github.com/OWNER/REPO/tree/main/.github/workflows`. Read each one on `main`.

## 1. Keep credentials out of `pull_request` jobs

Rows: U8.

Agent branches live in the repo, not in a fork. GitHub withholds secrets only from fork PRs, so a `pull_request` job on an agent branch gets every repo and organization secret (S1).

Where to look:

- **Settings** > **Secrets and variables** (in the "Security" section of the sidebar) > **Actions** > **Secrets** tab. The page also lists the environment secrets and the organization secrets that the repo can read (S1).
- The same page, **Variables** tab.
- Each workflow file: its `on:` triggers.

A pass:

- The **Secrets** tab lists no repository secret and no organization secret. An environment secret is allowed only in an environment that passes check 5.
- No variable holds a credential: no token, key, password, or URL with a password in it.
- No workflow runs on `pull_request_target` or `workflow_run`. These triggers run with the repo's secrets and a write token for events that a PR starts (S2, S3).

## 2. Keep the `GITHUB_TOKEN` read-only

Rows: U8.

Where to look:

- **Settings** > **Actions** > **General** > "Workflow permissions" (S4).
- Each workflow file: every `permissions:` key, at the top and in each job. A workflow file can raise the token's permissions above the default (S4).

A pass:

- "Workflow permissions" has **Read repository contents and packages permissions** selected.
- **Allow GitHub Actions to create and approve pull requests** is not selected.
- No workflow file has `id-token: write` or `write-all`. `id-token: write` lets a job get an OIDC token for a cloud account (S5).
- A job with any other `write` permission names an environment that passes check 5.

## 3. Use GitHub-hosted runners only

Rows: U9.

Where to look:

- **Settings** > **Actions** > **Runners** (S6). If the repo is in an organization, also check the organization's **Settings** > **Actions** > **Runners** (S6).
- Each workflow file: every `runs-on:` key (S7).

A pass:

- No page lists a self-hosted runner.
- Every `runs-on:` names a GitHub-hosted label, for example `ubuntu-latest`, and none names `self-hosted` (S7).

## 4. Give the broker app only the selected repos, with no Workflows and no Administration permission

Rows: U17, U28, U30.

The broker acts as a GitHub App that the owner's account owns, the broker app (`docs/adr/0007-broker-github-app.md`). Only the app's permissions and the repos of its installation limit what the broker can do on GitHub. `scripts/broker-github-app-wizard.sh` sets the app up.

Where to look, signed in as the owner:

- The installation: avatar > **Settings** > **Applications** (under "Integrations") > **Installed GitHub Apps**, then **Configure** next to the broker app (S17). The direct link is `https://github.com/settings/installations`. The page lists the app's **Permissions** and its **Repository access** (S17).
- The app itself: avatar > **Settings** > **Developer settings** > **GitHub Apps**, then **Edit** next to the broker app (S18). The direct link is `https://github.com/settings/apps/<app slug>`. Its **Permissions & events** page shows the permissions that the app asks for; [inference] its **Advanced** page offers **Make public** while only the owner's account can install the app.
- On the host, the key and the config:

```sh
ls -ld "$HOME/.config/underground-broker" "$HOME/.config/underground-broker/github-app.pem" "$HOME/.config/underground-broker/github-app.json"
```

A pass:

- **Installed GitHub Apps** lists the broker app once. Its **Repository access** is **Only select repositories**, and the list holds this repo and only the repos that agents work in.
- **Permissions** on the installation: read and write for **Contents** (code) and **Pull requests**; read for **Metadata**, **Checks**, and **Commit statuses**. Nothing else, so no **Workflows** and no **Administration**. No account permission.
- The app is private: only the owner's account can install it (S18). Its webhook is not active.
- On the host, the folder is `drwx------`, and `github-app.pem` is `-rw-------`, with the owner's host user as the owner of both. The downloaded copy of the key is gone, and no other copy is on the host.
- `broker sync OWNER/REPO` ends without an error, so the broker gets an installation token for the repo.

Without **Workflows**, the app cannot add or change files in `.github/workflows` (S19). On 2026-10-30, GitHub refused a push of the old bot token, which had no `workflow` scope (S13), that changed `.github/workflows/ci.yml` (`THREAT-MODEL.md`, U28). Without **Administration**, the app cannot change the repo settings or branch rules (U17).

## 5. Make each deploy wait for the owner

Rows: U10.

A merge to `main` starts the workflows that run on `push`. A revert restores the files, but not a deploy, a publish, or a use of a secret by that run.

Where to look:

- Each workflow file: every job that runs on `main` and deploys, publishes (a release, a package, a site), or reads a secret. Each such job has an `environment:` key.
- For each environment that a job names: **Settings** > **Environments** > the environment (S14).

A pass:

- Each such job names an environment.
- That environment exists, and **Required reviewers** is selected with the owner on the list. A workflow that names a missing environment creates it with no protection rules (S14).
- [inference] **Prevent self-review** can be on or off. The broker app merges, not the owner, so the owner does not start the run and can approve it either way. The broker app has no **Deployments** or **Actions** permission (check 4), so only the owner, by hand, approves a waiting deploy.
- If the repo is private and its plan is Free, Pro, or Team, GitHub has no required reviewers (S15). Then a pass means the repo has no such job.

## 6. Read the merged change before the host runs it

Rows: U10.

The host has no sandbox. A merged change runs there with the owner's rights when the owner installs it, builds it, tests it, or opens it with a tool that loads repo config, for example direnv.

Where to look: the compare view from the commit in the owner's repo folder to the commit that the host will run (S16):

```
https://github.com/OWNER/REPO/compare/<commit in the repo folder>..<commit to run>
```

`git -C <repo folder> rev-parse HEAD` prints the commit in the repo folder.

A pass: the owner reads every changed file in the compare view before the host runs code from the new commit.

## Sources

docs.github.com was not reachable from the sandbox. The pages below were read in their source: S1 to S16 in `github/docs` at commit `85c329847be78b0a7192b7c949beca23d38ca32f`, on 2026-10-30; S17 to S19 on the `main` branch of `github/docs`, on 2026-10-31.

- S1: [Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets), read 2026-10-30.
- S2: [Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), read 2026-10-30.
- S3: [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use), "Mitigating the risks of untrusted code checkout", read 2026-10-30.
- S4: [Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository), "Setting the permissions of the `GITHUB_TOKEN` for your repository", read 2026-10-30.
- S5: [OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc), read 2026-10-30.
- S6: [Removing self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/remove-runners), read 2026-10-30.
- S7: [Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), `jobs.<job_id>.runs-on`, read 2026-10-30.
- S13: [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), `workflow`, read 2026-10-30.
- S14: [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), read 2026-10-30.
- S15: [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), "Required reviewers", read 2026-10-30.
- S16: [Comparing commits](https://docs.github.com/en/pull-requests/how-tos/commit-changes/comparing-commits), read 2026-10-30.
- S17: [Reviewing and modifying installed GitHub Apps](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps), "Navigating to the GitHub App you want to review or modify" and "Reviewing permissions", read 2026-10-31.
- S18: [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), "Where can this GitHub App be installed?", read 2026-10-31.
- S19: [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), "Choosing permissions for Git access", read 2026-10-31.
