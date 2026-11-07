#!/usr/bin/env bash
set -uo pipefail

canary="UG-CANARY-7f3a9c2e"
service="ug-probe-u1"
domain="ug.probe.u2"
dp_site="ug-canary.invalid"

plant() {
  security add-generic-password -a "$USER" -s "$service" -w "$canary" -U || return 1
  defaults write "$domain" canary "$canary" || return 1
  printf '%s' "$canary" | pbcopy || return 1
  printf 'planted: keychain item %s, preference %s, clipboard\n' "$service" "$domain"
  printf 'by hand: in the Passwords app, add a password for the website %s, user ug, password %s, for U1 dp-keychain\n' "$dp_site" "$canary"
}

remove() {
  security delete-generic-password -s "$service" >/dev/null 2>&1 || printf 'keychain item %s was not there\n' "$service"
  defaults delete "$domain" >/dev/null 2>&1 || printf 'preference %s was not there\n' "$domain"
  printf '' | pbcopy
  printf 'removed: keychain item, preference, clipboard; delete the %s password in the Passwords app by hand\n' "$dp_site"
}

in_sandbox() { [[ ${HOME:-} == */.ug/home ]]; }

real_home() { if in_sandbox; then printf '%s' "${HOME%/.ug/home}"; else printf '%s' "$HOME"; fi; }

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

opens() {
  head -c 1 "$1" >/dev/null && printf '%s' "$canary"
}

SERVICES=(
  "svc-control com.apple.system.logger"
  "svc-microphone com.apple.audio.coreaudiod"
  "svc-camera com.apple.cmio.registerassistantservice"
  "svc-camera-vdc com.apple.cmio.VDCAssistant"
  "svc-keystrokes com.apple.windowserver.active"
  "svc-tcc com.apple.tccd"
  "svc-tcc-system com.apple.tccd.system"
)
LOOKUP='import ctypes, sys
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
boot = ctypes.c_uint.in_dll(lib, "bootstrap_port").value
for name in sys.argv[1:]:
    port = ctypes.c_uint()
    print(name, lib.bootstrap_look_up(boot, name.encode(), ctypes.byref(port)))'

services() {
  local py="${UG_PROBE_PYTHON:-}" entry label name codes code control
  if [[ -z $py ]]; then
    for py in /opt/homebrew/bin/python3 /usr/bin/python3 ""; do [[ -n $py && -x $py ]] && break; done
  fi
  if [[ -z $py ]]; then
    printf 'U2 services  inconclusive  no python3 to run the lookups\n'
    return
  fi
  local names=()
  for entry in "${SERVICES[@]}"; do names+=("${entry#* }"); done
  codes=$("$py" -I -c "$LOOKUP" "${names[@]}" 2>&1)
  control=$(printf '%s\n' "$codes" | awk '$1 == "com.apple.system.logger" { print $2 }')
  for entry in "${SERVICES[@]}"; do
    label="U2 ${entry%% *}"
    name=${entry#* }
    code=$(printf '%s\n' "$codes" | awk -v n="$name" '$1 == n { print $2 }')
    if [[ ! $code =~ ^[0-9]+$ ]]; then
      printf '%s  inconclusive  the lookup of %s printed no code: %s\n' "$label" "$name" "$(printf '%s' "$codes" | tr '\n' ' ' | cut -c1-160)"
    elif ! in_sandbox; then
      case $code in
        0) printf '%s  ok\n' "$label" ;;
        1102) printf '%s  absent  %s is not a service on this macOS\n' "$label" "$name" ;;
        *) printf '%s  broken  the host lookup of %s returned %s\n' "$label" "$name" "$code" ;;
      esac
    elif [[ $label == "U2 svc-control" ]]; then
      if [[ $code == 0 ]]; then printf '%s  ok  the lookup works in the sandbox\n' "$label"
      else printf '%s  inconclusive  the allowed %s returned %s, so the lookups prove nothing\n' "$label" "$name" "$code"; fi
    elif [[ $control != 0 ]]; then
      printf '%s  inconclusive  the control failed, so %s proves nothing\n' "$label" "$name"
    else
      case $code in
        0) printf '%s  open  the sandbox reached %s\n' "$label" "$name" ;;
        1100) printf '%s  blocked  %s refused (1100); see the kernel log for deny mach-lookup\n' "$label" "$name" ;;
        1102) printf '%s  absent  %s is not a service on this macOS\n' "$label" "$name" ;;
        *) printf '%s  inconclusive  %s returned %s\n' "$label" "$name" "$code" ;;
      esac
    fi
  done
}

read_all() {
  local shot home
  home=$(real_home)
  probe "U1 keychain" canary security find-generic-password -s "$service" -w
  probe "U1 keychain-path" canary security find-generic-password -s "$service" -w "$home/Library/Keychains/login.keychain-db"
  probe "U1 keychain-file" canary opens "$home/Library/Keychains/login.keychain-db"
  probe "U1 ssh-dir" exit ls "$home/.ssh"
  probe "U1 dp-keychain" canary security find-internet-password -s "$dp_site" -w
  probe "U2 preference" canary defaults read "$domain" canary
  probe "U2 preference-path" canary defaults read "$home/Library/Preferences/$domain" canary
  probe "U2 preference-file" canary opens "$home/Library/Preferences/$domain.plist"
  probe "U2 clipboard" canary pbpaste
  probe "U2 apple-events" answer osascript -e 'tell application "Finder" to get name of startup disk'
  shot=${TMPDIR:-/tmp}/ug-probe-screen.png
  rm -f "$shot"
  if screencapture -x "$shot" 2>/dev/null && [[ -s $shot ]]; then
    printf 'U2 screen  %s  wrote %s bytes to %s; open only if the image shows the screen\n' "$(in_sandbox && printf inconclusive || printf ok)" "$(stat -f %z "$shot")" "$shot"
  else
    printf 'U2 screen  %s  screencapture failed or wrote nothing\n' "$(in_sandbox && printf inconclusive || printf broken)"
  fi
  services
}

case ${1:-} in
  plant) plant ;;
  read) read_all ;;
  remove) remove ;;
  *) printf 'usage: %s plant|read|remove\n' "$0" >&2; exit 64 ;;
esac
