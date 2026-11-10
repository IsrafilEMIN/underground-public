#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=host/lib/ug.bash disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/host/lib/ug.bash"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""
fi

TOTAL_STAGES=0

_STAGE_INDEX=0
SKIPPED=()

_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1 && tput clear 2>/dev/null; then return 0; fi
  printf '\033[2J\033[3J\033[H'
}

banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C; a re-run\n'
  printf '  later starts from the top and asks for every value again.%s\n' "$RESET"
  pause "Ready to start?"
}

stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else false; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

ask() {
  local key="$1" prompt="$2" input s=$'\001' e=$'\002' p rc=0
  p="  $s$BOLD$e$prompt$s$RESET$e "
  read -e -r -p "$p" input || rc=1
  if (( rc )) && [[ -z "$input" ]]; then return 1; fi
  printf -v "$key" '%s' "$input"
}

finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

repo_from_checkout() {
  local origin slug owner name
  origin=$(git -C "$1" config --get remote.origin.url 2>/dev/null) || {
    printf 'Cannot read origin from checkout: %s\n' "$1" >&2
    return 1
  }
  slug=$(ug_repo_slug "$1") || {
    printf 'Origin must be a GitHub SSH or HTTPS URL: %s\n' "$origin" >&2
    return 1
  }
  owner=${slug%%/*}
  name=${slug#*/}
  if [[ ! "$owner" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ || ! "$name" =~ ^[A-Za-z0-9_.-]+$ || "$name" == . || "$name" == .. ]]; then
    printf 'Invalid GitHub repository in origin: %s\n' "$origin" >&2
    return 1
  fi
  printf '%s\n' "$slug"
}

newest_key() {
  local newest="" file
  for file in "$1/$2".*.private-key.pem; do
    [[ -f $file ]] || continue
    if [[ -z $newest || $file -nt $newest ]]; then newest=$file; fi
  done
  printf '%s' "$newest"
}

run_wizard() {

TOTAL_STAGES=5

CONFIG_DIR="$HOME/$(ug_fact owner_data)"
APP_JSON="$CONFIG_DIR/github-app.json"
APP_PEM="$CONFIG_DIR/github-app.pem"
SCRIPT_CHECKOUT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
ask CHECKOUT "Your checkout (Enter takes $SCRIPT_CHECKOUT):"
[[ -n $CHECKOUT ]] || CHECKOUT=$SCRIPT_CHECKOUT
REPO=$(repo_from_checkout "$CHECKOUT") || return 1

banner "gh-broker GitHub App: your own app, on selected repos"

stage "Register the GitHub App"
say "The gh-broker acts as a GitHub App that your account owns. GitHub shows it as <app slug>[bot]."
open_url "https://github.com/settings/apps/new"
step "GitHub App name: a free name, for example underground-gh-broker-<your login>."
step "Homepage URL: https://github.com/$REPO"
step "Webhook: clear 'Active'. The gh-broker uses no webhooks."
step "Repository permissions, and nothing else:"
step "  Contents: Read and write"
step "  Pull requests: Read and write"
step "  Metadata: Read-only (GitHub sets this one itself)"
step "  Checks: Read-only"
step "  Commit statuses: Read-only"
step "Leave Workflows and Administration on 'No access'. Leave every account permission on 'No access'."
step "Where can this GitHub App be installed: 'Only on this account'."
step "Click 'Create GitHub App'."
step "On the app's page, copy the 'Client ID' (it starts with Iv)."
ask APP_CLIENT_ID "Paste the Client ID:"
[[ $APP_CLIENT_ID =~ ^[A-Za-z0-9.]+$ ]] || { warn "that is not a Client ID; run this wizard again"; exit 1; }
step "The address bar now reads https://github.com/settings/apps/<slug>. Copy the <slug>."
ask APP_SLUG "Paste the app slug:"
[[ $APP_SLUG =~ ^[a-z0-9-]+$ ]] || { warn "that is not an app slug; run this wizard again"; exit 1; }

stage "Make the private key"
say "The gh-broker signs with this key to get a one-hour token for each repo."
open_url "https://github.com/settings/apps/$APP_SLUG"
step "Under 'Private keys', click 'Generate a private key'. On the newer page: 'Credentials' > 'Key pairs' > 'New key'."
step "Your browser downloads a file named $APP_SLUG.<date>.private-key.pem."
NEWEST_KEY=$(newest_key "$HOME/Downloads" "$APP_SLUG")
[[ -n $NEWEST_KEY ]] && note "newest download: $NEWEST_KEY"
ask KEY_DOWNLOAD "Path of the downloaded key (Enter takes the newest download):"
[[ -n $KEY_DOWNLOAD ]] || KEY_DOWNLOAD=$NEWEST_KEY
[[ -f $KEY_DOWNLOAD ]] || { warn "no file at $KEY_DOWNLOAD; run this wizard again"; exit 1; }
[[ $(head -n 1 "$KEY_DOWNLOAD") == "-----BEGIN RSA PRIVATE KEY-----" ]] || { warn "$KEY_DOWNLOAD is not a GitHub App private key"; exit 1; }
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [[ -e $APP_PEM ]]; then
  confirm "$APP_PEM exists. Replace it?" || { warn "stopped; the old key stays"; exit 1; }
fi
(umask 077 && cp "$KEY_DOWNLOAD" "$APP_PEM.tmp")
chmod 600 "$APP_PEM.tmp"
mv -f "$APP_PEM.tmp" "$APP_PEM"
printf '  %s✓ wrote%s the private key → %s (mode 600)\n' "$GREEN" "$RESET" "$APP_PEM"
if confirm "Move the downloaded copy $KEY_DOWNLOAD to the Trash?"; then
  mv -- "$KEY_DOWNLOAD" "$HOME/.Trash/"
  SKIPPED+=("Empty the Trash: it holds a copy of the app private key")
else
  SKIPPED+=("Delete the downloaded key $KEY_DOWNLOAD; the gh-broker reads only $APP_PEM")
fi

stage "Install the app on the repos that agents work in"
open_url "https://github.com/apps/$APP_SLUG/installations/new"
step "Pick your account."
step "Repository access: 'Only select repositories', then pick $REPO and each other onboarded repo."
step "Check that the page lists only the permissions of stage 1, then click 'Install'."
step "The address bar now reads https://github.com/settings/installations/<number>. Copy the <number>."
ask INSTALLATION_ID "Paste the installation number (Enter skips; the gh-broker then looks it up):"
[[ -z $INSTALLATION_ID || $INSTALLATION_ID =~ ^[1-9][0-9]*$ ]] || { warn "that is not an installation number; run this wizard again"; exit 1; }

stage "Write the app config"
if [[ -n $INSTALLATION_ID ]]; then
  APP_CONFIG=$(printf '{"client_id": "%s", "installation_id": %s}' "$APP_CLIENT_ID" "$INSTALLATION_ID")
else
  APP_CONFIG=$(printf '{"client_id": "%s"}' "$APP_CLIENT_ID")
fi
(umask 077 && printf '%s\n' "$APP_CONFIG" > "$APP_JSON.tmp")
chmod 600 "$APP_JSON.tmp"
mv -f "$APP_JSON.tmp" "$APP_JSON"
printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$APP_CONFIG" "$APP_JSON"
pause

stage "Install the gh-broker and check it"
say "Setup installs the gh-broker from this checkout, $SCRIPT_CHECKOUT, and restarts it."
confirm "Run setup now?" || { SKIPPED+=("Run: $SCRIPT_CHECKOUT/host/bin/ug-setup, then type omp in $CHECKOUT"); finish; exit 1; }
"$SCRIPT_CHECKOUT/host/bin/ug-setup"
GH_BROKER_SOCKET=$(ug_fact root)/$(ug_fact gh_broker_socket)
if [[ ! -S $GH_BROKER_SOCKET ]]; then
  SKIPPED+=("The gh-broker socket $GH_BROKER_SOCKET is missing; check the launchd job com.underground.gh-broker, then type omp in $CHECKOUT")
  finish
  exit 1
fi
say "Check: type omp in $CHECKOUT. Each agent start runs gh-broker sync $REPO first, so a session that starts means the gh-broker got an app token; a missing app stops it with 'gh-broker sync $REPO failed'."
SKIPPED+=("Onboarding check 4: open https://github.com/settings/apps/$APP_SLUG/permissions and https://github.com/settings/installations, and confirm the app's permissions and repos")

finish
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  run_wizard "$@"
fi
