# The agent user: its own macOS user, its own login, pinned to its home

Date: 2026-11-08. Status: proposed. Owner decision of 2026-11-08: remove the containers; the agent runs as its own macOS user, and damage stays in that user's home. The base below is agreed; the parts under Open are not built or not run. Once built, this ADR supersedes `0013-agent-box.md`, `0014-session-containers.md`, and `0015-box-layout.md`. The checklist of every row is in `../THREAT-MODEL.md`, "The agent user against each row".

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
- **One home, on omp's defaults,** with the repo clones in it, cloned through the broker. Sessions are one trust level and share it (`0011-one-agent-arena.md`, "One trust level").
- **No network wall for now** (owner decision, 2026-11-08). U3, U7, and U14 are accepted by name.
- **No secret on a command line.** Any user sees the owner's processes with their full arguments (owner run, 2026-11-08), and the pin could not hide them.

## Open

- The login is built, not run on a mac. `host/bin/ug-agent-setup` runs the agent's own sshd (`host/agent/sshd_config`, LaunchDaemon `com.underground.agent-sshd`) on `127.0.0.1:2222`, key only, forced to `agent-session`. This build had no mac, so the test is open.
- `ug-agent` refuses while the system Remote Login runs, because the agent could log in with a key it writes itself. The check is `launchctl print system/com.openssh.sshd`.
- Setup adds `ugagent` to `com.apple.access_ssh`, which the system sshd needed in the owner's run (`Connection closed by ::1 port 22` before the add). Whether the agent's sshd checks the group is [inference]; setup adds it anyway.
- `/Users/ugagent/.ssh` is root-owned and holds an empty `authorized_keys`. The agent owns its home, so it can rename or delete `.ssh` and make its own, and the agent's sshd would then read it [inference]. Not closed. Owner decision: a `chflags uchg` lock on the folder, or no home-level `.ssh` at all.
- Shell start files: zsh reads `~/.zshenv` before the ForceCommand runs the pin [inference]. The agent can write that file. Not closed.
- launchd: the pin denies `/bin/launchctl`, `/usr/bin/at`, `/usr/bin/crontab`, `/usr/bin/batch` (`host/agent/pin.sb`). The mach route to launchd stays open [inference]. Owner test under the pin over ssh: `launchctl submit -l ugx -- /bin/sh -c 'head -c1 /tmp/ug-pin-test > ~/esc'`, then check whether `~/esc` exists.
- A full omp session under the profile, with a model, the broker, and subagents: not run.
- The broker socket moved to `/Library/Underground/run/broker.sock` (`host/broker/server.ts:73`), 0666 after it listens (`host/broker/server.ts:661`). The folder `run/` is owned by the owner, mode 0711. Built; not run on a mac.
- The model door: setup writes `/Library/Underground/config` with the gateway's real address and bearer in `models.yml`. The bearer sits in a file the agent can read [it already could use the gateway; U30 accepted].
- The disk cap (U22) and the backup of the agent's home (U37).
- The owner's leftover files in `/tmp`: the tool that writes each fixed name moves to a private folder before the files are deleted, so the agent cannot plant one at the same name. With the pin, the agent cannot write `/tmp` at all.

## Rejected

- The box: the costs under Context.
- A pin that lists denied places: a place nobody listed stays open.
- A start with `sudo -u` from the owner's terminal: it shares the owner's desktop session (Decision, 3).
- An admin agent user: it can run `sudo`.

## Cost

- No network wall (U3, U7, U14).
- The agent shares the owner's kernel; a local privilege escalation in macOS reaches the owner.
- `sandbox-exec` is marked deprecated by Apple [inference, from its manual page], and srt runs on the same mechanism; a macOS update can change it.
- Code planted in the agent's home loads in later sessions until a rebuild.
