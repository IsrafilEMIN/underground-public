# Install proves behavior; preflight checks state

Date: 2026-10-31. Owner decision.

Superseded in part on 2026-11-02 by `0012-pinned-omp-and-setup.md`: setup replaces the install, and the install record and its hash checks go. The macOS build check stays. `drop_secret_env` goes, because the wrapper starts a clean environment (`0011-one-agent-arena.md`).

The install checks (tests and probes) and the preflight answer two different questions.

- The install asks: do the controls work as designed? It tests behavior: the gate, the sandbox rules, the U1 and U2 canaries. It runs when the code or the setup of this mac changes. It can be slow, use the network, plant canaries, and use real tokens. At the end it writes the install record, `~/.agents/install-manifest`: each file it wrote with its mode and SHA-256, each folder it set a mode on, and the macOS build (`write_install_record`, `install.sh`).
- The preflight asks: is this mac still in the state that the install proved? It checks state at each launch of the wrapper, and trusts the install for behavior. It is fast and local, and it only reads. It never reads a secret value: it reads names, modes, and hashes (`preflight`, `host/bin/omp`).

Sorting rule for a new check: can the thing change between two launches without a `ug-install`? If not, the check belongs to the install. If yes, and the check is cheap and read-only, it belongs to the preflight.

Preflight checks:

| check | on failure |
|---|---|
| the install record exists | refuse |
| macOS has the build that the install ran on, so its proof of the sandbox still holds | refuse |
| each installed file has its hash and mode, is owned by the owner, and is not a symlink | refuse |
| each folder that the install set a mode on still has it (`~/.agents/auth`, `~/.config/underground-broker`, `~/.ug`, run folders) | refuse |
| the gh-broker app key, if present, is a file with mode 600 | refuse |
| the pinned omp exists | refuse |
| each launchd job of underground is running | warn, and say which work fails |

A broken control refuses the launch, because an unattended session ignores a warning. A missing capability warns, and the launch goes on. A launch where everything holds prints nothing: a message means something is wrong (owner decision, 2026-10-31).

The wrapper also keeps every variable with a credential word in its name (`TOKEN`, `SECRET`, `PASSWORD`, `KEY`, `AUTH`, and others, between underscores, in any case) out of the sandbox, without a message, because that is the control working (`drop_secret_env`, `host/bin/omp`). On 2026-10-31 an author session had the owner's `STRATA_API_KEY` (64 characters) in its environment, from the owner's shell. This is a control, not a check: it changes only the environment of the child, never the mac.

Rejected: a sandbox canary at each launch (one read that srt must deny). It tests behavior, so it belongs to the install; the macOS build check catches the change that would break it, an OS update. Rejected: killing orphaned sandbox processes or idle daemon brokers in the preflight, because it writes. `stop_failed_brokers` stays where it is (`docs/adr/0004-no-local-binding.md`).

Cost: after each macOS update, and after each hand edit of an installed file, the wrapper refuses until the owner runs `ug-install`. A credential in a variable whose name has none of the words reaches the sandbox.

## Amendment 2026-11-07: the agent box (proposed)

Once built, the macOS build check goes: it exists because srt's proof holds only on the build that setup probed, and the box does not rest on srt. The sorting rule (setup proves behavior, the start checks state) still holds. A new start check takes its place: the box must have no route (`0013-agent-box.md`, "Cost"), because `--network none` is undocumented in `container` 1.7.1.

2026-11-07: partly built. The box has no macOS build check, and setup removed the leftover `~/.ug/sys/macos-build` in a one-time step, which is gone since the owner's mac ran it (owner, 2026-11-08). The preflight of the removed wrapper went with #90 (commit 54a418a1).
