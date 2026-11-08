# The login user: no login, key, or omp that the owner's user can use

Date: 2026-11-08. Status: proposed, not built. Owner decision in chat, 2026-11-08: "i don't want to be able to start vanilla omp sessions and even if it starts, it should have no logins and keys and crippled." Amends `0017-one-omp-binary-and-no-ug-folder.md` (the ug-auth profile, and vanilla omp by full path).

## Context

- A file that the owner's user can read, any program of the owner's user can read. So the ug-auth profile is no wall: vanilla omp with `--profile ug-auth` gets every login (omp `docs/config-usage.md:78`, read 2026-11-08). `0012-pinned-omp-and-setup.md` (Rejected) said the same: only a second macOS user stops it.
- The owner can run the one omp binary: it is mode 555 (`ls -la /Library/Underground/omp/18.18.1/`, 2026-11-08). Tern also keeps omp copies that the owner can run (`0012`, Context).
- The owner can read the gateway bearer: `/Library/Underground/config/models.yml` is root-owned and `go-w`, not `go-r` (`stage_config`, `host/bin/ug-agent-setup`). With it, any omp reaches every served model.
- Copies of the logins that the owner can read, counted with `select count(*) from auth_credentials` (owner runs, 2026-11-08): the live store `~/.omp/profiles/ug-auth/agent/agent.db` has 13, the old copy `~/.omp/profiles/ug-auth/from-dot-omp/agent/agent.db` has 12, and the owner's `~/.omp/agent/agent.db` has 0. For a week the logins also sat in `~/.ug/host/auth`, so they can be in Time Machine, APFS snapshots, the restic repo, and the Trash.

## Decision (proposed)

1. **A login user, `ugauth`.** Standard, hidden, never an admin, shell `/usr/bin/false`, home `/Users/ugauth` at mode 700. Setup makes it like `ugagent` (`host/bin/ug-agent-setup`). omp runs there on its default profile; `OMP_PROFILE` goes.
2. **The login services are LaunchDaemons.** The auth broker, the auth gateway, and the usage broker run from `/Library/LaunchDaemons` with `UserName=ugauth`, because a user that never logs in has no `gui/<uid>` domain for LaunchAgents. Setup boots out and deletes the three owner LaunchAgents.
3. **Code that runs as `ugauth` is root-owned.** The usage broker's code and the addresses file move to `/Library/Underground`, root-owned and not writable by the owner. A copy in the owner's data folder would let any owner process change code that runs with the logins. The usage broker reads the gateway token from `/Users/ugauth`.
4. **The owner cannot run omp.** The binary is `root:ugomp`, mode 550, and the group `ugomp` holds `ugagent` and `ugauth` only. `agent-start` and the gh-broker client run as `ugagent`, so they keep working. `scripts/gh-broker-app-wizard.sh` runs the gh-broker client as the owner today; it moves to `sudo -u ugagent`.
5. **The owner cannot read the bearer.** `/Library/Underground/config` becomes `root:ugagent`, folders 750 and files 640. `agent-start` copies it as `ugagent`, so sessions keep it.
6. **`ug-auth` uses sudo.** `ug-auth auth-broker login <provider>` runs `sudo -u ugauth -H <omp> auth-broker …`, so each login asks for the owner's password.
7. **New logins, old ones revoked: required.** After the switch the owner logs in to every provider again as `ugauth`, and then signs out of the old sessions or revokes the old refresh tokens at each provider. Setup also makes a new broker token and a new gateway bearer. Every old copy is then dead, found or not. Only after that does setup delete `~/.omp/profiles/ug-auth` (the live store and `from-dot-omp`), and the owner empties `~/.Trash/ug-old`.
8. **Setup checks the walls as the owner.** It fails if the owner can run the binary, read `/Users/ugauth`, or read `/Library/Underground/config`, and it warns while `~/.omp/profiles/ug-auth` exists.

## Not covered, accepted by name

- The owner through sudo reaches everything. This stops slips and any program that runs as the owner, not the owner on purpose.
- An omp that the owner downloads, or a copy of Tern's, still starts. It has no login and no bearer. It still finds the keyless providers that omp adds by itself, such as `apple/on-device` (`0012`, amendment 2026-11-03), unless the owner's `~/.omp/agent/config.yml` turns them off.

## Open

- Not run: an OAuth login in the browser while omp runs as `ugauth`. omp waits for the browser's reply on a local port (`anthropic:54545`, omp `docs/auth-broker-gateway.md:63`, read 2026-11-08). [inference] A port that one user listens on answers a browser of another user.
- Not run: whether a group-only mode 550 binary starts for `ugagent` under the pin (`host/agent/pin.sb`).

## Rejected

- The ug-auth profile: no wall (Context).
- The login services as root: root would run a networked omp.
