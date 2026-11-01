# U1 and U2 probe results

The canary probes of `TEST-PLAN.md`, run with `scripts/probe-u1-u2.sh` on 2026-10-31 against the final sandbox settings of MVP 0.5, `main` at `587bf07`. A dry run at `aa276e4` gave the same results. B8 (the live run) waits for this table.

Run order: `plant` on the host; `read` on the host; `read` in an author session (`!bash scripts/probe-u1-u2.sh read`); `remove` on the host.

| probe | reads | host | sandbox | sandbox evidence | owner decision |
|---|---|---|---|---|---|
| U1 keychain | a generic password planted with `security` | ok | not read; the keychain file is blocked (next row) | `security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.` exit 44 | |
| U1 keychain-file | opens `~/Library/Keychains/login.keychain-db` | ok | blocked | `head: .../login.keychain-db: Operation not permitted` | |
| U1 ssh-dir | `ls ~/.ssh` | ok | blocked | `ls: /Users/kutluk/.ssh: Operation not permitted` | |
| U2 preference | a `defaults` domain | ok | not read; the preference file is blocked (next row) | `Error: Domain 'ug.probe.u2' not found.` exit 1 | |
| U2 preference-file | opens `~/Library/Preferences/ug.probe.u2.plist` | ok | blocked | `head: .../ug.probe.u2.plist: Operation not permitted` | |
| U2 clipboard | `pbpaste` | ok | blocked | kernel log: `Sandbox: pbpaste(68627) deny(1) mach-lookup com.apple.pasteboard.1` (2026-10-31 21:41:45, and each later run) | |
| U2 apple-events | `osascript` asks Finder for the startup disk name | ok (`Macintosh HD`) | blocked | kernel log: `Sandbox: osascript(68783) deny(1) mach-lookup com.apple.coreservices.appleevents` (2026-10-31 21:42:52) | |
| U2 screen | `screencapture -x` to a file | broken: the terminal has no Screen Recording permission | wrote nothing | no capture is possible from the terminal, sandbox or not | protected by macOS: the owner keeps Screen Recording off for the terminal that runs omp |

Reading: no canary reached the sandbox, and no result is open. A service read that returns nothing is checked in the host kernel log, which the sandbox cannot read: `log show --last 10m --style compact --predicate 'eventMessage CONTAINS "deny" AND eventMessage CONTAINS "<program>"'`. The file probes show why the keychain and preference reads came back empty: srt denies the files behind them. Four results are `inconclusive` by the plan's rule, because srt reported no denial: the sandbox saw an empty keychain, no preference domain, an empty clipboard, and no Apple event service. That is consistent with srt's `denyRead` of `~` (the keychain and the preferences live under `~/Library`) and its fixed service list (`THREAT-MODEL.md` U1, U2), but the probe cannot tell a denial from an absent service.

Limits (`TEST-PLAN.md`): one keychain item's result does not cover items with other access rules; a screen capture counts only if the image shows the screen. Camera and microphone are not probed: a device list does not prove capture.

Canaries: keychain item `ug-probe-u1`, preference domain `ug.probe.u2`, clipboard text. `remove` deletes all three.
