# 0028. Replace skill repos with plugin repos

Status: Accepted (owner, 2026-11-11). Replaces the direct skill import of `skill-repos`.

## Context

Setup staged skills directly from skill repos. The config repo's `skill-repos` file named owner paths, and setup copied each folder with a `SKILL.md` at its top or under `skills/` into the staged config's `skills/` (the `skill-repos` loop of `stage_config`, removed by this change). Direct import covered skills only. The first outside consumer, the arkan repo (`IsrafilEMIN/arkan`), is an omp plugin: it holds `.claude-plugin/plugin.json`, 54 skills under `skills/`, and two task agents under `agents/`. Import could not carry the agents, and each new plugin part would ask for another import rule. The owner decided to ditch direct skill import completely and adapt to omp plugin installation (owner decision, 2026-11-11, in chat). The omp pin has the repeatable launch flag `--plugin-dir <dir>` (omp docs, `cli-reference.md`, read 2026-11-11; omp 18.18.8, `VERSIONS`). omp keeps plugin installs in `~/.omp/plugins` and marketplace entries in `~/.omp/marketplaces.json` (omp docs, `marketplace.md`, section "On-disk layout", read 2026-11-11).

The mechanism is proven. Agent run, 2026-11-11: `omp -p --no-session --plugin-dir <arkan last commit>` in a fresh HOME holding only `models.yml` and `config.yml`. The task agents listed `arkan-agent, comment-sicko, scout, reviewer, security-reviewer, seance, task, sonic`. A spawned `arkan-agent` answered YES that the `arkan-mode` text (`# arkan mode`) was in its context. The skill loaded under the bare name `arkan-mode`.

## Decision

1. **`plugin-repos` replaces `skill-repos`.** The config repo file names one plugin repo path per line. A leading `~` means the owner's home; blank lines are skipped. A path must be a folder, not a link, must resolve with `pwd -P`, and must sit inside the owner's home: the same checks the skill-repos loop ran. While the config repo still holds `skill-repos`, setup stops and tells the owner: the config repo has skill-repos, which setup no longer reads; rename it plugin-repos.

2. **Setup stages each plugin repo whole.** `git archive HEAD` extracts the last commit into a temp folder. The plugin manifest is `.claude-plugin/plugin.json`, else a root `plugin.json`; with neither, setup stops. Setup reads the plugin `name` from the manifest with `/usr/bin/plutil`, because the owner's mac has no `jq`, and refuses a name outside `^[A-Za-z0-9]([A-Za-z0-9.-]{0,62}[A-Za-z0-9])?$`. `vet_item` refuses a link, a special file, or a token in the whole extracted tree (`vet_item`, `host/lib/stage.bash`). A repeated plugin name, or a `skills/<n>/` with a `SKILL.md` or an `agents/<n>.md` whose name the config repo's staged tree or an earlier plugin already holds, stops setup. The tree lands at `config/plugins/<name>` with the config's ownership, modes, and atomic swap (`stage_plugins`, `host/lib/stage.bash`).

3. **Each start loads the staged copy in place, and that is the only path.** agent-start passes one `--plugin-dir` per staged plugin to omp (`plugin_dirs`, `host/agent/agent-start`). `plugins` is not in `config-names` (`host/agent/agent-start`): nothing copies it into the agent home, and omp reads `root/config/plugins/` directly. The agent user never runs `omp plugin install` and never adds a marketplace for a plugin. `~/.omp/plugins` and `~/.omp/marketplaces.json` sit outside `config-names`, so each start deletes both (`agent-start`, `host/agent/agent-start`). A plugin update reaches the agent only by commit, then setup. `.claude-plugin/marketplace.json` is not read.

4. **Agent definitions and plugin code change no threat node.** The plugin repo is owner-trusted input at its last commit, like the config repo, which already ships extensions and hooks. An agent definition's `tools`, `spawns`, and `model` grant no tool and no model beyond what the session already has: the agent can write its own `~/.omp/agent/agents/*.md` during a session and spawn it, models are reached only through the gateway in `models.yml`, and every tool runs as the agent user under the pin. A plugin can also carry hooks, commands, MCP or LSP config: code that runs in the session as the agent user under the pin, the same as config-repo extensions, so no new node [inference: that hooks and MCP load through `--plugin-dir`; LSP from `--plugin-dir` roots is documented (omp docs, `lsp-config.md`, read 2026-11-11)]. A `.claude-plugin/` manifest makes omp drop agent `model` frontmatter (omp docs, `task-agent-discovery.md`, section "Filesystem and plugin discovery", read 2026-11-11). `docs/THREAT-MODEL.md`, U6, names the read-only staged copy and the delete at each start.

5. **Rejected: staging `agents/*.md` into `config/agents` beside the skills.** That keeps direct import alive for one more file type; the owner asked to drop direct import. Rejected: `omp plugin install` from a local marketplace, run as the agent user. An install writes `~/.omp/plugins` with absolute cache paths and survives starts, so the reset would need a delete copy, and the load path would sit in agent-written state (U6).

## Undo

A git revert of the change. The owner renames `plugin-repos` back to `skill-repos` in the config repo and commits.

## Owner step

Rename `skill-repos` to `plugin-repos` in the config repo, commit, and run setup again. Setup stops while the old name is in the last commit.
