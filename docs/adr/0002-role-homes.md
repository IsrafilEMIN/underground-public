# One home per role

Date: 2026-10-30. Owner decision.

Superseded on 2026-11-01 by `0009-one-omp-root.md`: every role now uses one omp root, `~/.ug/omp`. The paths below are history. The policy pins of the overlay amendment still hold.

Superseded in part on 2026-10-31 by the amendment at the end: the owner's omp settings moved from `config.yml` to the read-only overlay `policy.yml`, and `config.yml` is now omp state that the role writes.

Every role wrote the same `~/.omp` files, cache, and temp folder, and a reviewer diffed against git refs that author sessions can write (U32). A reviewer also loaded its rules from repo files that a merged PR can change (U11).

Decision: each agent role gets its own home, derived from its role name: omp root (`PI_CONFIG_DIR`), cache root, state folder, temp folder, and broker binding. Each home has two parts. The owner part holds rules, `config.yml`, skills, and extensions, and only the owner writes it. The role part holds state, sessions, cache, and temp, and the role writes only there. A role table that only the owner edits maps each role name to `author` or to one reviewer role; the wrapper and the broker refuse a name that is not in it. A reviewer role also gets its own bare git store and fetches the PR head through the broker, so no author session can change what the reviewer diffs. A reviewer session starts in its role home, never in a checkout, and reads the PR only through git in its store. So it loads rules only from the owner part of its home, and loads no setting, skill, hook, or tool from the repo. The reviewer roles and what they can do are in `0006-reviewer-roles-gate.md`.

The role part holds nothing that omp injects into a later session. omp's local memory backend writes `MEMORY.md`, `memory_summary.md`, `learned.md`, and generated skills to disk and puts them into the system prompt at session start; memory is off by default (omp docs, `memory.md:3`, `:24`, `:46`, `:70`, `:80` to `:82`, read 2026-10-30). So `config.yml` in the owner part keeps `memory.backend: off` and `autolearn.enabled` unset, and `render-settings` maps no path into the role part that omp reads as rules, skills, extensions, or memory. A reviewer session starts new, never resumed. (Superseded: `policy.yml` pins `memory.backend: off`, `autolearn.enabled: false`, and the other settings that the amendment lists.)

Rejected: a protected-path entry for each reviewer rule file. omp reads rules from many file names, so the list would be a blocklist.

Rejected: a role writes its whole home, and the owner checks the rules from time to time. An injected reviewer can then make its later `pass` verdicts lenient before the owner looks, and those merges are not reversible (U10).

Rejected: a name rule, where a name that ends in `-review` selects a reviewer role and any other name selects `author`. A typo such as `security-reveiw` then gets push without a warning. Rejected: the broker role stored in each role home. It is safe only if only the owner can edit it, and then it is the role table split over many files.

Rejected: a reviewer in a checkout of the PR head, with an omp overlay that turns off project sources. omp always loads project sources from the working folder, and the overlay must name each provider and file name: a blocklist (omp docs, `settings.md` and `context-files.md`, read 2026-10-30). Rejected: a reviewer in a checkout of `main`. A merged change then still loads and can weaken later reviews.

Cost: a reviewer has no live tree, so it cannot use tools such as LSP on the PR. It reads files with `git show` and searches the tree with `git grep <pattern> origin/pr/<n>`.

Not decided here: author sessions keep their worktrees in the owner's repo `.git` (U31, deferred).

## Amendment 2026-10-31: the policy overlay

Owner decision, 2026-10-31.

omp uses `omp/agent/config.yml` as its own settings store. The setup wizard, the settings panel, and model picks write it under a lock, `config.yml.lock` (omp docs, `config-usage.md:161`, `:195`, read 2026-10-31). With omp 18.13.2, a save writes `config.yml.<pid>.<uuid>.tmp` and renames it over `config.yml`, and omp moves an invalid file to `config.yml.broken-<time>-<pid>-<uuid>` (seen 2026-10-31). With `config.yml` in the read-only owner part, omp did not start in a fresh role home: `Failed to acquire native file lock for .../omp/agent/config.yml.lock: Operation not permitted`.

Decision: the owner's settings move to `omp/agent/policy.yml` in the owner part. The wrapper writes it from `~/.agents/roles/policy.yml` at each session start (amendment below) and sets `PI_CONFIG_FILES` to it. omp loads the file as a config overlay: above the global and project settings, below runtime overrides and the env vars of a setting, and omp never writes it (omp docs, `config-usage.md:170` to `:190`, read 2026-10-31). `config.yml`, `config.yaml`, and their `.lock`, `.<pid>.<uuid>.tmp`, and `.broken-*` siblings are now omp state that the role writes. `render-settings` refuses every other write grant in `omp/agent`, except the omp data files, the session folder, and omp's cache folder `omp/agent/cache`, which the wrapper makes with mode 700. `models.yml` stays in the owner part.

The wrapper also copies the owner's hook `~/.agents/roles/hooks/pre/concise-reply.ts` into `omp/agent/hooks/pre/` of each role home at each session start (amendment below). omp loads a hook factory from `<agentDir>/hooks/pre/*.ts` and binds it for the session and its subagents (omp docs, `hooks.md`, section "Native discovery location", and `extensions.md`, section "Runtime model", read 2026-10-31). On the first user prompt of a session and then on every tenth prompt, its `before_agent_start` handler adds one reminder message, which omp saves to the session (omp docs, `hooks.md`, "Agent/context events", read 2026-11-01): answer first, in plain words and connected sentences, without paths, hashes, or tool names that the user does not need to act; follow the user's own style rules, such as all lowercase; add only what the user needs to act or check; name a source only for a claim the user may want to check; use bullets only for a real list; and add no adjacent facts, narration, repeats, wider claims, closing summary, or nested bullets. If the user asks again for a simpler or shorter reply, the agent gives it and says once that the reply rules are not landing, so the owner fixes the rules instead of asking each time. Before 2026-11-01 the reminder asked for a source for each claim and allowed five bullets in any reply, and replies filled up with paths, line numbers, and fragments that the owner did not need; the owner had to ask again for a plain restatement. Docs, commit messages, PR bodies, and review reasons still give a source for each claim (`AGENTS.md`, "Evidence"). The reminder shapes only the text of a reply, never whether the agent keeps working: a user report that a step the agent gave them is done counts as the go-ahead to continue, and a request to run a command ends with one line on what the agent does next. Before 2026-11-01 the reminder said "Stop when the question is answered", and agents read a report such as "I ran it, it printed nothing" as a question, confirmed it, and stopped the task. `render-settings` denies writes to `omp/agent/hooks`, so a role cannot change the hook.

Until 2026-11-02 a `context` handler appended the reminder before each model call and omp did not save it, so it stayed last in the context (a 504-reply test on 2026-10-31 chose that form for 13% fewer words). That form broke the anthropic cache. omp strips a thinking block with reason `prefix_binding_mismatch` only after anthropic refuses a changed prefix, and keeps the stripped blocks for the rest of the session (omp 18.13.2, retry path "thinking prefix changed, stripping bound thinking and retrying"). [inference] Each signed thinking block bound a prefix that ended with the reminder, and the reminder moved on the next call; no omp log line of the refusal was available. In the session logs of 2026-11-01 after 12:00 UTC, 82% of claude calls in sessions with the per-call reminder (1,472 of 1,789) added a stripped block, against 0 of 514 in sessions with the saved per-turn reminder. Over all providers, the prompt tokens that missed the cache rose from 1.30% (2026-10-26 to 2026-10-31) to 6.52% (2026-11-01) of all prompt tokens. On 2026-11-02, with the same 10-step read prompt on claude-opus-5-5 at medium effort, four sessions with the per-call reminder stripped thinking from the call after the first signed thinking block, one more block per call, up to 11; two sessions with the per-turn reminder stripped none in 23 calls, 13 of them with signed thinking, and their cache read grew on every call. [inference] The long-session plateau, where the cache read stayed at one value for 25 or more calls, came from the growing set of stripped blocks; the short test sessions did not run long enough to show it.

Until 2026-11-02 the hook added the reminder on every user prompt. The owner chose every tenth prompt instead (owner decision, 2026-11-02). The omp hook docs name no setting for how often a hook fires: `before_agent_start` runs once for each user prompt, and a retry can run it again for the same prompt (omp docs, `extensions.md`, section on `before_agent_start`, read 2026-11-02). So the hook counts the user prompts after the last saved reminder in `ctx.sessionManager.getBranch()`, not in memory, and a retry or a resumed session counts the same way. A compaction after the last reminder makes the next prompt get the reminder again, because the compaction can drop the reminder from the model's context. omp saves the user prompt before the reminder (session log of 2026-11-02), and the hook gives the same result whether or not the current prompt is already saved when it runs (`tests/host/concise-reply.test.ts`).

The wrapper sets `PI_CONFIG_DIR` and `PI_CONFIG_FILES` itself, so the caller's values never reach omp. It refuses `--config` and `--profile` for every role: a `--config` overlay loads after `PI_CONFIG_FILES` and wins over it, and a profile moves the settings out of the role home (omp docs, `cli-reference.md:76` to `:78`, and `settings.md`, section "Precedence", read 2026-10-31). The other path flags, `--extension`, `--hook`, `--trusted-extension`, and `--plugin-dir`, load code that the owner names; they select no settings file, so the wrapper passes them on.

A role can now set every setting that the policy does not pin. So the policy pins each setting that makes omp load rules, skills, extensions, hooks, MCP servers, tools, prompts, memory, or notes from a path, that keeps state from one session for the next, or that turns off a source in the owner part. `admin.ts check-config` refuses a policy that misses one (`PINNED_SETTINGS`, `host/broker/admin.ts`), and it needs `memory.backend: off` and `autolearn.enabled: false`. `autolearn.enabled` is now `false`, not unset: an unset key lets `config.yml` set it. A `null` pin keeps the omp default, because an overlay `null` counts as unset and hides the lower layers (omp docs, `settings.md`, section "Merge rules"; checked with omp 18.13.2). The list comes from `omp config list --json` of omp 18.13.2, 566 settings, read 2026-10-31. When the omp pin changes, check the new settings against this list.

The pinned settings:

- `memory.backend: off`: each memory backend writes notes that omp puts into the prompt of the next session.
- `memories.enabled: false`: the old switch of the local memory pipeline.
- `autolearn.enabled: false`: the `learn` tool writes `learned.md` and managed skills, which the next session loads.
- `autolearn.autoContinue: false`: runs a capture turn at each stop that writes lessons.
- `compaction.experimentalContextManagement: false`: keeps notes and raw history across context windows.
- `compaction.handoffSaveToDisk: false`: writes handoff documents to files.
- `autoResume: false`: resumes the last session in the folder, so a session goes on from the state of an earlier one.
- `plan.autosave: false`: writes approved plans to disk, where a later session reads them.
- `plan.autosaveDir: null`: the folder of those plans.
- `modelRoleStorage: global`: `project` writes model roles to `<cwd>/.omp/config.yml`, which later sessions load.
- `startup.setupWizard: false`: the wizard writes settings and logins in the role home; the owner sets them in the policy.
- `extensions: []`: loads extension modules from paths.
- `disabledExtensions: []`: turns off an extension of the owner part, such as `underground-guard` (U33).
- `skills.enabled: true`: `false` turns off the skills of the owner part.
- `skills.customDirectories: []`: loads skills from more folders.
- `skills.ignoredSkills: []`: hides skills of the owner part.
- `skills.includeSkills: []`: hides every skill that the list does not name.
- `skills.enablePiUser: true`: `false` turns off the skills in `omp/agent/skills`.
- `skills.enablePiProject: true`: loads skills from `.omp/skills` in the working folder; the owner sets it.
- `skills.enableAgentsUser: true`: `false` turns off the skills in `~/.agents/skills`.
- `skills.enableAgentsProject: true`: loads skills from `.agents/skills` in the working folder; the owner sets it.
- `skills.enableClaudeUser: false`: loads skills from `~/.claude`.
- `skills.enableClaudeProject: true`: loads skills from `.claude` in the working folder; the owner sets it.
- `skills.enableCodexUser: false`: loads skills from `~/.codex`.
- `commands.enableClaudeUser: false`: loads commands from `~/.claude/commands`.
- `commands.enableClaudeProject: true`: loads commands from `.claude/commands` in the working folder; the owner sets it.
- `commands.enableOpencodeUser: false`: loads commands from `~/.config/opencode/commands`.
- `commands.enableOpencodeProject: true`: loads commands from `.opencode/commands` in the working folder; the owner sets it.
- `mcp.enableProjectConfig: true`: starts the MCP servers of `.mcp.json` in the working folder; the owner sets it.
- `enabledProviders: []`: loads rules, skills, hooks, MCP servers, and settings from the user folders of other tools.
- `disabledProviders: []`: `native` turns off the rules, skills, and extensions of the owner part.
- `contextFiles.extra: []`: loads more instruction file names beside `AGENTS.md`.
- `workspace.additionalDirectories: []`: adds folders to each session as more roots.
- `task.disabledAgents: []`: turns off task agents of the owner part.
- `bash.direnv: auto`: loads a `.envrc` into bash; the owner sets it.
- `bashInterceptor.enabled: true` and `bashInterceptor.patterns`: the owner turns on omp's routing of bash commands to dedicated tools (`read`, `grep`, `glob`, `edit`, `write`, named `bash`). The policy pins the patterns to omp 18.13.2's built-in rules, because each rule's message reaches the model at each matched command, so patterns in the role's `config.yml` would carry text from one session into the next. The interceptor only routes; it is not a guard (omp docs, `tools/bash.md`, section "`bashInterceptor.patterns`", read 2026-11-01).
- `shellPath: null`: the shell for each bash command; a path in the role part would run in each later session.
- `shellCommandPrefix: null`: a prefix for each bash command, with the same risk.
- `shellMinimizer.settingsPath: null`: loads output filters from a path.
- `python.interpreter: ""`: runs the Python program at a path for the eval tool.
- `ida.python: ""`: runs the Python program at a path for IDA.
- `ida.installDir: ""`: loads the IDA library from a path.
- `images.urls.command: null`: runs a command for each image that omp publishes.
- `github.enabled: false`: the github tool serves issue and PR views from `omp/cache/github-cache.db`, which the role writes.
- `ttsr.builtinRules: true`: `false` turns off the stream rules that ship with omp.
- `ttsr.disabledRules: []`: turns off stream rules by name, the rules of the owner part among them.
- `advisor.enabled: true`: the owner turns on the advisor in every role (owner decision, 2026-11-01). It is not a safety pin: the advisor model reaches only the role's gateway client, and `/advisor off` still stops it for one session. The policy pins it so that each role starts with the advisor on, and the owner changes it in one place.

Not pinned: `mnemopi.*`, `hindsight.*`, `sharpshooter.*`, and the limits under `memories.*` act only when `memory.backend` selects them. A model setting that the role writes, such as a `modelRoles` entry that the policy does not set, `task.agentModelOverrides`, or `modelPresets`, reaches only the models of the role's gateway client (`adr/0005-model-auth-gateway.md`). `archive.enabled` reads past sessions only when the agent asks, and the role can already read its session folder. The other settings change the UI, the tools, or limits of one session; the sandbox, not an omp setting, bounds what a tool can do.

Not pinnable: the omp docs name `shell.env`, but omp 18.13.2 has no such setting: `omp config get shell.env` prints "Unknown setting", `omp config list --json` has no `shell.env` key, and a `shell: {env: ...}` that `config.yml` plants changes no setting. So the policy cannot pin it, and the role gains nothing by writing it. Check again when the omp pin in `VERSIONS` changes.

What guards the pins: `tests/host/policy-overlay.test.ts` runs the pinned omp against a planted `config.yml`, so it runs only on a mac that has the pinned binary, and skips elsewhere. CI does not run the pinned omp, so CI does not guard the pins; rerun that test on such a mac when the omp pin or the policy changes. The sandbox grants for the `config.yml.*.tmp` and `config.yml.broken-*` globs were checked by hand under srt on 2026-10-31.

## Amendment 2026-10-31: the role home is writable, owner paths are denied

Context: write grants listed each file that omp may write. omp creates new runtime files with each version (sqlite journals, locks, caches, temp files), so a new omp feature failed at each step.

Decision: the template grants the whole role home for writes. `render-settings` adds a deny entry for each owner path: the rule and prompt files (`AGENTS.md`, `RULES.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `SYSTEM_TEMPLATE.md`, `PERSONALITY.md`, `WATCHDOG.md`, `TITLE_SYSTEM.md`), the owner settings (`policy.yml`, `models.yml`, `models.yaml`, `models.container.yml`, `network-allowlist`, `binding-role`, `settings.json`, `mcp.json`, `.mcp.json`, `.env`, `secrets.yml`, `lsp.json`, `keybindings.*`), the loader folders under `omp/agent` (`extensions`, `skills`, `managed-skills`, `rules`, `commands`, `hooks`, `agents`, `tools`, `themes`, `memories`, `prompts`), and under `omp` (`plugins`, `marketplaces.json`, `.env`, `profiles`, `browser-relay`). The list comes from the paths that the omp docs name under `~/.omp`. srt also denies rename and unlink of each ancestor folder of a deny entry (`macos-sandbox-utils.js:734` to `:747`), so a role cannot move `omp/agent` aside. `render-settings` refuses a template that grants an owner path. Reads stay denied under `$HOME` except the listed read roots.

Cost: a deny list fails open. If a new omp version loads code or rules from a new path, a role can write that path until the list names it. Run `scripts/verify-role-sandbox.sh` in a role session after each omp pin change, and compare the paths that the omp docs name under `~/.omp` with the list.

Accepted risk, same class as ticket 17: two writable folders hold code that a later session of the same role runs. `omp/python-env` is the python environment of omp's python tool, and `omp/agent/cache/tiny-mlx-runtime` is the runtime for local tiny models. omp must create both, so a deny entry would break those features. A role can plant code there for its own next session. It cannot reach another role's home. To undo it, delete those folders, or the whole role home.

Also: a child `omp` in a session runs the pinned binary. `install.sh` links `~/.agents/bin/pinned/omp` to it, and the wrapper puts that folder first on `PATH`. The link is owner-owned, so a role cannot replace it.

## Amendment 2026-10-31: the owner's display settings reach every role

Role homes started with an empty `config.yml`, so every role session used omp's default look: the `default` status line has no `cache_hit` or `usage` segment, and the owner's theme and symbols were missing. At each session start, the wrapper now runs `host/broker/display-prefs.ts` with the pinned omp as Bun, which parses the owner config with `Bun.YAML` and copies only display keys (`DISPLAY_KEYS` in `host/broker/display-prefs.ts`: status line, theme, symbols, display, tui, composer, personality, speech, terminal) from the owner's `~/.omp/agent/config.yml` into the read-only `prefs.yml` of the role home. `PI_CONFIG_FILES` loads `prefs.yml` first and `policy.yml` last, so the policy wins on any key both set. Model and safety settings of the owner's config (`modelRoles`, `advisor`, `retry`, `memory`, …) never reach a role. The owner changes a display setting once, in the own omp, and every role gets it at its next start.

## Amendment 2026-10-31: the owner part follows the installed templates

The wrapper copied `policy.yml`, `AGENTS.md`, `network-allowlist`, and the concise-reply hook into a role home once, when the home was new, and kept the copy after that. So a change that the owner installed never reached an existing role: on 2026-10-31 the author home still held an `auth.broker` block that commit `4c0df6a` had removed from the template, and lacked the `broker ci-log` rule of PR #216. Now `make_role_home` in `host/bin/omp` writes each of these files from `~/.agents/roles` at every session start, through a temp file and a rename, and removes a rules or allowlist file whose template is gone. The one place to change a role is the repo: `host/roles`, then `ug-install`. A hand edit in a role home lasts until the next start. The role still cannot write these files (`render-settings`, owner paths).

Ticket 17 (role-writable folders where a later session runs programs: `cache/tools/bin` on `PATH`, `cache/xdg`, and the other caches) is an accepted risk, same class as `omp/python-env` and `tiny-mlx-runtime` above: a role can plant a program only for its own next session, never for another role or the host, and deleting the role's `cache` folder undoes it. Making these folders read-only would break `npm install -g` and the LSP and browser downloads.
