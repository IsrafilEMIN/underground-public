# One omp root for every role

Date: 2026-11-01. Owner decision. Supersedes `0002-role-homes.md` (the role homes); its policy overlay and the list of pinned settings still hold.

Amended on 2026-11-01 by `0010-shared-sessions-and-state.md`: sessions and state are no longer per role name; every role uses one session folder and one state folder per repo.

Each role name had its own role home under `~/.ug`, with its own omp root, cache, state, temp folder, and reviewer stores. The owner decided to drop the per-role homes.

## Decision

Every role name uses one omp root, `~/.ug/omp` (`PI_CONFIG_DIR=.ug/omp`, `host/bin/omp:13`).

- Owner part `~/.ug/omp/agent`: `policy.yml`, `prefs.yml`, `models.yml`, `hooks/pre/concise-reply.ts`, and `hooks/pre/role-rules.ts`. The wrapper writes them from `~/.agents/roles` at each start (`make_omp_root`, `host/bin/omp`); `admin.ts gateway-setup` writes the one `models.yml`. `PI_CONFIG_FILES=~/.ug/omp/agent/prefs.yml:~/.ug/omp/agent/policy.yml`.
- Underground's folders sit in `~/.ug/omp/underground`, a name omp does not use under its root (omp docs, `config-usage.md`, `environment-variables.md`, `session.md`, `marketplace.md`, `install-id.md`, read 2026-11-01): the cache root `cache`, the temp folder `tmp` (`TMPDIR`), and the state folders `state/<role name>/<path hash>`.
- Sessions stay per role name: `~/.ug/omp/agent/sessions/<role name>/ug-<repo id>`.
- Reviewer stores move out of the omp root to `~/.ug/git/<role name>/<path hash>.git`, and a reviewer session starts in `~/.ug/git/<role name>`. srt 0.0.81 emits every write allow before every write deny, and Seatbelt takes the last match (`dist/sandbox/macos-sandbox-utils.js`, `generateWriteRules`), so a deny on `~/.ug/omp/underground/git` could not be reopened for one reviewer's own stores. Outside the omp root, each reviewer gets a write grant on its own folder only, as before, and no author grant covers it. Its working folder outside the omp root also keeps every role from planting an `AGENTS.md` or `.omp` folder in an ancestor that the reviewer's context walk reads.
- Rules stay per binding role and are not copied into the omp root, because sessions of different roles would race on one `agent/AGENTS.md`. The wrapper passes `~/.agents/roles/<binding role>/AGENTS.md` with `--append-system-prompt` and names it in `UG_ROLE_RULES`, and refuses a caller's own `--append-system-prompt`. omp does not give that text to task subagents (omp docs, `system-prompt-customization.md`, "Inputs by session type", read 2026-11-01). So the owner hook `role-rules.ts` appends the same file to each subagent's system prompt through `before_agent_start`, whose result may carry `systemPrompt` (omp 18.13.2, `emitBeforeAgentStart`).
- The network allowlist stays per binding role: `render-settings` reads `~/.agents/roles/<binding role>/network-allowlist` where it is. The `binding-role` record goes: the role table decides rules and allowlist at each start. (Superseded 2026-11-02: every role uses one allowlist, `~/.agents/roles/network-allowlist`, `0001-accepted-risks.md`.)
- The template grants `~/.ug/omp` for writes; `render-settings` denies the owner paths in `agent` and the owner roots, and refuses a template that grants one.

Checked with omp 18.13.2 on 2026-11-01, with a rules file that names a password: the main session answered it, a task subagent answered `NONE` with `--append-system-prompt` alone and the password with the hook, and after `--resume` both the main session and a new subagent answered it.

## Cost

- Author and reviewers share one writable `config.yml`, `agent.db`, `history.db`, and omp caches. A setting that the policy does not pin carries from author sessions into reviewer sessions, and back.
- A role can plant code in a shared cache (`underground/cache` with `tools/bin` on `PATH`, `xdg`, `npm`; `python-env`; `agent/cache/tiny-mlx-runtime`) that the next session of every role runs, not only its own. Before, it reached only its own next session. Undo: delete those folders.
- A session can open the session files of another role name, which sit in the same writable root.

## What still holds

- The policy pins (`0002-role-homes.md`, `PINNED_SETTINGS` in `host/broker/admin.ts`): no role can turn on memory, autolearn, extra loaders, or turn off an owner source.
- Per-role rules, owner-owned in `~/.agents/roles`, and one network allowlist for all roles (amended 2026-11-02).
- Reviewer store isolation (U32): an author has no grant on `~/.ug/git`; a reviewer writes only `~/.ug/git/<role name>`, never a store's `config` or `hooks`.
- `~/.omp` stays unreadable to every role, so the auth broker's logins in `~/.omp/agent/agent.db` stay out of reach (`0004-no-local-binding.md`).

Not done here: moving the data of the old role homes on disk. The owner does that after merge.
