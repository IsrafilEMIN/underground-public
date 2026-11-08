# shellcheck shell=bash

backup_target_read() {
  local config=$1 line key value
  repo="" wake=() sleep_cmd=() woke=0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z ${line//[[:space:]]/} || $line == \#* ]] && continue
    key=${line%%=*}
    value=${line#*=}
    [[ $line == *=* ]] || die "$config: a line without '=': $line"
    case $key in
      repo) repo=$value ;;
      wake) read -r -a wake <<<"$value" ;;
      sleep) read -r -a sleep_cmd <<<"$value" ;;
      *) die "$config: unknown key $key" ;;
    esac
  done <"$config"
  [[ $repo =~ ^sftp:([A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*):([^[:space:]]+)$ ]] || die "$config: repo must be sftp:<user>@<host>:<path>, not '$repo'"
  target=${BASH_REMATCH[1]}
  [[ ${#wake[@]} -gt 0 && ${#sleep_cmd[@]} -gt 0 ]] || die "$config needs a wake= and a sleep= line"
}

backup_target_up() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" true >/dev/null 2>&1; }

backup_target_wake() {
  local tries=${UG_BACKUP_WAIT_TRIES:-30} pause=${UG_BACKUP_WAIT_SECONDS:-10} i
  backup_target_up && return 0
  "${wake[@]}" >/dev/null 2>&1 || die "the wake command ${wake[*]} failed"
  woke=1
  for ((i = 0; i < tries; i++)); do
    backup_target_up && return 0
    sleep "$pause"
  done
  backup_target_sleep
  die "$target did not answer ssh after the wake; if the mac is away from home, the wake signal cannot reach it"
}

backup_target_sleep() {
  [[ $woke -eq 1 ]] || return 0
  "${sleep_cmd[@]}" >/dev/null 2>&1 || log "the sleep command ${sleep_cmd[*]} failed; $target stays awake"
  woke=0
}
