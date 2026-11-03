#!/usr/bin/env bash
# The arena probe (docs/SPEC.md, Checks). It runs the pinned omp under the pinned srt with a
# throwaway arena as HOME, and then tries to break out of the sandbox.
#
#   host/bin/ug-setup          first: puts the pinned omp and srt in ~/.ug/sys
#   scripts/probe-arena.sh     then: prints one line per check
#
# Results:
#   PASS  the check ran, its control worked, and the expected result happened
#   FAIL  the expected result did not happen; BREACH marks a check that got through the sandbox
#   INC   inconclusive: the control did not work, so the check proves nothing. Counts as a fail.
#   GAP   a known hole of the current build, named in docs/SPEC.md. Printed, not hidden.
#   INFO  a fact for a later decision
# The exit status is the number of FAIL and INC lines.
#
# Every deny check has a control that must succeed first, and a deny counts only when the
# command fails with "Operation not permitted", the sandbox's own error. Any other failure is INC.
#
# It writes a fresh probe arena ~/.ug/probe/home, one settings file in ~/.ug/run, and one canary
# file in the home folder, and deletes them at the end (KEEP=1 keeps the arena). It never
# touches ~/.agents, ~/.ug/omp, ~/.omp, or a running session.
#
# PROBE_MODEL picks the model of the prompt check (default anthropic/claude-opus-5-5); its provider
# must be one that omp knows, such as anthropic or openai-codex. The probe writes its own models.yml
# with that one provider on the gateway address with the gateway bearer, as the arena wrapper fills
# the config repo's models.yml, so it tests the walls and not the owner's model choices.
# shellcheck disable=SC2016  # single quotes hold sh -c and node -e code that must not expand here
# shellcheck disable=SC2329  # cleanup runs from the EXIT trap
set -euo pipefail

src=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
node_bin=${UG_PROBE_NODE:-/opt/homebrew/bin/node}
pin() { sed -n "s/^$1=//p" "$src/VERSIONS"; }
omp_pin=$(pin omp)
omp_sha=$(pin omp_sha256)
srt_pin=$(pin srt)
sys="$HOME/.ug/sys"
omp_bin="$sys/omp/$omp_pin/omp"
srt_cli="$sys/srt/$srt_pin/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js"
probe_root="$HOME/.ug/probe"
arena="$probe_root/home"
run_dir="$HOME/.ug/run"
settings="$run_dir/probe-arena.json"
canary="$HOME/.ug-probe-canary"
canary_text="ug-probe-canary-$$-$RANDOM"
write_target="$HOME/.ug-probe-write"
model=${PROBE_MODEL:-anthropic/claude-opus-5-5}
gateway_token_file="$HOME/.ug/host/auth/auth-gateway.token"
addresses="$HOME/.ug/host/addresses"
denied='Operation not permitted'

fails=0
gaps=0
line() { printf '%-6s %-14s %s\n' "$1" "$2" "$3"; }
pass() { line PASS "$1" "$2"; }
fail() { line FAIL "$1" "$2"; fails=$((fails + 1)); }
breach() { line FAIL "$1" "BREACH: $2"; fails=$((fails + 1)); }
inc() { line INC "$1" "$2"; fails=$((fails + 1)); }
gap() { line GAP "$1" "$2"; gaps=$((gaps + 1)); }
info() { line INFO "$1" "$2"; }
first() { printf '%s' "$1" | head -1; }

cleanup() {
  rm -f "$canary" "$settings" "$write_target"
  [[ ${KEEP:-} == 1 ]] || rm -rf "$probe_root"
}
trap cleanup EXIT

for need in "$node_bin" "$omp_bin" "$srt_cli" "$gateway_token_file" "$addresses"; do
  [[ -e $need ]] || { printf 'probe-arena: missing %s; run host/bin/ug-setup and the current install first\n' "$need" >&2; exit 1; }
done
gateway=$(sed -n 's/^gateway=//p' "$addresses")
[[ -n $gateway ]] || { printf 'probe-arena: no gateway= line in %s\n' "$addresses" >&2; exit 1; }
[[ ! -e $write_target ]] || { printf 'probe-arena: %s exists already; remove it first\n' "$write_target" >&2; exit 1; }

rm -rf "$probe_root"
install -d -m 700 "$probe_root" "$arena" "$arena/tmp" "$arena/.omp/agent" "$run_dir"
printf '%s\n' "$canary_text" >"$canary"
printf 'arena-control\n' >"$arena/control"

"$node_bin" -e '
  const fs = require("fs");
  const [file, home, arena, sys, allowlist, gateway, model, tokenFile] = process.argv.slice(1);
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const provider = model.split("/")[0];
  fs.writeFileSync(`${arena}/.omp/agent/models.yml`,
    `providers:\n  ${provider}:\n    transport: pi-native\n    baseUrl: "http://${gateway}"\n    apiKey: "${token}"\n`, { mode: 0o600 });
  const allowedDomains = fs.readFileSync(allowlist, "utf8").replaceAll("@GATEWAY@", gateway)
    .split("\n").map((l) => l.replace(/#.*/, "").trim()).filter((l) => l !== "" && !l.includes("@"));
  const settings = {
    filesystem: { denyRead: [home], allowRead: [arena, sys], allowWrite: [arena], denyWrite: [] },
    network: { allowedDomains, deniedDomains: [], allowUnixSockets: [arena], allowLocalBinding: true },
    allowAppleEvents: false,
    allowPty: true,
  };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
' "$settings" "$HOME" "$arena" "$sys" "$src/host/roles/network-allowlist" "$gateway" "$model" "$gateway_token_file"

# Run a command in the sandbox with the arena as HOME. The outer env -i keeps the owner's shell
# out; srt keeps the real HOME for itself and adds its proxy variables; the inner sh sets HOME and
# TMPDIR for the child and passes the proxy to omp as PI_PROXY, as host/arena/init does.
# It runs in box_cwd (default: the arena root) and sets out (stdout and stderr) and rc.
box_cwd=$arena
box() {
  set +e
  out=$(env -i HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm-256color}" \
    "$node_bin" "$srt_cli" --settings "$settings" -- /bin/sh -c '
      p=${https_proxy:-${HTTPS_PROXY:-}}
      if [ -n "$p" ]; then PI_PROXY=$p; export PI_PROXY; fi
      HOME=$1; TMPDIR=$1/tmp; export HOME TMPDIR; cwd=$2; shift 2
      cd "$cwd" && exec "$@"
    ' sh "$arena" "$box_cwd" "$@" 2>&1)
  rc=$?
  set -e
}

# --- the pinned omp ---------------------------------------------------------------------------

have=$(shasum -a 256 "$omp_bin") && have=${have%% *}
if [[ $have == "$omp_sha" ]]; then pass pin "omp $omp_pin has the SHA-256 in VERSIONS"; else fail pin "omp $omp_pin has SHA-256 $have, want $omp_sha"; fi

box /bin/cat "$arena/control"
if [[ $rc -eq 0 && $out == arena-control ]]; then
  box_works=1
  pass control "the sandbox starts and reads the arena"
else
  box_works=0
  fail control "the sandbox cannot read its own arena (rc $rc): $(first "$out")"
fi

log_start=$(date '+%Y-%m-%d %H:%M:%S')

box "$omp_bin" --version
if [[ $rc -eq 0 && $out == *"$omp_pin"* ]]; then pass version "the pinned omp starts in the sandbox: $(first "$out")"; else fail version "omp --version (rc $rc): $(first "$out")"; fi

# The design runs omp in a git clone in the arena, so the main prompt runs in one. Git runs only
# inside the sandbox, as the design requires.
repo="$arena/work/probe/repo"
box /bin/sh -c 'mkdir -p "$1" && cd "$1" && git init -q' sh "$repo"
if [[ $rc -eq 0 && -d $repo/.git ]]; then repo_ok=1; else repo_ok=0; fail repo "git init in the arena failed (rc $rc): $(first "$out")"; fi

sleep 1
log_repo_start=$(date '+%Y-%m-%d %H:%M:%S')
# The answer is not in the prompt, so an echo of the prompt cannot pass.
box_cwd=$repo
box "$omp_bin" -p --no-session --model "$model" "What is seventeen times twenty-three? Reply with the digits only."
box_cwd=$arena
if [[ $rc -eq 0 && $out == *391* ]]; then
  pass prompt "a prompt through the auth gateway works with $model, in a repo clone"
else
  fail prompt "omp -p with $model (rc $rc): $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
fi
log_repo_end=$(date '+%Y-%m-%d %H:%M:%S')
sleep 1

# The same prompt with no repo around it, in the arena root, as omp starts outside any repo.
log_norepo_start=$(date '+%Y-%m-%d %H:%M:%S')
box "$omp_bin" -p --no-session --model "$model" "What is seventeen times twenty-three? Reply with the digits only."

omp_files=$(cd "$arena" && find .omp -mindepth 1 ! -path .omp/agent ! -path .omp/agent/models.yml | head -5 | tr '\n' ' ') || true
if [[ -n $omp_files ]]; then pass home "omp wrote its files in the arena: $omp_files"; else fail home "omp wrote nothing in the arena's .omp"; fi
log_omp_end=$(date '+%Y-%m-%d %H:%M:%S')

# --- breach attempts --------------------------------------------------------------------------

if [[ $box_works -eq 0 ]]; then
  inc breaches "the control failed, so no deny below can be trusted"
else
  if [[ $(cat "$canary") != "$canary_text" ]]; then
    inc read-deny "the host cannot read its own canary"
  else
    box /bin/cat "$canary"
    if [[ $out == *"$canary_text"* ]]; then breach read-deny "the sandbox read $canary"
    elif [[ $rc -ne 0 && $out == *"$denied"* ]]; then pass read-deny "the sandbox cannot read the real home"
    else inc read-deny "cat failed for another reason (rc $rc): $(first "$out")"; fi
  fi

  # The same read through omp's own runtime. Its deny is also the calibration of home-reach below.
  box /usr/bin/env BUN_BE_BUN=1 UG_CANARY="$canary" "$omp_bin" -e 'process.stdout.write(require("fs").readFileSync(process.env.UG_CANARY, "utf8"))'
  if [[ $out == *"$canary_text"* ]]; then breach omp-read "omp's runtime read $canary"
  elif [[ $rc -ne 0 && ( $out == *"$denied"* || $out == *EPERM* ) ]]; then pass omp-read "omp's runtime cannot read the real home"
  else inc omp-read "the read failed for another reason (rc $rc): $(first "$out")"; fi

  box /usr/bin/touch "$write_target"
  if [[ -e $write_target ]]; then breach write-deny "the sandbox wrote $write_target"
  elif [[ $rc -ne 0 && $out == *"$denied"* ]]; then pass write-deny "the sandbox cannot write the real home"
  else inc write-deny "touch failed for another reason (rc $rc): $(first "$out")"; fi

  box /bin/sh -c 'ln -s "$1" "$HOME/sym" && cat "$HOME/sym"' sh "$canary"
  if [[ $out == *"$canary_text"* ]]; then breach symlink "a symlink in the arena read $canary"
  elif [[ -L $arena/sym && $out == *"$denied"* ]]; then pass symlink "a symlink in the arena does not open the real home"
  else inc symlink "the link step failed for another reason (rc $rc): $(first "$out")"; fi

  box /bin/sh -c 'ln "$1" "$HOME/hard" && cat "$HOME/hard"' sh "$canary"
  if [[ $out == *"$canary_text"* ]]; then breach hardlink "a hard link in the arena read $canary"
  elif [[ $out == *"$denied"* ]]; then pass hardlink "a hard link to the real home cannot be made or read"
  else inc hardlink "the link step failed for another reason (rc $rc): $(first "$out")"; fi

  # The ssh agent signs with the owner's keys. ssh-add -l: 0 or 1 means connected, 2 means not.
  sock=${SSH_AUTH_SOCK:-$(launchctl getenv SSH_AUTH_SOCK 2>/dev/null || true)}
  if [[ -z $sock || ! -S $sock ]]; then
    info ssh-agent "no ssh agent socket found, so the socket checks did not run"
  else
    set +e; SSH_AUTH_SOCK=$sock ssh-add -l >/dev/null 2>&1; host_rc=$?; set -e
    if [[ $host_rc -eq 2 ]]; then
      inc ssh-agent "the host itself cannot reach $sock"
    else
      box /usr/bin/env SSH_AUTH_SOCK="$sock" /usr/bin/ssh-add -l
      if [[ $rc -eq 0 || $rc -eq 1 ]]; then breach ssh-agent "the sandbox reached the ssh agent at $sock"
      else pass ssh-agent "the sandbox cannot reach the ssh agent (rc $rc)"; fi
      # The probe allows unix sockets in the whole arena. A link there must not reach a socket outside.
      box /bin/sh -c 'ln -s "$1" "$HOME/agent.sock" && SSH_AUTH_SOCK=$HOME/agent.sock /usr/bin/ssh-add -l' sh "$sock"
      if [[ $rc -eq 0 || $rc -eq 1 ]]; then breach socket-link "a socket link in the arena reached the ssh agent; allow only named sockets"
      elif [[ -L $arena/agent.sock ]]; then pass socket-link "a socket link in the arena does not reach the ssh agent (rc $rc)"
      else inc socket-link "the link step failed (rc $rc): $(first "$out")"; fi
    fi
  fi

  # Both fetches must go through srt's proxy: curl reports the proxy's CONNECT answer in
  # %{http_connect}. srt refuses a domain off the allowlist with a 403 to CONNECT
  # (srt dist/sandbox/request-filter.js, rawDenied). A DNS or network error is not a refusal.
  box /usr/bin/curl -sS -m 15 -o /dev/null -w '%{http_connect} %{http_code}' https://github.com
  if [[ $rc -ne 0 || $out != "200 "[23]* ]]; then
    inc egress "the control fetch of github.com did not go through srt's proxy (rc $rc): $(first "$out")"
  else
    box /usr/bin/curl -sS -m 15 -o /dev/null -w '%{http_connect} %{http_code}' https://example.com
    if [[ $rc -eq 0 && $out == *" "[23]* ]]; then breach egress "the sandbox reached example.com, which is not on the allowlist"
    elif [[ $out == *"403"* ]]; then pass egress "srt's proxy refused a domain off the allowlist (rc $rc)"
    else inc egress "the fetch of example.com failed, but not with the proxy's refusal (rc $rc): $(first "$out")"; fi
  fi

  box /usr/bin/curl -sS -m 5 http://127.0.0.1:8765/v1/healthz
  if [[ $rc -eq 0 ]]; then info localhost "OPEN: the sandbox reaches the auth broker port 8765 (accepted for now, U7)"
  else info localhost "the sandbox did not reach 127.0.0.1:8765 (rc $rc)"; fi
fi

# --- where did omp peek outside the arena? ----------------------------------------------------
# Not a safety check: the breach checks above prove that nothing gets through. This one lists the
# paths outside the arena that omp tried while it worked in the repo clone, and that the sandbox
# blocked. A blocked peek is the sandbox doing its job, so it passes. Known causes: omp looks for
# project agents in every folder above the working folder, up to / (omp config.ts,
# findAllNearestProjectConfigDirs), and macOS reads the owner's preferences from the real home.
# Every denied access is a kernel log line; omp's own canary deny (omp-read) shows that the log
# and the filter work. Only lines of a process named omp count: the probe's binary is
# ~/.ug/sys/omp/<pin>/omp, while the current harness runs a file named after its version.
if [[ $box_works -eq 1 ]] && command -v log >/dev/null 2>&1; then
  sleep 2
  omp_filter='[^A-Za-z0-9._-]omp\([0-9]+\) deny'
  omp_denies_in() {
    log show --style compact --start "$1" --end "$2" --predicate "eventMessage CONTAINS \"deny\" AND eventMessage CONTAINS \"$HOME/\"" 2>/dev/null |
      grep -E "$omp_filter" | grep -v -F -e "$probe_root" -e "$sys" | sed -E 's/.* deny\([0-9]+\) //' | sort -u | head -8 | tr '\n' ' '
  }
  set +e
  calibration=$(log show --style compact --start "$log_start" --predicate "eventMessage CONTAINS \"deny\" AND eventMessage CONTAINS \"$canary\"" 2>/dev/null | grep -E "$omp_filter" | head -1)
  set -e
  if [[ -z $calibration ]]; then
    info home-reach "omp's canary deny is not in the log, so the log cannot show where omp peeked"
  elif [[ $repo_ok -eq 1 ]]; then
    peeks=$(omp_denies_in "$log_repo_start" "$log_repo_end") || true
    if [[ -z $peeks ]]; then pass home-reach "in a repo clone, omp did not peek outside the arena"
    else pass home-reach "in a repo clone, omp peeked outside the arena and the sandbox blocked it: $peeks"; fi
    peeks=$(omp_denies_in "$log_norepo_start" "$log_omp_end") || true
    info home-norepo "with no repo, the sandbox blocked: ${peeks:-nothing}"
  fi
else
  info home-reach "no sandbox or no log tool, so it did not run"
fi

# --- known gaps and facts -------------------------------------------------------------------------

# A raw omp: the pinned binary by full path, on the host, with no sandbox and the real home, as an
# owner's slip or a stray script would start it. It must get no answer: its home ~/.omp holds no
# login and no token, because the auth services keep theirs in ~/.ug/host/auth. Its --version is the
# control. A raw run that answers is a session outside the sandbox (U36).
raw() {
  set +e
  out=$(cd / && env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG="${LANG:-en_US.UTF-8}" \
    perl -e 'alarm shift; exec @ARGV' 120 "$omp_bin" "$@" 2>&1)
  rc=$?
  set -e
}
raw --version
if [[ $rc -ne 0 || $out != *"$omp_pin"* ]]; then
  inc raw-omp "the raw omp does not start (rc $rc), so the check proves nothing: $(first "$out")"
else
  raw -p --no-session --model "$model" "What is seventeen times twenty-three? Reply with the digits only."
  if [[ $rc -eq 0 && $out == *391* ]]; then breach raw-omp "a raw omp by full path answered with no sandbox; it found a login or a token"
  else pass raw-omp "a raw omp by full path gets no answer (rc $rc): $(first "$out")"; fi
fi

# Every model that a raw omp can call, not one: omp auth-gateway stdio answers /v1/models from the
# same logins, models.yml, and settings as any omp command, and lists only the models that have a
# credential or need none (omp docs/auth-broker-gateway.md, stdio and /v1/models, omp 18.13.2). It
# runs in the caller's own environment, not env -i, because a key in the owner's shell reaches a
# raw omp too, and it covers the keyless built-in providers (apple, lm-studio, ollama, llama.cpp),
# which disabledProviders in the config repo's raw-omp/config.yml turns off (docs/SPEC.md, B2).
# The stdio reply is the control: no list in it proves nothing.
set +e
out=$(cd / && printf '%s\n' '{"id":1,"path":"/v1/models"}' | perl -e 'alarm shift; exec @ARGV' 120 "$omp_bin" auth-gateway stdio 2>&1)
rc=$?
models=$(printf '%s\n' "$out" | "$node_bin" -e '
  const lines = require("fs").readFileSync(0, "utf8").split("\n");
  for (const line of lines) {
    let reply;
    try { reply = JSON.parse(line); } catch { continue; }
    if (reply?.id !== 1) continue;
    const data = reply.body?.data;
    if (reply.status !== 200 || !Array.isArray(data)) process.exit(1);
    process.stdout.write(data.map((m) => String(m?.id)).join(" "));
    process.exit(0);
  }
  process.exit(1);
')
listed=$?
set -e
if [[ $listed -ne 0 ]]; then
  inc raw-models "the raw omp gave no model list (rc $rc), so the check proves nothing: $(first "$out")"
elif [[ -n $models ]]; then
  breach raw-models "a raw omp by full path, in your own environment, can call: $models; turn each off with disabledProviders in the config repo's raw-omp/config.yml, or take away its key"
else
  pass raw-models "a raw omp by full path, in your own environment, lists no model"
fi
if out=$(BUN_BE_BUN=1 "$omp_bin" "$srt_cli" --version 2>&1) && [[ $out == "$srt_pin" ]]; then
  info srt-on-bun "srt starts on the bun inside omp; a sandboxed run on it is not tested yet"
else
  info srt-on-bun "srt does not start on the bun inside omp: $(first "$out")"
fi

[[ ${KEEP:-} != 1 ]] || info keep "the arena stays in $arena"
printf '%s failed or inconclusive, %s known gap(s)\n' "$fails" "$gaps"
exit "$fails"
