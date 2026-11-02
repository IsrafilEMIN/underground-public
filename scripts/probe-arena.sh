#!/usr/bin/env bash
# The arena probe (docs/SPEC.md, Checks): does the pinned omp work with an arena as its home,
# under the pinned srt, before the new wrapper replaces the old one?
#
#   host/bin/ug-setup          first: puts the pinned omp and srt in ~/.ug/sys
#   scripts/probe-arena.sh     then: runs the checks below and prints PASS or FAIL for each
#
# It writes only a fresh probe arena ~/.ug/probe/home, one settings file in ~/.ug/run, and one
# canary file in the home folder, and deletes all three at the end (KEEP=1 keeps the arena).
# It never touches ~/.agents, ~/.ug/omp, ~/.omp, or a running session.
#
# PROBE_MODEL picks the model of the prompt check (default opencode-go/deepseek-v4.1-flash).
# PROBE_MODELS names the models.yml with the gateway providers (default: the one that the
# current install renders, ~/.ug/omp/agent/models.yml).
set -euo pipefail

src=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
node_bin=/opt/homebrew/bin/node
pin() { sed -n "s/^$1=//p" "$src/VERSIONS"; }
omp_pin=$(pin omp)
omp_sha=$(pin omp_sha256)
srt_pin=$(pin srt)
sys="$HOME/.ug/sys"
omp_bin="$sys/omp/$omp_pin/omp"
srt_cli="$sys/srt/$srt_pin/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js"
arena="$HOME/.ug/probe/home"
run_dir="$HOME/.ug/run"
settings="$run_dir/probe-arena.json"
canary="$HOME/.ug-probe-canary"
model=${PROBE_MODEL:-opencode-go/deepseek-v4.1-flash}
models_src=${PROBE_MODELS:-$HOME/.ug/omp/agent/models.yml}
addresses="$HOME/.config/underground-broker/addresses"

fails=0
pass() { printf 'PASS  %-12s %s\n' "$1" "$2"; }
fail() { printf 'FAIL  %-12s %s\n' "$1" "$2"; fails=$((fails + 1)); }
info() { printf 'INFO  %-12s %s\n' "$1" "$2"; }

cleanup() {
  rm -f "$canary" "$settings" "$HOME/.ug-probe-write"
  [[ ${KEEP:-} == 1 ]] || rm -rf "$HOME/.ug/probe"
}
trap cleanup EXIT

for need in "$node_bin" "$omp_bin" "$srt_cli" "$models_src" "$addresses"; do
  [[ -e $need ]] || { printf 'probe-arena: missing %s; run host/bin/ug-setup and the current install first\n' "$need" >&2; exit 1; }
done
gateway=$(sed -n 's/^gateway=//p' "$addresses")
[[ -n $gateway ]] || { printf 'probe-arena: no gateway= line in %s\n' "$addresses" >&2; exit 1; }

rm -rf "$HOME/.ug/probe"
install -d -m 700 "$HOME/.ug/probe" "$arena" "$arena/tmp" "$arena/.omp/agent" "$run_dir"
cp "$models_src" "$arena/.omp/agent/models.yml"
printf 'probe secret\n' >"$canary"

"$node_bin" -e '
  const fs = require("fs");
  const [file, home, arena, sys, allowlist, gateway] = process.argv.slice(1);
  const allowedDomains = fs.readFileSync(allowlist, "utf8").replaceAll("@GATEWAY@", gateway)
    .split("\n").map((l) => l.replace(/#.*/, "").trim()).filter((l) => l !== "" && !l.includes("@"));
  const settings = {
    filesystem: { denyRead: [home], allowRead: [arena, sys], allowWrite: [arena], denyWrite: [] },
    network: { allowedDomains, deniedDomains: [], allowUnixSockets: [arena], allowLocalBinding: true },
    allowAppleEvents: false,
    allowPty: true,
  };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
' "$settings" "$HOME" "$arena" "$sys" "$src/host/roles/network-allowlist" "$gateway"

# Run a command in the sandbox with the arena as HOME. The outer env -i keeps the owner's shell
# out; srt keeps the real HOME for itself and adds its proxy variables; the inner sh sets HOME and
# TMPDIR for the child and passes the proxy to omp as PI_PROXY, as omp-inner does today.
in_box() {
  env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm-256color}" \
    "$node_bin" "$srt_cli" --settings "$settings" -- /bin/sh -c '
      p=${https_proxy:-${HTTPS_PROXY:-}}
      if [ -n "$p" ]; then PI_PROXY=$p; export PI_PROXY; fi
      HOME=$1; TMPDIR=$1/tmp; export HOME TMPDIR; shift
      cd "$HOME" && exec "$@"
    ' sh "$arena" "$@"
}

have=$(shasum -a 256 "$omp_bin") && have=${have%% *}
if [[ $have == "$omp_sha" ]]; then pass pin "omp $omp_pin has the SHA-256 in VERSIONS"; else fail pin "omp $omp_pin has SHA-256 $have, want $omp_sha"; fi

if out=$(in_box "$omp_bin" --version 2>&1) && [[ $out == *"$omp_pin"* ]]; then
  pass version "the pinned omp starts in the sandbox: $out"
else
  fail version "omp --version in the sandbox: $out"
fi

if out=$(in_box /bin/cat "$canary" 2>&1); then
  fail read-deny "the sandbox read $canary in the real home"
else
  pass read-deny "the sandbox cannot read the real home: $(printf '%s' "$out" | head -1)"
fi

if in_box /usr/bin/touch "$HOME/.ug-probe-write" >/dev/null 2>&1 || [[ -e $HOME/.ug-probe-write ]]; then
  fail write-deny "the sandbox wrote $HOME/.ug-probe-write in the real home"
else
  pass write-deny "the sandbox cannot write the real home"
fi

if out=$(in_box "$omp_bin" -p --no-session --model "$model" "Reply with only the word arena-ok." 2>&1) && [[ $out == *arena-ok* ]]; then
  pass prompt "a prompt through the auth gateway works with model $model"
else
  fail prompt "omp -p with model $model: $(printf '%s' "$out" | tail -5)"
fi

new=$(cd "$arena" && find .omp -mindepth 1 ! -path .omp/agent ! -path .omp/agent/models.yml | head -5 | tr '\n' ' ') || true
if [[ -n $new ]]; then
  pass home "omp wrote its own files in the arena, so it uses HOME: $new"
else
  fail home "omp wrote nothing in the arena's .omp, so it may not use HOME"
fi

if out=$(BUN_BE_BUN=1 "$omp_bin" "$srt_cli" --version 2>&1) && [[ $out == "$srt_pin" ]]; then
  info srt-on-bun "srt starts on the bun inside omp, so node could go (principle 9)"
else
  info srt-on-bun "srt does not start on the bun inside omp: $(printf '%s' "$out" | head -1)"
fi

if [[ ${KEEP:-} == 1 ]]; then info keep "the arena stays in $arena"; fi
printf '%s\n' "$([[ $fails -eq 0 ]] && echo 'all checks passed' || echo "$fails check(s) failed")"
exit "$fails"
