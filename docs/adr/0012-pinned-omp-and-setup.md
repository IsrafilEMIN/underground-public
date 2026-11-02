# Pinned omp from GitHub, and setup in place of the install

Date: 2026-11-02. Owner decision. Supersedes the install and the install record of `0008-preflight.md`. The design is in `../PRODUCT-BRIEF.md`.

## Context

- The wrapper ran Tern's copy of omp, `~/Library/Application Support/Tern/omp/versions/<pin>` (`install.sh:87`, `:271`). Tern keeps several versions there (on 2026-11-02: 18.13.2, 18.14.2, 18.15.0, 18.16.0) and may prune them.
- Four `omp` commands were on the owner's `PATH`: an alias, Tern's `omp/bin/omp`, the wrapper, and `~/.local/bin/omp` (`which -a omp`, 2026-11-02). A worker daemon of 18.15.0 was running, so a raw, unwrapped omp had started it (`pgrep`, 2026-11-02).
- The install cloned `main` into a temp folder and copied about thirty files into `~/.agents`, with a hash record that the preflight checked at each start (`host/bin/ug-install:22`, `install.sh:252` to `:289`). It existed because the running copy was kept apart from the repo.

## Decision

- **The omp file.** omp ships as one compiled, signed file, `omp-darwin-arm64`, on GitHub releases and build.stencil.so; both publish the same files (omp `docs/macos-signing-notarization.md`, read 2026-11-02). It carries omp's code, the bun runtime, and the native parts. We never build omp, so no source is needed.
- **The pin.** `VERSIONS` holds the version and the SHA-256 of that file. Setup downloads it from the GitHub release, checks the hash, and keeps its own copy in `~/.ug/sys/omp/<version>/omp`. The auth broker, the auth gateway, and the wrapper run only that file.
- **One `omp`.** The only `omp` on `PATH` is `~/.ug/sys/bin/omp`, a link to the wrapper. Tern's omp and `~/.local/bin/omp` come off `PATH`, and the alias goes. Tern stays for the owner's iPhone; its remote link starts no omp session (owner, 2026-11-02).
- **A raw omp cannot work.** `~/.omp` holds no login: the auth broker keeps its logins in `~/.ug/secrets/auth`.
- **underground runs from the owner's checkout.** `git pull` updates its code. The owner merges every underground PR (onboarding check 6, `../SPEC.md`).
- **Setup** does only what `git pull` cannot: install the pinned omp and srt, make the zones and their modes, register and restart the launchd services, put the wrapper on `PATH`, prove srt with the U1 and U2 probes, and record the macOS build. It runs when a pin changes, a host service changes, or macOS updates.
- **Preflight** keeps one check: the macOS build is the recorded one.

## Evidence

- The v18.13.2 release file has the same SHA-256 as Tern's copy: `38c3645283ceba06f66462830ae15f27270cc7f84575e40a4c6bd68452a63d0f` (download and `shasum -a 256`, 2026-11-02; Tern's copy hashed by the owner the same day). Its size, 217260176 bytes, matches too.
- Old releases have the file: v18.0.0 (2026-08-22), v17.0.0 (2026-07-15), v15.1.1 (2026-05-15), v13.3.8 (2026-02-28), v5.0.0 (2026-01-12). v14.0.0 does not (HTTP 404). Checked with `curl -I` on the release download URLs, 2026-11-02.

## Rejected

- Copy from Tern's folder. Tern may prune a version, and the folder is Tern's to change.
- Build omp from source. It adds a toolchain and a build that we would maintain, and principle 2 of the brief keeps omp unchanged.
- Make a raw launch impossible. Any file that the owner's user can read, the owner's user can run. Only a second macOS user could stop it, which is the heavy path.
- Keep the install record. With underground running from a git checkout, `git status` shows a changed file.

## Cost

- Not every release has a mac file, so setup checks it when the owner picks a pin.
- GitHub does not promise to keep a release. The kept copy in `~/.ug/sys/omp` is the real guarantee.
- After a `git pull` that changes host service code, the owner runs setup to restart the services.
- Tern may put its `omp` back on `PATH` at an update [inference]. The wrapper should warn when it finds another `omp` on `PATH`.
- A raw omp by full path still starts; it only has no login.
