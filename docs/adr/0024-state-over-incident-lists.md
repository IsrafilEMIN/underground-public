# 0024. State over incident lists

Status: Accepted (owner, 2026-11-10)

## Context

Some lists in the code grew by one entry after each failure: an error text, a path, a file name. An audit on 2026-11-10 found four that a structural signal can replace. The owner accepted each fix in the session of that day.

## Decision

1. **GitHub says whether a token is dead.** When a gh or git call fails, the gh-broker asks GitHub with the same token (`GET /installation/repositories`). Only an HTTP 401 drops the token and, for a read, runs the call once more (`dropIfRejected`, `host/gh-broker/github-app.ts`; `asApp`, `host/gh-broker/server.ts`). The regex over gh and git error texts (`UNAUTHORIZED`) is gone. It grew with each change in git's wording; "could not read Username" came in 2ca57cd.
2. **Ignored files wait 14 days, and no file is judged.** The sweep moves the ignored files of a merged, clean, unused worktree to `ug-held/<ms>-<branch>/` in the clone's git folder, under their own paths, and then removes the worktree. Each sweep deletes held folders that are 14 days old (`holdIgnored`, `expireHeld`, and `HOLD_MS`, `host/gh-broker/sweep.ts`). The list of cache names (`CACHE_NAMES`) is gone. The cost: `node_modules` and build output also wait 14 days.
3. **The sandbox closes only `/Volumes` to reads.** The owner's rule: the agent never reads a file in root's home or the owner's home (owner, 2026-11-10). The separate user meets it: the owner's home is mode 700 (`chmod 700`, `host/bin/ug-agent-setup`) and root's home `/private/var/root` is `root:wheel` mode 750, and `ugagent` is not in `wheel` (`stat` and `id` as `ugagent`, 2026-11-10). The read allow list in `host/agent/pin.sb` is gone; it grew by one entry for each tool that read a new place (4 commits on 2026-11-08). One deny stays: an external drive can be mounted with ownership ignored, so its files would be readable by every user. `/Users/Shared` is readable, by owner decision. The old account folder `/Users/kutluk-admin`, which `ugagent` owned through a reused user ID, was removed by the owner on 2026-11-10.
4. **Setup builds the code folder fresh and swaps it in.** `ug-agent-setup` renders the agent templates with the host facts (`ug_render`, `host/lib/ug.bash`) and builds `/Library/Underground/code` in `code.new` from the checkout and swaps it in, as `stage_config` does for `config` (`code.new`, `host/bin/ug-agent-setup`). At the end it deletes each entry at the top of `/Library/Underground` that this version does not make (`ssh_host_ed25519_key.pub`, `host/bin/ug-agent-setup`). `ug-setup` boots out and deletes each `com.underground.*` LaunchAgent that is not in its `labels` (`retire_agents`, `host/bin/ug-setup`). The firewall files of `0022-loopback-one-firewall-line.md` moved into the same folder: `code/pf.conf` and `code/pf-load`. These replace the one-time delete line for old paths and the label part of `rename_broker`. The move of `~/.local/share/underground/broker` to `gh-broker` stays (`move_broker_records`, `host/bin/ug-setup`): records are data, so setup moves them and does not rebuild them.

## Not covered

- Runtime files in `run/` are not swept. Root writes nothing there (`HOST-STATE.md`, "Root folder: `root` (root-owned)").
- With the read list gone, the agent can read world-readable files outside the homes, for example in `/tmp`, `/Library`, and `/opt/homebrew/etc`. The owner's rule names only the homes. [inference] A Homebrew service config at mode 644 that holds a password is readable.
- Not run on the owner's mac: the new pin, the code swap, and the LaunchAgent cleanup. The code swap and the top-level cleanup ran in a throwaway folder without root (agent run, 2026-11-10).
