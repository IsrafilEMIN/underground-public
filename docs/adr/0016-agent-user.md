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

- The login: ssh needs Remote Login, which listens on every interface by default [inference]; it must listen on loopback only, and accept only the agent user, by key. The test run added the user to `com.apple.access_ssh`, which Remote Login checks (`Connection closed by ::1 port 22` before the add, a login after it).
- A full omp session under the profile, with a model, the broker, and subagents.
- The broker socket moves out of the owner's home to a folder the agent user can use but not write.
- The model door: with no network wall, the egress proxy limits nothing; the agent's `models.yml` then names the gateway and its bearer.
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
