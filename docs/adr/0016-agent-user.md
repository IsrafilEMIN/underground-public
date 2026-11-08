# The agent user: its own macOS user, its own login, pinned to its home

Date: 2026-11-08. Status: built (step 4, 2026-11-08: the box removed, `omp` switched to the agent user, the backup moved to the agent home). Owner decision of 2026-11-08: remove the containers; the agent runs as its own macOS user, and damage stays in that user's home. The login and the pin ran on the owner's mac (Open). The backup and its sudo rule are built but not run on a mac. This ADR supersedes `0013-agent-box.md`, `0014-session-containers.md`, and `0015-box-layout.md`. The checklist of every row is in `../THREAT-MODEL.md`, "The agent user against each row".

## Context

The box keeps the agent in a Linux VM. It costs a Linux image and a second omp pin (`VERSIONS`: `box_omp`), an undocumented `--network none` (`0013-agent-box.md`, Cost), a relay inside the box, and a backup that reads the home through the VM (`../THREAT-MODEL.md`, U37). The harm the owner wants walled is harm to the owner's own files, logins, and desktop. A second macOS user walls files by plain permissions; the owner's runs of 2026-11-08 show where it does not, and what closes each gap (`../THREAT-MODEL.md`, the agent user table).

## Decision (proposed)

The base is three things:

1. **The owner's home is closed.** Mode 700. A new standard user is in the group `staff`, as the owner is (`Assigning UID: 502 GID: 20`), and with the owner's home at the macOS default it read the owner's files; with mode 700 it could not read, write, or reopen it (owner runs, 2026-11-08). Setup sets it, and a start refuses if it is open.
2. **The agent's files are pinned to its home.** A sandbox profile, run with `sandbox-exec`, allows writes only in the agent's home, its own temp folder under `/private/var/folders`, `/dev/null`, and the terminal devices, and allows reads only of its home and the system folders that programs need to run. Reads are an allow list, not a list of denied places, so a path nobody listed stays closed. Under it, over ssh, `/tmp`, `/Users/Shared`, and `/Volumes` were closed, and git, a commit, and omp ran (owner run, 2026-11-08; `../THREAT-MODEL.md`, the agent user table). The profile as run, with the agent's home for `/Users/ugtest`:

   ```
   (version 1)
   (allow default)
   (deny file-read* (require-not (require-any
     (literal "/") (literal "/Users") (literal "/private") (literal "/private/var")
     (literal "/etc") (literal "/tmp") (literal "/var")
     (subpath "/Users/ugtest")
     (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin")
     (subpath "/Library") (subpath "/Applications") (subpath "/dev")
     (subpath "/private/etc") (subpath "/private/var/db/timezone") (literal "/private/var/db/xcode_select_link")
     (subpath "/private/var/select") (subpath "/private/var/run") (subpath "/private/var/folders"))))
   (allow file-read-metadata)
   (deny file-write* (require-not (subpath "/Users/ugtest")))
   (allow file-write* (literal "/dev/null") (regex #"^/dev/tty") (subpath "/private/var/folders"))
   ```

3. **The agent starts through a login of its own.** Not with `sudo -u` from the owner's terminal: started that way, it read the owner's clipboard (owner run, 2026-11-08). Logged in over ssh to `localhost`, with the profile and no rule per service, it did not read the clipboard, Apple events failed, and `open -a TextEdit` failed with no app started (owner run, 2026-11-08).

Around the base:

- **No containers.** No Apple `container` VM, image, volume, or relay.
- **A standard user, never an admin,** made by setup, hidden from the login window. The owner never logs in as it at the desktop.
- **One home, on omp's defaults,** with the repo clones in it, cloned through the gh-broker. Sessions are one trust level and share it (`0011-one-agent-arena.md`, "One trust level").
- **No network wall for now** (owner decision, 2026-11-08). U3, U7, and U14 are accepted by name.
- **No secret on a command line.** Any user sees the owner's processes with their full arguments (owner run, 2026-11-08), and the pin could not hide them.

## Open

- The login ran on the owner's mac on 2026-11-08: `ug-agent` started a session as `ugagent` through the agent's own sshd (`host/agent/sshd_config`, LaunchDaemon `com.underground.agent-sshd`, `127.0.0.1:2222`, key only, forced to `agent-session`). In it, the model answered, `gh-broker sync IsrafilEMIN/underground-public` printed `origin/main is now 922ff3d8…`, and `pbpaste` printed nothing (exit 1).
- `ug-agent` refuses while the system Remote Login runs, because the agent could log in with a key it writes itself. The check is `launchctl print system/com.openssh.sshd`.
- Setup adds `ugagent` to `com.apple.access_ssh`, which the system sshd needed in the owner's run (`Connection closed by ::1 port 22` before the add). Whether the agent's sshd checks the group is [inference]; setup adds it anyway.
- `/Users/ugagent/.ssh` is root-owned and holds an empty `authorized_keys`, for the system sshd. The agent's own sshd reads keys only from `/Library/Underground/authorized_keys` (`host/agent/sshd_config`). The pin denies writes under `~/.ssh` (`host/agent/pin.sb`), so a pinned session cannot rename or replace it [inference: a rename is checked on the source path; not run].
- Code before the pin: the agent's login shell is `/bin/sh`, which reads no start file when sshd runs it with `-c` [inference, bash manual: a non-interactive shell invoked as `sh` reads no startup files; on macOS `/bin/sh` runs the shell named in `/private/var/select/sh`]. The pin also denies writes to the zsh and bash start files in the home, and `PermitUserRC no` stops sshd from running `~/.ssh/rc` (`host/agent/sshd_config`).
- launchd: the pin denies `/bin/launchctl`, `/usr/bin/at`, `/usr/bin/crontab`, `/usr/bin/batch` (`host/agent/pin.sb`). Owner run, 2026-11-08, as `ugagent` under the pin with `sudo -u`: a copy of `/bin/launchctl` in the home was killed at once (`Killed: 9` for `./lc submit` and `./lc remove`), and the job's file `/tmp/ug-esc` did not appear. [inference] macOS kills a copied system binary that carries Apple-only rights. A program that talks to launchd directly, with no `launchctl`, is not tested.
- A full run to a merge, from a session on the agent user, 2026-11-08: commit, `gh-broker push`, `gh-broker pr-create`, green CI, and the owner's merge of #102 to #105. A plain subagent of that session (`task`), 2026-11-08: `id -un` printed `ugagent`, it read a repo file, `gh-broker pr-status` worked, it wrote a file in its `$TMPDIR`, and `touch /tmp/subagent-escape` printed `Permission denied`. Not run: an isolated subagent, which omp makes in its own copy of the worktree.
- The gh-broker socket moved to `/Library/Underground/run/gh-broker.sock` (`host/gh-broker/server.ts:73`), 0666 after it listens (`host/gh-broker/server.ts:661`). The folder `run/` is owned by the owner, mode 0711. `gh-broker sync` from the agent user worked (above).
- The model door: setup writes `/Library/Underground/config` with the gateway's real address and bearer in `models.yml`. The bearer sits in a file the agent can read [it already could use the gateway; U30 accepted].
- No disk cap (U22): owner decision, 2026-11-08, not needed.
- The pin's read list, trimmed by an owner run on 2026-11-08. Each variant ran a workload as `ugagent` under `sandbox-exec` (shell, git status and commit, python3, an HTTPS request, time zone, `gh-broker pr-status`, an omp model call, node, npm, gh). Needed: `/private/etc` (without it, `https` failed: `configuration file routines:CRYPTO_internal:system lib`) and `/private/var/db/timezone` (without it, `timezone` failed). Each of these passed when removed on its own, and is now removed: `/Applications`, `/private/var/db/xcode_select_link`, `/private/var/select`, `/private/var/run`, and the `/etc`, `/tmp`, `/var` links. `/Library` is narrowed to `Underground`, `Developer`, `Preferences`, and `Apple`: everything passed, and `ls "/Library/Application Support"` failed, as it should. Homebrew: its `bin`, `Cellar`, `opt`, `lib`, `libexec`, and `share` are readable, and its `var` and `etc` stay closed. In the combined pin npm first failed with `calling fopen(/opt/homebrew/etc/openssl@4/openssl.cnf, rb)`, `Operation not permitted`. So the pin allows the one file `openssl.cnf` under any `/opt/homebrew/etc/openssl@<n>/`. Owner run of the full pin, 2026-11-08, with and without the OpenSSL and CA `cert.pem` files: every check passed both times, `npm view left-pad version` included, so the certificate files are not allowed.
- The owner's leftover files in `/tmp`: the tool that writes each fixed name moves to a private folder before the files are deleted, so the agent cannot plant one at the same name. With the pin, the agent cannot write `/tmp` at all.

## Rejected

- The box: the costs under Context.
- A pin that lists denied places: a place nobody listed stays open.
- A start with `sudo -u` from the owner's terminal: it shares the owner's desktop session (Decision, 3).
- An admin agent user: it can run `sudo`.
- A root LaunchDaemon for the backup: it would run the owner's `wake=` and `sleep=` lines as root, and it would need the owner's ssh key and known_hosts where root reads them.

## Cost

- No network wall (U3, U7, U14).
- The agent shares the owner's kernel; a local privilege escalation in macOS reaches the owner.
- `sandbox-exec` is marked deprecated by Apple [inference, from its manual page], and srt runs on the same mechanism; a macOS update can change it.
- Code planted in the agent's home loads in later sessions until a rebuild.

## Step 4 (2026-11-08): the switch

- `omp` on `PATH` is `~/.ug/sys/bin/omp`, linked to `ug-agent` by `host/bin/ug-agent-setup`.
- The box is removed: `host/bin/ug-box`, `host/bin/ug-box-restore`, `host/bin/ug-box-check.ts`, `host/lib/box-image.bash`, `box/`, `host/egress/`, `host/srt/`, `host/network-allowlist`, the `com.underground.egress` LaunchAgent, and the `srt`, `box_omp`, and `ovnfs` pins in `VERSIONS`. Setup removed the old installed copies and the egress LaunchAgent in a one-time step, which is gone since the owner's mac ran it (owner, 2026-11-08). It never touched the volume `ug-box-home` or the images; the owner deletes those by hand.
- The backup stays the owner's LaunchAgent `com.underground.backup`, at 20:00. `host/bin/ug-backup` takes the agent home from a root helper through sudo: `/Library/Underground/bin/agent-home-tar` (`host/agent/agent-home-tar`, which runs tar on `/Users/ugagent` and excludes `./.cache` and `node_modules`). The owner's rule is `/etc/sudoers.d/underground-backup`, written by `ug-agent-setup` and checked with `visudo -cf`. restic reads the tar stream with `--stdin-from-command`, so a failed read stores no snapshot. `.ug-nobackup` is no longer honored.
- Owner run, 2026-11-08: `ug-agent-setup` printed `backup: /Library/Underground/bin/agent-home-tar, and sudo for kutluk to run it`, `ug-backup` printed `BACKUP OK`, and the `ug-agent` snapshot has `"total_bytes_processed":4207872000`. tar also reported `pax format cannot archive sockets` for `./.omp/run/daemons/…/broker.sock`, `Could not pack extended attributes: Operation not supported`, and `./Library/Caches/com.apple.containermanagerd: Couldn't visit directory: Operation not permitted`, then `Error exit delayed from previous errors`. The helper now passes `--no-xattrs` and leaves out `./.omp/run` (live sockets) and `./Library` (macOS's own folders for the user; a run as `ugagent` also hit `./Library/ContainerManager: Couldn't visit directory`). The same tar run as `ugagent`, 2026-11-08: `tar exit 0, warning lines: 0`, 4198952960 bytes. It still counts tar's exit 1 as a success: the agent chooses what sits in its home, and a socket, FIFO, or unreadable folder of its own must not stop every backup. A missed file shows in `backup.log`, and `ug-agent` warns when the last good backup is older than 36 hours.
- Restore of a box snapshot (the box's home volume): `restic -r <repo> dump <id> ug-box-home.tar | sudo tar -x -C /Users/ugagent --exclude .omp/natives`, then `sudo env BUN_BE_BUN=1 <omp> host/agent/migrate-paths.ts /Users/ugagent /home/agent /Users/ugagent`, then `sudo chown -R ugagent:staff /Users/ugagent`. The migration moves the session header `cwd` and the `history` and `session_recaps` rows under the old home (`tests/host/migrate-paths.test.ts`).
- Restore of an agent snapshot: `restic -r <repo> dump <id> ug-agent-home.tar | sudo tar -x -C /Users/ugagent`, then `sudo chown -R ugagent:staff /Users/ugagent`. The snapshot is a tar stream, so `restic restore` would leave the tar file unpacked.
