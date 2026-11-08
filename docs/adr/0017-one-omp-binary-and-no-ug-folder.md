# One omp binary, owned by root, and no `~/.ug`

Date: 2026-11-08. Status: built, not yet run on the owner's mac. Owner decisions in the design talk of 2026-11-08. Amends `0012-pinned-omp-and-setup.md` (where the pin is kept, and the one `omp` on `PATH`) and `0016-agent-user.md` (step 4: `omp` on `PATH`).

## Context

- Two copies of the same pinned omp binary existed: one in the owner's home, `~/.ug/sys/omp/<pin>/omp`, and a root-owned copy for the agent user, `/Library/Underground/omp/<pin>/omp`, copied from the first after a hash check (`host/bin/ug-agent-setup:85-91` before this change). The auth broker, the auth gateway, and `ug-auth` ran the owner's copy (`host/launchd/com.underground.auth-broker.plist:9`, `host/bin/ug-auth:21` before this change).
- The agent user cannot read the owner's home (mode 700, `0016-agent-user.md`, Decision 1), so the reason to keep the model logins out of `~/.omp` (`0012`, "A raw omp cannot work") no longer guards against the agent. It still guards against a slip in a vanilla omp session of the owner.
- `~/.ug` held omp's logins next to state that is not omp's: the GitHub app key, the gh-broker records, the backup settings, the agent's ssh key, the addresses file, and copies of underground's code.
- The owner's `PATH` named `~/.ug/sys/bin` from three zsh files (owner's `grep -n ug ~/.zshrc ~/.zprofile ~/.zshenv`, 2026-11-08). `~/.local/bin` was already on `PATH`, and no `omp` was in it (owner's `ls -la ~/.local/bin` and `echo $PATH`, 2026-11-08).

## Decision

Terms: the **agent home omp binary** is the one omp file; **vanilla omp** is that same file started by its full path by the owner; the **`omp` launcher** is `host/bin/ug-agent`, not omp.

- **One omp binary**, `/Library/Underground/omp/<pin>/omp`, root-owned, mode 555, with its pinned SHA-256 in the root-owned `omp.sha256` beside it. It serves the agent sessions, the auth broker, the auth gateway, `ug-auth`, and the owner's vanilla omp by full path. Neither the agent user nor the owner's processes can change it without root. Old version folders are removed when the pin changes.
- **Setup downloads as the owner, root installs.** `ug-setup` downloads the pinned file into a temp file and checks the hash; `sudo ug-agent-setup <file>` copies it into place, checks the copy, and writes `omp.sha256`. Root never touches the network. The root step runs before the services restart, so they never start on a missing file or an old pin.
- **Each agent session checks the binary.** `agent-start`, root-owned and run by every session, hashes the binary with `/usr/bin/openssl dgst -sha256` (0.13 s for the 220 MB file, `time`, 2026-11-08) and refuses to start on a mismatch or a missing `omp.sha256`. The check is not in the launcher, because the launcher is a file in the owner's home that any owner process can edit.
- **The logins are an omp profile**, `~/.omp/profiles/ug-auth/`, selected with `OMP_PROFILE=ug-auth` in the auth plists and in `ug-auth`. omp keeps the profile's tokens and `agent.db` there (omp `docs/auth-broker-gateway.md:377`, read 2026-11-08; a run with `OMP_PROFILE=ug-auth` wrote `~/.omp/profiles/ug-auth/auth-broker.token` and `auth-gateway.token`, 2026-11-08). A profile "sees only its own OMP config, never the default profile's agent config" (omp `docs/config-usage.md:82`, read 2026-11-08), so vanilla omp still starts with no login. This is a guard, not a wall: vanilla omp can pass `--profile ug-auth`.
- **Everything else is in `~/.local/share/underground`**, mode 700: the GitHub app key and config, the gh-broker records, `protected-paths/`, the backup settings and password, the agent's ssh key, the addresses file, `config-repo`, restic, setup's copy of the service code, and the logs of the gh-broker, the usage broker, and the backup.
- **Two commands in `~/.local/bin`**: `omp`, the launcher, and `ug-auth`. The `ug-agent` link goes; it did the same as `omp`. Setup refuses to replace a file there that is not its link, and warns when the first `omp` on `PATH` is not the launcher or when a second `omp` is on `PATH`.
- **`~/.ug` goes.** Setup moves `~/.ug/host/auth` to the profile and `~/.ug/host` to the data folder once, refuses when both ends exist, deletes `~/.ug/sys` and `~/.ug/run` (setup rebuilds them from the checkout), and removes `~/.ug` when it is empty. Anything else in it stays, and setup names it.

## Rejected

- The vanilla omp binary in `~/.local/bin/omp`, where omp's installer puts it (`INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"`, omp `scripts/install.sh:20`, read 2026-11-08). That folder is on `PATH`, so typing `omp` would start vanilla omp, or only `PATH` order would keep the launcher first.
- The logins in the data folder with `PI_CONFIG_DIR`. It works the same; the owner chose to keep omp's own state in `~/.omp`.
- The hash check in the launcher: the owner's processes can edit it.

## Cost

- The owner removes the three `PATH` lines that name `~/.ug/sys/bin` from the zsh files by hand; setup warns while one is on `PATH`.
- Vanilla omp's path names the pin, so it changes with each pin.
- Not run: the auth services from the root-owned file, and the migration on the owner's mac. Each ran only in a fake home in an agent session (2026-11-08).
