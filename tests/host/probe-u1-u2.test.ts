import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../temp.ts";

// The U1 and U2 probe must aim at the owner's real home. In the arena, HOME is ~/.ug/home, so a
// probe of $HOME looks only at the arena and reports nothing even when the sandbox leaks. These
// tests give it fake macOS tools that leak: each one reads whatever path it is given, as a tool
// with no sandbox would. A probe that misses a leak of the real home fails here.

const PROBE = join(import.meta.dirname, "../../scripts/probe-u1-u2.sh");
const CANARY = "UG-CANARY-7f3a9c2e";

// security and defaults: the default keychain and the preference domain resolve under the arena
// HOME, so they find nothing; a full path reads that file. pbpaste leaks the clipboard.
const TOOLS: Record<string, string> = {
  security: `last=""; for a in "$@"; do last=$a; done
case $last in /*) [ -f "$last" ] && grep -q "${CANARY}" "$last" && { printf '%s' "${CANARY}"; exit 0; } ;; esac
echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44`,
  defaults: `case $2 in /*) [ -f "$2.plist" ] && { cat "$2.plist"; exit 0; } ;; esac
echo "Domain $2 not found" >&2; exit 1`,
  pbpaste: `printf '%s' "${CANARY}"`,
  osascript: `exit 1`,
  screencapture: `exit 1`,
};

async function fixture(): Promise<{ root: string; bin: string }> {
  const root = await tempDir(join(tmpdir(), "probe-u1u2-"));
  const bin = join(root, "fake-bin");
  await mkdir(bin);
  for (const [name, body] of Object.entries(TOOLS)) {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }
  await mkdir(join(root, ".ug/home"), { recursive: true });
  return { root, bin };
}

async function plantSecrets(home: string): Promise<void> {
  await mkdir(join(home, "Library/Keychains"), { recursive: true });
  await mkdir(join(home, "Library/Preferences"), { recursive: true });
  await mkdir(join(home, ".ssh"), { recursive: true });
  await writeFile(join(home, "Library/Keychains/login.keychain-db"), `keychain ${CANARY}\n`);
  await writeFile(join(home, "Library/Preferences/ug.probe.u2.plist"), `canary ${CANARY}\n`);
  await writeFile(join(home, ".ssh/id_ed25519"), "key\n");
}

function read(home: string, bin: string): Map<string, string> {
  const r = spawnSync("bash", [PROBE, "read"], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmpdir() },
  });
  assert.equal(r.status, 0, r.stderr);
  const verdicts = new Map<string, string>();
  for (const line of r.stdout.trim().split("\n")) {
    const m = /^(U[12] \S+)  (\S+)/.exec(line);
    assert.ok(m, `unparsed line: ${line}`);
    verdicts.set(m[1], m[2]);
  }
  return verdicts;
}

const REAL_HOME_PROBES = ["U1 keychain-path", "U1 keychain-file", "U1 ssh-dir", "U2 preference-path", "U2 preference-file"];

test("in the arena, a leak of the real home's keychain, ssh folder, and preferences reads open", async () => {
  const { root, bin } = await fixture();
  await plantSecrets(root);
  const verdicts = read(join(root, ".ug/home"), bin);
  for (const probe of [...REAL_HOME_PROBES, "U2 clipboard"]) assert.equal(verdicts.get(probe), "open", probe);
});

test("in the arena, secrets in the arena itself are not taken for the real home", async () => {
  const { root, bin } = await fixture();
  await plantSecrets(join(root, ".ug/home"));
  const verdicts = read(join(root, ".ug/home"), bin);
  for (const probe of REAL_HOME_PROBES) assert.equal(verdicts.get(probe), "inconclusive", probe);
});

test("on the host, the same reads of the home say ok", async () => {
  const { root, bin } = await fixture();
  await plantSecrets(root);
  const verdicts = read(root, bin);
  for (const probe of [...REAL_HOME_PROBES, "U2 clipboard"]) assert.equal(verdicts.get(probe), "ok", probe);
  assert.equal(verdicts.get("U2 screen"), "broken");
});
