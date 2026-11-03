#!/usr/bin/env bash
# Bring the session files of the old omp roots into the arena, so the arena's /stats rebuilds the
# whole history from them (omp's stats package builds stats.db from the session files).
#
#   scripts/import-history.sh        show what it would do; changes nothing
#   scripts/import-history.sh --go   do it
#
# Sources:
#   ~/.ug/omp/agent/sessions   the old wrapper's root; nothing uses it now, so files are moved
#   ~/.omp/agent/sessions      the root of raw and Tern omp sessions; files are copied
# Target: ~/.ug/home/.omp/agent/sessions, the arena's own sessions folder.
#
# Safety, because agents can read everything in the arena and the host writes into it here:
#   - it refuses while an arena session runs, so no agent can swap a folder under it
#   - every target folder must be a real folder that you own, never a link
#   - it never overwrites a file that is there already
#   - it leaves out every file that holds a token shape or a known secret value, and lists it
# omp's parser counts <project>/<file>.jsonl as a main session and deeper files as subagents. The
# old role era kept <role>/ug-<repo>/<file>.jsonl, one level deeper; those become ug-<repo>-<role>.
set -euo pipefail

go=0
case ${1:-} in
  "") ;;
  --go) go=1 ;;
  *) printf 'usage: import-history.sh [--go]\n' >&2; exit 64 ;;
esac

target="$HOME/.ug/home/.omp/agent/sessions"
old_wrapper="$HOME/.ug/omp/agent/sessions"
raw="$HOME/.omp/agent/sessions"

die() { printf 'import-history: %s\n' "$*" >&2; exit 1; }

# A session of this home's arena has its srt settings in $HOME/.ug/run/session.*, on its command line.
# shellcheck disable=SC2016  # the $ in the sed bracket is a literal character to escape
running=$(printf '%s' "$HOME/.ug/run/session." | sed 's/[][\.*^$()+?{}|]/\\&/g')
if pgrep -f -- "$running" >/dev/null 2>&1; then
  die "an arena session is running; close every omp session first"
fi

# Each folder from ~/.ug down to the target must be a real folder that you own.
check_dir() {
  [[ -d $1 && ! -L $1 && -O $1 ]] || die "$1 must be a folder that you own, not a link"
}
check_dir "$HOME/.ug"
check_dir "$HOME/.ug/home"
for dir in "$HOME/.ug/home/.omp" "$HOME/.ug/home/.omp/agent" "$target"; do
  if [[ $go -eq 1 && ! -e $dir && ! -L $dir ]]; then mkdir -m 700 "$dir"; fi
  if [[ -e $dir || -L $dir ]]; then check_dir "$dir"; fi
done

# Token shapes, and the values of secrets that this mac holds. A file with any of them stays out.
patterns=$(mktemp "${TMPDIR:-/tmp}/ug-import.XXXXXX")
secrets=$(mktemp "${TMPDIR:-/tmp}/ug-import.XXXXXX")
trap 'rm -f "$patterns" "$secrets"' EXIT
cat >"$patterns" <<'EOF'
sk-ant-[A-Za-z0-9_-]{20,}
gh[pousr]_[A-Za-z0-9]{30,}
github_pat_[A-Za-z0-9_]{30,}
AKIA[0-9A-Z]{16}
xox[abprs]-[A-Za-z0-9-]{10,}
-----BEGIN [A-Z ]*PRIVATE KEY-----
eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.
refresh_token\\?"[[:space:]]*:[[:space:]]*\\?"[^"\\]{16,}
access_token\\?"[[:space:]]*:[[:space:]]*\\?"[^"\\]{16,}
EOF
for file in "$HOME/.config/strata/api_key" "$HOME/.omp/auth-broker.token"; do
  value=$(tr -d '[:space:]' <"$file" 2>/dev/null) || value=""
  if [[ ${#value} -ge 12 ]]; then printf '%s\n' "$value" >>"$secrets"; fi
done

moved=0 copied=0 skipped=0 exists=0 bytes=0

# The place of one file in the arena: the path below its source root, with a role-era
# <role>/ug-<repo>/... lifted to ug-<repo>-<role>/...
place() {
  local rel=$1 first rest second
  first=${rel%%/*}
  rest=${rel#*/}
  second=${rest%%/*}
  if [[ $first != ug-* && $first != --* && $second == ug-* && $rest == */* ]]; then
    printf '%s-%s/%s\n' "$second" "$first" "${rest#*/}"
  else
    printf '%s\n' "$rel"
  fi
}

import_root() {
  local root=$1 how=$2 file rel dest dir size part
  [[ -d $root && ! -L $root ]] || { printf '%s: not there, nothing to do\n' "$root"; return 0; }
  while IFS= read -r -d '' file; do
    rel=${file#"$root"/}
    dest="$target/$(place "$rel")"
    if grep -a -q -E -f "$patterns" "$file" || { [[ -s $secrets ]] && grep -a -q -F -f "$secrets" "$file"; }; then
      printf 'skip (holds a secret or a token shape): %s\n' "$file"
      skipped=$((skipped + 1))
      continue
    fi
    if [[ -e $dest || -L $dest ]]; then
      exists=$((exists + 1))
      continue
    fi
    size=$(wc -c <"$file")
    bytes=$((bytes + size))
    if [[ $go -eq 1 ]]; then
      dir=$target
      part=${dest#"$target"/}
      while [[ $part == */* ]]; do
        dir="$dir/${part%%/*}"
        part=${part#*/}
        if [[ ! -e $dir && ! -L $dir ]]; then mkdir -m 700 "$dir"; fi
        check_dir "$dir"
      done
      if [[ $how == move ]]; then mv -n "$file" "$dest"; else cp -n -p "$file" "$dest"; fi
    fi
    if [[ $how == move ]]; then moved=$((moved + 1)); else copied=$((copied + 1)); fi
  done < <(find "$root" -type f -name '*.jsonl' -print0)
}

import_root "$old_wrapper" move
import_root "$raw" copy

verb=$([[ $go -eq 1 ]] && printf 'done' || printf 'would do (run again with --go)')
printf '%s: move %s, copy %s, %s MB; left out %s with a secret; %s already in the arena\n' \
  "$verb" "$moved" "$copied" "$((bytes / 1048576))" "$skipped" "$exists"
