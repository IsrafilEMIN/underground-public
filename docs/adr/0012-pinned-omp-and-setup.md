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
- **A raw omp cannot work.** `~/.omp` holds no login: the auth broker keeps its logins in `~/.ug/host/auth`.
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

## Amendment 2026-11-03: the raw omp's keyless providers

Owner decision. A raw omp found no login, but it still listed models: `omp auth-gateway stdio` with `/v1/models`, run by full path from the owner's shell, listed `strata/qwen3.8-flash-next-ud-q4_k_xl`, `apple/on-device`, and `lm-studio/qwen3.8-flash-next-ud-q4_k_xl` (owner run, 2026-11-03). `strata` came from a provider in `~/.omp/agent/models.yml` and `STRATA_API_KEY` in `~/.zshenv`; the owner took the variable out. `apple` and `lm-studio` are keyless providers that omp adds by itself: `apple` on every Apple silicon mac, and `lm-studio`, `ollama`, and `llama.cpp` when a server answers (omp `model-registry.ts:1636` to `:1700`, omp 18.13.2, read 2026-11-03). The `apple` model returns tool calls that omp's agent loop runs (omp `providers/apple-foundation-models.ts:9` to `:10`), so even a small local model can drive tools with no sandbox.

Decision: the config repo holds a second list, for the raw omp, in `raw-omp/config.yml`. At each start the wrapper writes it to `~/.omp/agent/config.yml` (`write_raw_config`, `host/bin/omp-arena`), and the owner's list is `disabledProviders: [apple, lm-studio, ollama, llama.cpp, strata]`. omp skips a provider on that list (`model-registry.ts:1637` to `:1700`, `:1877` to `:1882`). The arena gets no such list: its `lm-studio` is the engine through the gateway, which the same setting would turn off [inference from `model-registry.ts:1877` to `:1882`].

Cost: the wrapper now writes one file outside `~/.ug`. It keeps the first file that it replaces as `config.yml.before-ug`, refuses a link at either end, and leaves `~/.omp` alone when the repo has no `raw-omp/config.yml`. The file is a guard against a slip, not a wall: a project's `.omp/config.yml`, `--config`, `PI_CONFIG_FILES`, and `--profile` take precedence over it or bypass it (omp `docs/config-usage.md:173` to `:182`), and a raw omp can change it until the next start. The "Rejected" item above still holds: only a second macOS user could stop a raw launch.

Check, added 2026-11-03: the probe's `raw-models` line asks a raw omp's `omp auth-gateway stdio` for `/v1/models` in the caller's own environment, and fails on any model in the list (`scripts/probe-arena.sh`). The older `raw-omp` line makes one `anthropic` call with `env -i`, so it missed `strata` (a key in the owner's shell) and the keyless providers. After the owner's list, the same request by hand returned `"data":[]`, and `-p` prompts to `apple/on-device`, `strata/...`, and `anthropic/...` each failed (owner run, 2026-11-03).

Setup, added 2026-11-03: setup also writes the raw omp's `config.yml` before its probe (`install_raw_config`, `host/bin/ug-setup`; the code is shared with the wrapper in `host/lib/raw-omp-config.bash`). After the owner's cleanup made a fresh `~/.omp`, setup's probe reported `BREACH ... can call: apple/on-device`, and the wrapper, which would write the file, refused to start, because setup removes the macOS build record before the probe (`host/bin/ug-setup:231`; owner run, 2026-11-03).

## Amendment 2026-11-07: the agent box (proposed)

`0013-agent-box.md` is proposed, not built. Until it is built, this ADR describes the system. Once built, the pinned `omp-darwin-arm64` still serves the auth broker, the auth gateway, and any raw omp on the host, but the agent runs a Linux omp in the box's pinned image, with its own pin. The srt pin stays: it now pins the egress proxy on the host, which imports a file of srt by path (`0013-agent-box.md`, "Egress by name only"), so an srt update needs the egress probe again. Setup no longer proves srt with the arena probe and no longer records the macOS build. The one `omp` on `PATH` becomes the command that starts the box. The raw omp's keyless providers amendment still holds: a raw omp on the host is outside the box.

## Amendment 2026-11-07: an installed copy of the host code (proposed)

Owner decision, 2026-11-07 (`0015-box-layout.md`). Once the box is built, "underground runs from the owner's checkout" (Decision) goes: setup copies a merged `main` commit of underground into a folder that only setup writes, and the mac runs from that copy. `0015-box-layout.md` also proposes the same for the config repo, as a vetted copy. An update is `git pull`, then setup. `../SPEC.md`, B1 ("`git pull` updates its code"), describes today's system until then.
