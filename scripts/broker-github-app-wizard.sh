#!/usr/bin/env bash

set -euo pipefail

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""
fi

TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()
WRITTEN_SECRET=()
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
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later, since it remembers values already saved.%s\n' "$RESET"
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

_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line value sq="'\\''"; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  value="${line#*=}"
  if [[ "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; value="${value//"$sq"/\'}"
  elif [[ "$value" == \"*\" ]]; then
    value="${value:1:${#value}-2}"
    [[ "$value" == *[\\\$\"]* ]] && return 1
  fi
  printf '%s' "$value"
}

ask() {
  local key="$1" prompt="$2" current input s=$'\001' e=$'\002' p rc=0
  current=$(_existing "$key" || true)
  p="  $s$BOLD$e$prompt$s$RESET$e "
  [[ -n "$current" ]] && p+="$s$DIM$e[Enter keeps current]$s$RESET$e "
  read -e -r -p "$p" input || rc=1
  if (( rc )) && [[ -z "$input" ]]; then return 1; fi
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

ask_secret() {
  local key="$1" prompt="$2" current input rc=0
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || rc=1
  printf '\n'
  if (( rc )) && [[ -z "$input" ]]; then return 1; fi
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

write_env() {
  local key="$1" value="$2" tmp sq="'\\''"
  [[ -e "$ENV_FILE" ]] || (umask 077 && : > "$ENV_FILE")
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf "%s='%s'\n" "$key" "${value//\'/$sq}" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
  printf -v "$key" '%s' "$value"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name: gh not ready; set it later"
}

set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name, gh not ready; set it later"
}

finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

run_wizard() {

TOTAL_STAGES=6

CONFIG_DIR="$HOME/.config/underground-broker"
APP_JSON="$CONFIG_DIR/github-app.json"
APP_PEM="$CONFIG_DIR/github-app.pem"
OLD_GH_DIR="$CONFIG_DIR/gh"
REPO=IsrafilEMIN/underground

banner "Broker GitHub App: your own app, on selected repos"

stage "Register the GitHub App"
say "The broker acts as a GitHub App that your account owns. GitHub shows it as <app slug>[bot]."
open_url "https://github.com/settings/apps/new"
step "GitHub App name: a free name, for example underground-broker-<your login>."
step "Homepage URL: https://github.com/$REPO"
step "Webhook: clear 'Active'. The broker uses no webhooks."
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
say "The broker signs with this key to get a one-hour token for each repo."
open_url "https://github.com/settings/apps/$APP_SLUG"
step "Under 'Private keys', click 'Generate a private key'. On the newer page: 'Credentials' > 'Key pairs' > 'New key'."
step "Your browser downloads a file named $APP_SLUG.<date>.private-key.pem."
NEWEST_KEY=$(ls -t "$HOME/Downloads/$APP_SLUG".*.private-key.pem 2>/dev/null | head -n 1 || true)
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
  SKIPPED+=("Delete the downloaded key $KEY_DOWNLOAD; the broker reads only $APP_PEM")
fi

stage "Install the app on the repos that agents work in"
open_url "https://github.com/apps/$APP_SLUG/installations/new"
step "Pick your account."
step "Repository access: 'Only select repositories', then pick $REPO and each other onboarded repo."
step "Check that the page lists only the permissions of stage 1, then click 'Install'."
step "The address bar now reads https://github.com/settings/installations/<number>. Copy the <number>."
ask INSTALLATION_ID "Paste the installation number (Enter skips; the broker then looks it up):"
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

stage "Put the bot's old gh login away"
if [[ -e $OLD_GH_DIR ]]; then
  say "$OLD_GH_DIR holds the gh login of the suspended bot. The broker no longer reads it."
  if confirm "Move $OLD_GH_DIR to the Trash?"; then
    mv -- "$OLD_GH_DIR" "$HOME/.Trash/underground-broker-gh-$(date +%Y%m%d%H%M%S)"
    SKIPPED+=("Empty the Trash: it holds the old bot login")
  else
    SKIPPED+=("Delete $OLD_GH_DIR, the old bot login")
  fi
else
  say "No old login at $OLD_GH_DIR. Nothing to do."
  pause
fi

stage "Install the broker and check it"
say "ug-install installs main. The GitHub App change must be merged on main first."
confirm "Is the GitHub App change merged on main?" || { SKIPPED+=("Merge the GitHub App change, then run: ug-install; broker sync $REPO"); finish; exit 1; }
"$HOME/.agents/bin/ug-install"
BROKER_SOCKET=$(/opt/homebrew/bin/node -e 'const [file, repo, run] = process.argv.slice(1); const bindings = JSON.parse(require("fs").readFileSync(file, "utf8")); const key = Object.keys(bindings).find((k) => bindings[k].repo === repo && bindings[k].role === "author"); if (key !== undefined) console.log(`${run}/${key}.sock`);' "$HOME/.agents/broker/bindings.json" "$REPO" "$HOME/.agents/broker/run" 2>/dev/null || true)
if [[ -z $BROKER_SOCKET || ! -S $BROKER_SOCKET ]]; then
  SKIPPED+=("Start omp once in your checkout of $REPO, then run inside it: broker sync $REPO")
  finish
  exit 1
fi
CHECKOUT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
ask CHECKOUT "Your checkout of $REPO (Enter takes $CHECKOUT):"
[[ -n $CHECKOUT ]] || CHECKOUT=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
(cd "$CHECKOUT" && UG_BROKER_SOCKET="$BROKER_SOCKET" "$HOME/.agents/bin/broker" sync "$REPO")
say "A pass: the sync above prints 'origin/main is now <commit>', so the broker got an app token for $REPO."
SKIPPED+=("Onboarding check 4: open https://github.com/settings/apps/$APP_SLUG/permissions and https://github.com/settings/installations, and confirm the app's permissions and repos")

finish
}

run_wizard "$@"; exit
