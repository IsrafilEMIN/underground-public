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

ug_repo_slug() {
  local top url re='^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$'
  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
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

ug_wait_http() {
  local url=$1 i
  for (( i = 0; i < 60; i++ )); do
    curl -fsS -o /dev/null --max-time 1 "$url" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}
