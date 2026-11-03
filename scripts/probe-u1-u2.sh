#!/usr/bin/env bash
# The U1 and U2 canary probes of docs/SPEC.md, section Checks.
#
#   scripts/probe-u1-u2.sh plant     on the host: plant the canaries
#   scripts/probe-u1-u2.sh read      on the host, then in an arena session: read each canary
#   scripts/probe-u1-u2.sh remove    on the host: remove the canaries
#
# Each read prints one line: <probe>  <open|blocked|inconclusive|ok>  <evidence>.
# On the host every probe must print ok; in the sandbox, open means the probe read its target
# (the canary; for ssh-dir a listing that exits 0, even an empty one; for apple-events an answer
# from a command that exits 0), blocked means the sandbox refused with "Operation not permitted",
# and inconclusive is anything else, including a plain unix "Permission denied" or a macOS
# privacy (TCC) refusal.
set -uo pipefail

canary="UG-CANARY-7f3a9c2e"
service="ug-probe-u1"
domain="ug.probe.u2"

plant() {
  security add-generic-password -a "$USER" -s "$service" -w "$canary" -U || return 1
  defaults write "$domain" canary "$canary" || return 1
  printf '%s' "$canary" | pbcopy || return 1
  printf 'planted: keychain item %s, preference %s, clipboard\n' "$service" "$domain"
}

remove() {
  security delete-generic-password -s "$service" >/dev/null 2>&1 || printf 'keychain item %s was not there\n' "$service"
  defaults delete "$domain" >/dev/null 2>&1 || printf 'preference %s was not there\n' "$domain"
  printf '' | pbcopy
  printf 'removed: keychain item, preference, clipboard\n'
}

# The arena wrapper sets the arena ~/.ug/home as HOME inside the sandbox (host/arena/init).
in_sandbox() { [[ ${HOME:-} == */.ug/home ]]; }

# kind is canary (read means the output has the canary), exit (read means exit 0), or answer
# (read means exit 0 with output).
classify() {
  local probe=$1 kind=$2 out=$3 err=$4 status=$5 read=no
  case $kind in
    canary) [[ $out == *"$canary"* ]] && read=yes ;;
    exit) [[ $status == 0 ]] && read=yes ;;
    answer) [[ $status == 0 && -n $out ]] && read=yes ;;
  esac
  if [[ $read == yes ]]; then
    if in_sandbox; then
      printf '%s  open  exit %s: %s\n' "$probe" "$status" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
    else
      printf '%s  ok\n' "$probe"
    fi
  elif [[ $err == *"Operation not permitted"* ]]; then
    printf '%s  blocked  exit %s: %s\n' "$probe" "$status" "$(printf '%s' "$err" | head -1)"
  else
    printf '%s  inconclusive  exit %s: %s\n' "$probe" "$status" "$(printf '%s%s' "$out" "$err" | tr '\n' ' ' | cut -c1-160)"
  fi
}

probe() {
  local name=$1 kind=$2 out err status err_file
  shift 2
  err_file=$(mktemp "${TMPDIR:-/tmp}/ug-probe.XXXXXX") || { printf '%s  inconclusive  mktemp failed\n' "$name"; return; }
  out=$("$@" 2>"$err_file"); status=$?
  err=$(<"$err_file")
  rm -f "$err_file"
  classify "$name" "$kind" "$out" "$err" "$status"
}

# Prints the canary if the file opens, so a read counts as open; the file itself is encrypted or binary.
opens() {
  head -c 1 "$1" >/dev/null && printf '%s' "$canary"
}

read_all() {
  local shot
  probe "U1 keychain" canary security find-generic-password -s "$service" -w
  probe "U1 keychain-file" canary opens "$HOME/Library/Keychains/login.keychain-db"
  probe "U1 ssh-dir" exit ls "$HOME/.ssh"
  probe "U2 preference" canary defaults read "$domain" canary
  probe "U2 preference-file" canary opens "$HOME/Library/Preferences/$domain.plist"
  probe "U2 clipboard" canary pbpaste
  probe "U2 apple-events" answer osascript -e 'tell application "Finder" to get name of startup disk'
  shot=${TMPDIR:-/tmp}/ug-probe-screen.png
  rm -f "$shot"
  if screencapture -x "$shot" 2>/dev/null && [[ -s $shot ]]; then
    printf 'U2 screen  %s  wrote %s bytes to %s; open only if the image shows the screen\n' "$(in_sandbox && printf inconclusive || printf ok)" "$(stat -f %z "$shot")" "$shot"
  else
    printf 'U2 screen  %s  screencapture failed or wrote nothing\n' "$(in_sandbox && printf inconclusive || printf broken)"
  fi
}

case ${1:-} in
  plant) plant ;;
  read) read_all ;;
  remove) remove ;;
  *) printf 'usage: %s plant|read|remove\n' "$0" >&2; exit 64 ;;
esac
