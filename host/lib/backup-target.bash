# shellcheck shell=bash

backup_target_say() { printf '%s backup-target: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

backup_target_read() {
  local config=$1 line key value
  repo="" wake=() sleep_cmd=() woke=0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z ${line//[[:space:]]/} || $line == \#* ]] && continue
    key=${line%%=*}
    value=${line#*=}
    [[ $line == *=* ]] || { backup_target_say "$config: a line without '=': $line"; return 1; }
    case $key in
      repo) repo=$value ;;
      wake) read -r -a wake <<<"$value" ;;
      sleep) read -r -a sleep_cmd <<<"$value" ;;
      *) backup_target_say "$config: unknown key $key"; return 1 ;;
    esac
  done <"$config"
  [[ $repo =~ ^sftp:([A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*):([^[:space:]]+)$ ]] || { backup_target_say "$config: repo must be sftp:<user>@<host>:<path>, not '$repo'"; return 1; }
  target=${BASH_REMATCH[1]}
  [[ ${#wake[@]} -gt 0 && ${#sleep_cmd[@]} -gt 0 ]] || { backup_target_say "$config needs a wake= and a sleep= line"; return 1; }
}

backup_target_up() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" true >/dev/null 2>&1; }

backup_target_wake() {
  local tries=${UG_BACKUP_WAIT_TRIES:-30} pause=${UG_BACKUP_WAIT_SECONDS:-10} i
  backup_target_up && return 0
  "${wake[@]}" >/dev/null 2>&1 || { backup_target_say "the wake command ${wake[*]} failed"; return 1; }
  woke=1
  for ((i = 0; i < tries; i++)); do
    backup_target_up && return 0
    sleep "$pause"
  done
  backup_target_sleep
  backup_target_say "$target did not answer ssh after the wake; if the mac is away from home, the wake signal cannot reach it"
  return 1
}

backup_target_sleep() {
  [[ $woke -eq 1 ]] || return 0
  "${sleep_cmd[@]}" >/dev/null 2>&1 || backup_target_say "the sleep command ${sleep_cmd[*]} failed; $target stays awake"
  woke=0
}
