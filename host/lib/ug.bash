# shellcheck shell=bash

ug_pin() { sed -n "s/^$2=//p" "$1"; }

ug_lock() {
  local dir=$1/lock wait=$2 waited=0 holder
  mkdir -p "$1"
  until mkdir "$dir" 2>/dev/null; do
    holder=$(cat "$dir/pid" 2>/dev/null || true)
    if [[ -n $holder ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$dir"
      continue
    fi
    (( waited++ < wait * 10 )) || return 1
    sleep 0.1
  done
  echo $$ >"$dir/pid"
}

ug_unlock() { rm -rf "$1/lock"; }

ug_check_checkout() {
  local src=$1 tool=$2 head main dirty
  dirty=$(git --no-optional-locks -c "safe.directory=$src" -C "$src" status --porcelain 2>/dev/null) || { printf '%s: %s is not a git checkout\n' "$tool" "$src" >&2; return 1; }
  [[ -z $dirty ]] || { printf '%s: the checkout %s has changes that are not committed; setup installs only what CI proved on origin/main\n' "$tool" "$src" >&2; return 1; }
  head=$(git --no-optional-locks -c "safe.directory=$src" -C "$src" rev-parse HEAD)
  main=$(git --no-optional-locks -c "safe.directory=$src" -C "$src" rev-parse --verify --quiet origin/main) || { printf '%s: the checkout has no origin/main; fetch first\n' "$tool" >&2; return 1; }
  [[ $head == "$main" ]] || { printf '%s: the checkout is at %s, not origin/main %s; setup installs only what CI proved on origin/main. Check out main and pull, or fetch.\n' "$tool" "${head:0:7}" "${main:0:7}" >&2; return 1; }
}

ug_pull_main() {
  local src=$1 tool=$2 dirty branch before after
  local g=(git --no-optional-locks -c "safe.directory=$src" -C "$src")
  dirty=$("${g[@]}" status --porcelain 2>/dev/null) || { printf '%s: %s is not a git checkout\n' "$tool" "$src" >&2; return 1; }
  [[ -z $dirty ]] || { printf '%s: the checkout %s has changes that are not committed; commit, stash, or drop them, then run setup again. Nothing changed.\n%s\n' "$tool" "$src" "$dirty" >&2; return 1; }
  if "${g[@]}" rev-parse --verify --quiet origin/main >/dev/null; then
    [[ $("${g[@]}" rev-list --count origin/main..HEAD) == 0 ]] || { printf '%s: the checkout has commits that are not on origin/main, so it is not origin/main and cannot fast-forward; move them to a branch, then run setup again. Nothing changed.\n' "$tool" >&2; return 1; }
  fi
  branch=$("${g[@]}" symbolic-ref --quiet --short HEAD) || branch=""
  [[ $branch == main ]] || { printf '%s: the checkout is on %s, not main; check out main, then run setup again. Nothing changed.\n' "$tool" "${branch:-a detached HEAD}" >&2; return 1; }
  before=$("${g[@]}" rev-parse HEAD)
  "${g[@]}" fetch --quiet origin main || { printf '%s: cannot fetch main from origin; check the network and your GitHub login, then run setup again. Nothing changed.\n' "$tool" >&2; return 1; }
  "${g[@]}" merge --quiet --ff-only origin/main || { printf '%s: main cannot fast-forward to origin/main; setup does not merge or rebase. Nothing changed.\n' "$tool" >&2; return 1; }
  after=$("${g[@]}" rev-parse HEAD)
  if [[ $before == "$after" ]]; then
    printf 'checkout: main is at origin/main %s\n' "${after:0:7}"
  else
    printf 'checkout: pulled main from %s to %s\n' "${before:0:7}" "${after:0:7}"
  fi
}

ug_repo_slug() {
  local top=$1 url re='^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$'
  url=$(git -C "$top" config --get remote.origin.url 2>/dev/null) || true
  url=${url%/}
  url=${url%.git}
  [[ $url =~ $re ]] || return 1
  echo "${BASH_REMATCH[2]}/${BASH_REMATCH[3]}"
}

ug_stop_service() {
  local target=$1 i
  launchctl bootout "$target" >/dev/null 2>&1 || true
  for (( i = 0; i < 60; i++ )); do
    launchctl print "$target" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  printf '%s is still loaded 30 s after launchctl bootout, so its new version cannot load\n' "$target"
  return 1
}

ug_restart_service() {
  local domain=$1 label=$2 plist=$3 err i
  ug_stop_service "$domain/$label" || return 1
  for (( i = 0; i < 5; i++ )); do
    err=$(launchctl bootstrap "$domain" "$plist" 2>&1) && return 0
    sleep 1
  done
  printf 'launchctl bootstrap of %s failed: %s\n' "$label" "$err"
  return 1
}

ug_wait() {
  local tries=$1 i
  shift
  for (( i = 0; i < tries; i++ )); do
    "$@" >/dev/null 2>&1 && return 0
    (( i + 1 < tries )) && sleep 0.5
  done
  return 1
}

ug_http_answers() { curl -fsS -o /dev/null --max-time 1 "$1"; }

ug_socket_answers() { printf '' | nc -w 1 -U "$1" | grep -q .; }

ug_fingerprint() {
  local out
  out=$(set -o pipefail; cat -- "$@" | openssl dgst -sha256 -r) || return 1
  printf '%s\n' "${out%% *}"
}

ug_ensure_service() {
  local domain=$1 label=$2 rendered=$3 plist=$4 stamp=$5 fp=$6
  shift 6
  if [[ -f $stamp && $(<"$stamp") == "$fp" ]] && launchctl print "$domain/$label" >/dev/null 2>&1 && ug_wait 1 "$@"; then
    printf 'unchanged and answers, so not restarted\n'
    return 0
  fi
  rm -f "$stamp"
  install -m 644 "$rendered" "$plist" || { printf 'cannot install %s\n' "$plist"; return 1; }
  ug_restart_service "$domain" "$label" "$plist" || return 1
  ug_wait 60 "$@" || { printf '%s does not answer 30 s after it loaded\n' "$label"; return 1; }
  printf '%s\n' "$fp" >"$stamp"
  printf 'restarted, answers\n'
}
