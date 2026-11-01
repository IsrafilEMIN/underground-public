# Test plan: MVP 0.5

The checks of the build in `SPEC.md`. They run before the B8 live run.

## Probes

The U1 and U2 probes run in 0.5, before the B8 live run. The probes use canaries: fake secrets planted on the host (a keychain item, a preference, clipboard text), then removed.

Each probe runs the same read twice:

1. On the host. It must succeed; if not, the probe is broken.
2. In the sandbox. The result is one of three:
   - open: the canary is read;
   - blocked: srt reports a sandbox denial for the operation;
   - inconclusive: anything else, for example a missing tool, a locked keychain, or a privacy prompt.

Limits: one keychain item's result does not cover items with other access rules, a device list does not prove capture, and a screen capture counts only if the image shows the screen.

## Tests

The suite in `tests/` runs at two points. They use fake data only: temp homes, local bare repos in place of GitHub, and a fake `gh`.

- CI runs it on each PR head and each push to `main` (`.github/workflows/ci.yml`). The ubuntu runner skips the host tests that need macOS or the pinned omp.
- `install.sh` runs it on this Mac after the dependency check, before it writes any file or service. A failed, skipped, or todo test stops the install, so the Mac-only tests run at least once for each installed build.
