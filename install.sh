#!/usr/bin/env bash
set -euo pipefail

src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
labels="com.underground.broker com.underground.auth-broker com.underground.auth-gateway com.underground.usage-broker"
agents_dir="$HOME/Library/LaunchAgents"
addresses_file="$HOME/.config/underground-broker/addresses"
install_record="$HOME/.agents/install-manifest"
engine_default=100.64.0.99:8081
tailscale_app=/Applications/Tailscale.app/Contents/MacOS/Tailscale
gateway=""
engine=""
node_bin=/opt/homebrew/bin/node
gh_bin=/opt/homebrew/bin/gh
npm_bin=/opt/homebrew/bin/npm
srt_package=@anthropic-ai/sandbox-runtime
# shellcheck disable=SC2016
omp_alias_line='alias omp="$HOME/.agents/bin/omp"'

targets="
host/bin/omp|$HOME/.agents/bin/omp|755|render
host/bin/omp-inner|$HOME/.agents/bin/omp-inner|755|copy
host/bin/broker|$HOME/.agents/bin/broker|755|copy
host/bin/ug-install|$HOME/.agents/bin/ug-install|755|copy
host/sandbox/render-settings|$HOME/.agents/sandbox/render-settings|755|copy
host/sandbox/render-settings.ts|$HOME/.agents/sandbox/render-settings.ts|644|copy
host/sandbox/srt-settings.template.json|$HOME/.agents/sandbox/srt-settings.template.json|644|copy
host/broker/server.ts|$HOME/.agents/broker/server.ts|644|copy
host/broker/client.ts|$HOME/.agents/broker/client.ts|644|copy
host/broker/protocol.ts|$HOME/.agents/broker/protocol.ts|644|copy
host/broker/push-record.ts|$HOME/.agents/broker/push-record.ts|644|copy
host/broker/review-records.ts|$HOME/.agents/broker/review-records.ts|644|copy
host/broker/github-app.ts|$HOME/.agents/broker/github-app.ts|644|copy
host/broker/admin.ts|$HOME/.agents/broker/admin.ts|644|copy
host/broker/owner-files.ts|$HOME/.agents/broker/owner-files.ts|644|copy
host/broker/gateway.ts|$HOME/.agents/broker/gateway.ts|644|copy
host/broker/display-prefs.ts|$HOME/.agents/broker/display-prefs.ts|644|copy
host/broker/usage-broker.ts|$HOME/.agents/broker/usage-broker.ts|644|copy
host/roles/policy.yml|$HOME/.agents/roles/policy.yml|644|copy
host/roles/models.yml|$HOME/.agents/roles/models.yml|644|copy
host/roles/author/AGENTS.md|$HOME/.agents/roles/author/AGENTS.md|644|copy
host/roles/code-review/AGENTS.md|$HOME/.agents/roles/code-review/AGENTS.md|644|copy
host/roles/security-review/AGENTS.md|$HOME/.agents/roles/security-review/AGENTS.md|644|copy
host/roles/risk-review/AGENTS.md|$HOME/.agents/roles/risk-review/AGENTS.md|644|copy
host/roles/author/network-allowlist|$HOME/.agents/roles/author/network-allowlist|644|copy
host/roles/code-review/network-allowlist|$HOME/.agents/roles/code-review/network-allowlist|644|copy
host/roles/security-review/network-allowlist|$HOME/.agents/roles/security-review/network-allowlist|644|copy
host/roles/risk-review/network-allowlist|$HOME/.agents/roles/risk-review/network-allowlist|644|copy
host/roles/hooks/pre/concise-reply.ts|$HOME/.agents/roles/hooks/pre/concise-reply.ts|644|copy
host/roles/hooks/pre/role-rules.ts|$HOME/.agents/roles/hooks/pre/role-rules.ts|644|copy
host/launchd/com.underground.broker.plist|$agents_dir/com.underground.broker.plist|644|render
host/launchd/com.underground.auth-broker.plist|$agents_dir/com.underground.auth-broker.plist|644|render
host/launchd/com.underground.auth-gateway.plist|$agents_dir/com.underground.auth-gateway.plist|644|render
host/launchd/com.underground.usage-broker.plist|$agents_dir/com.underground.usage-broker.plist|644|render
"

dirs="
$HOME/.agents/bin|-
$HOME/.agents/bin/pinned|-
$HOME/.agents/sandbox|-
$HOME/.agents/sandbox/run|700
$HOME/.agents/roles|-
$HOME/.agents/roles/author|-
$HOME/.agents/roles/code-review|-
$HOME/.agents/roles/security-review|-
$HOME/.agents/roles/risk-review|-
$HOME/.agents/roles/hooks|-
$HOME/.agents/roles/hooks/pre|-
$HOME/.ug|700
$HOME/.ug/omp|700
$HOME/.agents/broker|-
$HOME/.agents/broker/run|700
$HOME/.agents/broker/repos|-
$HOME/.agents/broker/tmp|700
$HOME/.config/underground-broker|700
$HOME/.agents/auth|700
$HOME/Library/LaunchAgents|-
"

pin() {
  local value
  value=$(sed -n "s/^$1=//p" "$src/VERSIONS")
  [[ $value =~ ^[0-9A-Za-z.+-]+$ ]] || { printf 'install: bad pin for %s in VERSIONS\n' "$1" >&2; exit 1; }
  printf '%s\n' "$value"
}

srt_pin=$(pin srt)
omp_pin=$(pin omp)
omp_bin="$HOME/Library/Application Support/Tern/omp/versions/$omp_pin"
srt_dir="$HOME/.agents/srt/$srt_pin"
srt_cli="$srt_dir/node_modules/$srt_package/dist/cli.js"

sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'
}

desired() {
  local rel=$1 how=$2
  if [[ $how == render ]]; then
    sed -e "s|@OMP_PIN@|$omp_pin|g" -e "s|@SRT_PIN@|$srt_pin|g" -e "s|@HOME@|$(sed_escape "$HOME")|g" -e "s|@GATEWAY@|$gateway|g" -e "s|@ENGINE@|$engine|g" "$src/$rel"
  else
    cat "$src/$rel"
  fi
}

write_addresses() {
  local tailscale ip tmp
  [[ -e $addresses_file || -L $addresses_file ]] && return 0
  if command -v tailscale >/dev/null 2>&1; then
    tailscale=tailscale
  elif [[ -x $tailscale_app ]]; then
    tailscale=$tailscale_app
  else
    printf 'install: tailscale is not installed, so install cannot find the tailscale address of this mac; install tailscale, or write %s with the lines gateway=<tailscale address of this mac>:4000 and engine=%s\n' "$addresses_file" "$engine_default" >&2
    exit 1
  fi
  ip=$("$tailscale" ip -4 2>/dev/null) || ip=""
  ip=${ip%%$'\n'*}
  if [[ ! $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    printf 'install: tailscale ip -4 printed no IPv4 address; start tailscale, or write %s with the lines gateway=<tailscale address of this mac>:4000 and engine=%s\n' "$addresses_file" "$engine_default" >&2
    exit 1
  fi
  tmp=$(mktemp "$addresses_file.XXXXXX")
  printf 'gateway=%s:4000\nengine=%s\n' "$ip" "$engine_default" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$addresses_file"
}

load_addresses() {
  local out
  out=$("$node_bin" "$src/host/broker/admin.ts" addresses) || exit 1
  gateway=${out%% *}
  engine=${out#* }
}

srt_version() {
  [[ -x $node_bin && -f $srt_cli ]] || return 0
  "$node_bin" "$srt_cli" --version 2>/dev/null || true
}

restart_service() {
  local label=$1 err
  launchctl bootout "gui/$UID/$label" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "gui/$UID/$label" >/dev/null 2>&1 || break
    sleep 0.5
  done
  for _ in 1 2 3 4 5; do
    if err=$(launchctl bootstrap "gui/$UID" "$agents_dir/$label.plist" 2>&1); then
      return 0
    fi
    sleep 1
  done
  printf '%s\ninstall: launchctl bootstrap of %s failed\n' "$err" "$label" >&2
  exit 1
}

# An omp daemon broker keeps the sandbox rules of the session that started it, and outlives that session.
# After a rules change, each session must get a broker under the new rules, so stop every broker here.
stop_role_brokers() {
  local file pid n=0
  for file in "$HOME"/.ug/omp/underground/state/*/omp/run/daemons/*/*/broker.pid; do
    [[ -f $file ]] || continue
    pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$file")
    [[ -n $pid ]] || continue
    [[ $(ps -o command= -p "$pid" 2>/dev/null) == *" __omp_worker_daemon_broker" ]] || continue
    kill "$pid" && n=$((n + 1))
  done
  [[ $n -eq 0 ]] || printf 'install: stopped %s omp daemon broker(s) that ran under the old rules; restart open role sessions\n' "$n"
}

install_srt() {
  [[ $(srt_version) == "$srt_pin" ]] && return 0
  [[ -x $node_bin ]] || { printf 'install: missing %s\n' "$node_bin" >&2; exit 1; }
  [[ -x $npm_bin ]] || { printf 'install: missing %s\n' "$npm_bin" >&2; exit 1; }
  mkdir -p "$srt_dir"
  if ! (cd / && "$npm_bin" install --prefix "$srt_dir" --ignore-scripts --no-audit --no-fund "$srt_package@$srt_pin"); then
    printf 'install: npm install of %s@%s into %s failed\n' "$srt_package" "$srt_pin" "$srt_dir" >&2
    exit 1
  fi
}

check_deps() {
  local bad=0 have
  [[ -x $node_bin ]] || { printf 'missing: %s\n' "$node_bin"; bad=1; }
  [[ -x $gh_bin ]] || { printf 'missing: %s\n' "$gh_bin"; bad=1; }
  command -v git >/dev/null 2>&1 || { printf 'missing: git\n'; bad=1; }
  if [[ -f $srt_cli ]]; then
    have=$(srt_version)
    [[ $have == "$srt_pin" ]] || { printf 'srt version: have %s, want %s\n' "${have:-unknown}" "$srt_pin"; bad=1; }
  else
    printf 'missing: %s\n' "$srt_cli"
    bad=1
  fi
  [[ -x $omp_bin ]] || { printf 'missing: %s\n' "$omp_bin"; bad=1; }
  return "$bad"
}

# The full suite, before any file or service of the install changes. Most host tests run only
# on this Mac (CI skips them), so a skipped test fails the install as a failed test does.
run_tests() {
  local tap status=0
  tap=$(mktemp "${TMPDIR:-/tmp}/ug-tests.XXXXXX") || return 1
  "$node_bin" --test --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=tap --test-reporter-destination="$tap" \
    "$src"/tests/broker/*.test.ts "$src"/tests/host/*.test.ts || status=$?
  if [[ $status -ne 0 ]] || ! grep -qx '# fail 0' "$tap" || ! grep -qx '# skipped 0' "$tap" || ! grep -qx '# todo 0' "$tap"; then
    grep -E '^# (tests|pass|fail|skipped|todo) ' "$tap" >&2 || true
    rm -f "$tap"
    printf 'install: the test suite did not pass in full, so nothing is installed\n' >&2
    return 1
  fi
  rm -f "$tap"
}

install_file() {
  local rel=$1 dest=$2 mode=$3 how=$4 tmp
  tmp=$(mktemp "$(dirname "$dest")/.install.XXXXXX")
  desired "$rel" "$how" >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
}

# The install record: each file this install wrote with its mode and hash, each folder it set a mode on,
# and the macOS build it ran on. The wrapper's preflight compares this mac with it at each launch.
write_install_record() {
  local dir mode rel dest how hash tmp
  tmp=$(mktemp "$install_record.XXXXXX")
  {
    printf 'os\t%s\n' "$(sw_vers -buildVersion)"
    while IFS='|' read -r dir mode; do
      [[ -n $dir && $mode != - && -d $dir ]] || continue
      printf 'dir\t%s\t-\t%s\n' "$mode" "$dir"
    done <<<"$dirs"
    while IFS='|' read -r rel dest mode how; do
      [[ -n $rel && -f $dest ]] || continue
      hash=$(shasum -a 256 <"$dest")
      printf 'file\t%s\t%s\t%s\n' "$mode" "${hash%% *}" "$dest"
    done <<<"$targets"
  } >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$install_record"
}

make_dirs() {
  local dir mode
  while IFS='|' read -r dir mode; do
    [[ -n $dir ]] || continue
    mkdir -p "$dir"
    [[ $mode == - ]] || chmod "$mode" "$dir"
  done <<<"$dirs"
}

run_install() {
  local rel dest mode how label
  install_srt
  if ! check_deps; then
    printf 'install: fix the dependencies above first\n' >&2
    exit 1
  fi
  run_tests || exit 1
  make_dirs
  if [[ ! -e $HOME/.config/underground-broker/roles ]]; then
    install_file host/roles/roles "$HOME/.config/underground-broker/roles" 600 copy
  fi
  write_addresses
  load_addresses
  while IFS='|' read -r rel dest mode how; do
    [[ -n $rel ]] || continue
    [[ -f $src/$rel ]] || { printf 'install: source file missing: %s\n' "$rel" >&2; exit 1; }
    install_file "$rel" "$dest" "$mode" "$how"
  done <<<"$targets"
  ln -sfn "$omp_bin" "$HOME/.agents/bin/pinned/omp"
  stop_role_brokers

  if ! grep -qxF "$omp_alias_line" "$HOME/.zshrc" 2>/dev/null; then
    printf '\n%s\n' "$omp_alias_line" >>"$HOME/.zshrc"
    printf 'install: added to %s: %s\n' "$HOME/.zshrc" "$omp_alias_line"
  fi

  "$node_bin" "$HOME/.agents/broker/admin.ts" gateway-setup

  for label in $labels; do
    restart_service "$label"
  done

  if ! "$omp_bin" --help </dev/null >/dev/null 2>&1; then
    printf 'install: %s --help failed, so the omp native addon is not unpacked in %s\n' "$omp_bin" "$HOME/.omp/natives/$omp_pin" >&2
    exit 1
  fi
  write_install_record
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  [[ $# -eq 0 ]] || { printf 'usage: install.sh\n' >&2; exit 64; }
  run_install
fi
