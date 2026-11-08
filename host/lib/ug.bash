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
