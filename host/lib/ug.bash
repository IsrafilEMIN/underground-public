# shellcheck shell=bash

ug_color_fds=""
if [[ -z ${NO_COLOR:-} && ${TERM:-dumb} != dumb ]]; then
  [[ ! -t 1 ]] || ug_color_fds+="1"
  [[ ! -t 2 ]] || ug_color_fds+="2"
fi

ug_paint() {
  [[ $ug_color_fds == *"$1"* ]] || return 0
  case $2 in
    bold) printf '\e[1m' ;;
    dim) printf '\e[2m' ;;
    green) printf '\e[32m' ;;
    red) printf '\e[31m' ;;
    yellow) printf '\e[33m' ;;
    off) printf '\e[0m' ;;
    *) printf 'ug_paint: unknown color %s\n' "$2" >&2; return 1 ;;
  esac
}

ug_say() {
  local kind=$1 subject=$2 text=$3 color=""
  case $kind in
    same) color=dim ;;
    changed) color=green ;;
    ok) ;;
    *) printf 'ug_say: unknown kind %s\n' "$kind" >&2; return 1 ;;
  esac
  printf '%s%s:%s %s%s%s\n' "$(ug_paint 1 bold)" "$subject" "$(ug_paint 1 off)" "${color:+$(ug_paint 1 "$color")}" "$text" "$(ug_paint 1 off)"
}

ug_service_kind() { if [[ $1 == unchanged* ]]; then printf 'same\n'; else printf 'changed\n'; fi; }

ug_pin() { sed -n "s/^$2=//p" "$1"; }

ug_facts_file=${BASH_SOURCE[0]%/*}/../facts

ug_fact() {
  local value
  value=$(ug_pin "$ug_facts_file" "$1") || return 1
  [[ -n $value ]] || { printf 'ug_fact: %s has no %s\n' "$ug_facts_file" "$1" >&2; return 1; }
  printf '%s\n' "$value"
}

ug_services_file=${BASH_SOURCE[0]%/*}/../services

ug_services() {
  local want=${1:-} label name scope user template health log inputs agent_input
  while IFS='|' read -r label name scope user template health log inputs agent_input || [[ -n $label ]]; do
    [[ -n $label && $label != \#* ]] || continue
    [[ -z $want || $scope == "$want" ]] || continue
    printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$label" "$name" "$scope" "$user" "$template" "$health" "$log" "$inputs" "$agent_input"
  done <"$ug_services_file"
}

ug_service_field() {
  local want=$1 field=$2 label name scope user template health log inputs agent_input
  while IFS='|' read -r label name scope user template health log inputs agent_input || [[ -n $label ]]; do
    [[ -n $label && $label != \#* ]] || continue
    [[ $label == "$want" || $name == "$want" ]] || continue
    case $field in
      label) printf '%s\n' "$label" ;;
      name) printf '%s\n' "$name" ;;
      scope) printf '%s\n' "$scope" ;;
      user) printf '%s\n' "$user" ;;
      template) printf '%s\n' "$template" ;;
      health) printf '%s\n' "$health" ;;
      log) printf '%s\n' "$log" ;;
      inputs) printf '%s\n' "$inputs" ;;
      agent_input) printf '%s\n' "$agent_input" ;;
      *) printf 'ug_service_field: no field %s\n' "$field" >&2; return 1 ;;
    esac
    return 0
  done <"$ug_services_file"
  printf 'ug_service_field: %s has no job %s\n' "$ug_services_file" "$want" >&2
  return 1
}

ug_service_allowed() {
  local label=$1 user=$2 agent_input=$3
  [[ $agent_input =~ ^(none|socket|port|files)( U[0-9]+)?$ ]] ||
    { printf '%s: the service table gives it the agent input "%s"; write none, socket, port, or files, and a threat row id after it when the job runs as owner or root\n' "$label" "$agent_input"; return 1; }
  [[ $user == owner || $user == root ]] || return 0
  [[ $agent_input == none || $agent_input == *" U"* ]] && return 0
  printf '%s runs as %s and reads %s that the agent makes; run it as a user that holds only what it needs, or name the threat row that accepts it\n' "$label" "$user" "$agent_input"
  return 1
}

ug_services_allowed() {
  local label name scope user template health log inputs agent_input bad=0
  while IFS='|' read -r label name scope user template health log inputs agent_input; do
    ug_service_allowed "$label" "$user" "$agent_input" || bad=1
  done < <(ug_services)
  return "$bad"
}

ug_service_runs_as() {
  local label=$1 want=$2 out have pid
  out=$(launchctl print "system/$label" 2>/dev/null) || { printf 'launchd has no job system/%s\n' "$label"; return 1; }
  have=$(sed -n 's/^[[:space:]]*username = //p' <<<"$out" | head -n 1)
  if [[ -z $have ]]; then
    pid=$(sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' <<<"$out" | head -n 1)
    [[ -n $pid ]] || return 0
    have=$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' ')
    [[ -n $have ]] || return 0
  fi
  [[ $have == "$want" ]] || { printf 'launchd runs %s as %s, not %s\n' "$label" "$have" "$want"; return 1; }
}

ug_service_data() { printf '%s\n' "${UG_DATA:-$HOME/$(ug_fact owner_data)}"; }

ug_service_expand() {
  local text=$1 name value data
  data=$(ug_service_data)
  while [[ $text =~ @([A-Z_]+)@ ]]; do
    name=${BASH_REMATCH[1]}
    name=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
    case $name in
      data) value=$data ;;
      gateway) value=$(sed -n 's/^gateway=//p' "$data/addresses" 2>/dev/null | head -1) ;;
      omp_sha) value=${UG_OMP_SHA:-} ;;
      *) value=$(ug_fact "$name") || return 1 ;;
    esac
    [[ -n $value ]] || { printf 'ug_service_expand: no value for %s\n' "${BASH_REMATCH[0]}" >&2; return 1; }
    text=${text/"${BASH_REMATCH[0]}"/$value}
  done
  printf '%s\n' "$text"
}

ug_service_inputs() {
  local tokens=$1 tok opt m
  local -a matches keep
  for tok in $tokens; do
    opt=0
    [[ $tok != \?* ]] || { opt=1; tok=${tok#\?}; }
    tok=$(ug_service_expand "$tok") || return 1
    shopt -s nullglob
    # shellcheck disable=SC2206
    matches=( $tok )
    shopt -u nullglob
    if (( ${#matches[@]} == 0 )); then
      (( opt )) || matches=( "$tok" )
    elif (( opt )); then
      keep=()
      for m in "${matches[@]}"; do [[ -e $m ]] && keep+=("$m"); done
      matches=( ${keep[@]+"${keep[@]}"} )
    fi
    (( ${#matches[@]} > 0 )) && printf '%s\n' "${matches[@]}"
  done
  return 0
}

ug_die() {
  local tool=$1
  shift
  printf '%s%s: %s%s\n' "$(ug_paint 2 red)" "$tool" "$*" "$(ug_paint 2 off)" >&2
  exit 1
}

ug_stopped() {
  local status=$1 line=$2 command=$3 tool=$4 file=$5 mid=${6:-} tail=${7:-}
  (( BASH_SUBSHELL == 0 )) || return 0
  printf '%s%s: stopped at line %s of %s: "%s" failed with exit %s. The steps above it are done, and nothing after it ran%s. Fix the cause, then run host/bin/ug-setup again%s.%s\n' \
    "$(ug_paint 2 red)" "$tool" "$line" "$file" "$command" "$status" "$mid" "$tail" "$(ug_paint 2 off)" >&2
}

ug_sha256() {
  local out
  out=$(shasum -a 256 "$1") || return 1
  printf '%s\n' "${out%% *}"
}

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
  ug_check_main_rule "$src" "$tool" || return 1
  "${g[@]}" fetch --quiet origin main || { printf '%s: cannot fetch main from origin; check the network and your GitHub login, then run setup again. Nothing changed.\n' "$tool" >&2; return 1; }
  "${g[@]}" merge --quiet --ff-only origin/main || { printf '%s: main cannot fast-forward to origin/main; setup does not merge or rebase. Nothing changed.\n' "$tool" >&2; return 1; }
  after=$("${g[@]}" rev-parse HEAD)
  if [[ $before == "$after" ]]; then
    ug_say same checkout "main is at origin/main ${after:0:7}"
  else
    ug_say changed checkout "pulled main from ${before:0:7} to ${after:0:7}"
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

# shellcheck disable=SC2016
ug_main_rule_gaps='
def rule(t): [.rules[]? | select(.type == t)][0];
[
  (if (.conditions.ref_name.include // []) | any(. == "~DEFAULT_BRANCH" or . == "refs/heads/main") then empty else "it does not target main" end),
  (if ((.conditions.ref_name.exclude // []) | length) == 0 then empty else "it excludes some branches" end),
  (rule("pull_request").parameters as $p
    | if $p == null then "it does not require a pull request"
      elif ($p.required_approving_review_count >= 1 and $p.require_code_owner_review and $p.require_last_push_approval and $p.dismiss_stale_reviews_on_push) then empty
      else "its pull request rule needs 1 approval, review from code owners, approval of the most recent push, and dismissal of stale approvals" end),
  (if rule("non_fast_forward") then empty else "it does not block force pushes" end),
  (if rule("deletion") then empty else "it does not restrict deletions" end),
  ((rule("required_status_checks").parameters.required_status_checks // []) as $checks
    | if ($checks | length) > 0 and ($checks | all(.integration_id == 15368)) then empty else "it requires no status check from GitHub Actions" end),
  (if .bypass_actors == null then "its bypass list is not readable with your login"
    else (.bypass_actors[] | select(((.actor_type == "RepositoryRole" and .actor_id == 5) or .actor_type == "OrganizationAdmin") | not) | "its bypass list holds \(.actor_type) \(.actor_id)") end)
] | join("; ")
'

ug_check_main_rule() {
  local src=$1 tool=$2 repo login file="" name pattern owners star=0 ids id json gaps report=""
  local open="$tool: a wall is open, so setup pulled nothing and changed nothing:"
  repo=$(ug_repo_slug "$src") || { printf '%s the origin of %s is not a GitHub repo, so setup cannot check the rule on main\n' "$open" "$src" >&2; return 1; }
  for name in gh jq; do
    command -v "$name" >/dev/null || { printf '%s setup needs %s to check the rule on main of %s\n' "$open" "$name" "$repo" >&2; return 1; }
  done
  login=$(gh api user | jq -r '.login // empty') || login=""
  [[ -n $login ]] || { printf '%s gh has no GitHub login; run: gh auth login\n' "$open" >&2; return 1; }

  for name in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do
    [[ ! -f $src/$name ]] || { file=$src/$name; break; }
  done
  [[ -n $file ]] || { printf '%s the checkout has no CODEOWNERS file, so no file needs your approval\n' "$open" >&2; return 1; }
  while read -r pattern owners || [[ -n $pattern ]]; do
    [[ -n $pattern && $pattern != \#* ]] || continue
    [[ $owners == "@$login" ]] || { printf '%s %s gives "%s" to "%s"; each line must name only @%s\n' "$open" "$file" "$pattern" "$owners" "$login" >&2; return 1; }
    [[ $pattern != "*" ]] || star=1
  done <"$file"
  [[ $star == 1 ]] || { printf '%s %s has no line "* @%s", so some files need no approval\n' "$open" "$file" "$login" >&2; return 1; }

  ids=$(gh api "repos/$repo/rulesets?per_page=100" | jq -r '.[] | select(.enforcement == "active" and .target == "branch") | .id') || { printf '%s cannot read the rulesets of %s from GitHub\n' "$open" "$repo" >&2; return 1; }
  for id in $ids; do
    json=$(gh api "repos/$repo/rulesets/$id") || { printf '%s cannot read ruleset %s of %s from GitHub\n' "$open" "$id" "$repo" >&2; return 1; }
    gaps=$(jq -r "$ug_main_rule_gaps" <<<"$json") || { printf '%s cannot read ruleset %s of %s: GitHub sent no ruleset\n' "$open" "$id" "$repo" >&2; return 1; }
    [[ -n $gaps ]] || { ug_say same "main rule" "GitHub merges to main of $repo only with the approval of @$login (ruleset $id)"; return 0; }
    report+=" Ruleset $id: $gaps."
  done
  printf '%s no active ruleset of %s makes main need your approval.%s Fix it in the repo settings under Rules (docs/SPEC.md, "Onboarding checks", item 6).\n' "$open" "$repo" "${report:- It has no active branch ruleset.}" >&2
  return 1
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

ug_port_answers() { nc -z -w 1 "$1" "$2"; }

ug_sshd_denies_agent() {
  local agent
  agent=$(ug_fact agent_user) || return 1
  /usr/sbin/sshd -T -f "$1" -o HostKey="$2" -C "user=$agent,host=localhost,addr=127.0.0.1" 2>/dev/null | grep -qix "denyusers $agent"
}

ug_fingerprint() {
  local out
  out=$(set -o pipefail; cat -- "$@" | openssl dgst -sha256 -r) || return 1
  printf '%s\n' "${out%% *}"
}

ug_ensure_owner_mode() {
  local file=$1 owner=$2 mode=$3
  [[ $(stat -f '%Su:%Sg %Mp%Lp' "$file") != "$owner $mode" ]] || return 0
  chown "$owner" "$file" && chmod "$mode" "$file" || return 1
  [[ $(stat -f '%Su:%Sg %Mp%Lp' "$file") == "$owner $mode" ]]
}

ug_trusted_path() {
  local path=$1 part=$1 owner mode acl rule=' allow [^'$'\n'']*(write|add_file|add_subdirectory|delete|append|chown)'
  shift
  [[ $path == /* ]] || { printf '%s is not an absolute path\n' "$path"; return 1; }
  while :; do
    [[ ! -L $part ]] || { printf '%s is a link\n' "$part"; return 1; }
    owner=$(stat -f '%Su %Lp' "$part" 2>/dev/null) || { printf '%s is missing or cannot be read\n' "$part"; return 1; }
    mode=${owner#* }
    owner=${owner% *}
    [[ " $* " == *" $owner "* ]] || { printf '%s belongs to %s\n' "$part" "$owner"; return 1; }
    (( (8#$mode & 8#022) == 0 )) || { printf '%s has mode %s, so its group or every user can write it\n' "$part" "$mode"; return 1; }
    acl=$(ls -lde "$part" 2>/dev/null) || acl=""
    [[ ! $acl =~ $rule ]] || { printf '%s has an access rule that lets a user change it: %s\n' "$part" "${BASH_REMATCH[0]# }"; return 1; }
    [[ $part != / ]] || return 0
    part=${part%/*}
    part=${part:-/}
  done
}

ug_trusted_daemon() {
  local plist=$1 user value key why i=0 paths=() dirs
  user=$(plutil -extract UserName raw -o - "$plist" 2>/dev/null) || user=root
  while value=$(plutil -extract "ProgramArguments.$i" raw -o - "$plist" 2>/dev/null); do
    [[ $value != /* ]] || paths+=("$value")
    i=$((i + 1))
  done
  for key in WorkingDirectory EnvironmentVariables.HOME; do
    ! value=$(plutil -extract "$key" raw -o - "$plist" 2>/dev/null) || paths+=("$value")
  done
  if value=$(plutil -extract EnvironmentVariables.PATH raw -o - "$plist" 2>/dev/null); then
    IFS=: read -r -a dirs <<<"$value"
    paths+=("${dirs[@]}")
  fi
  [[ ${#paths[@]} -gt 0 ]] || { printf 'it names no program\n'; return 1; }
  for value in "${paths[@]}"; do
    why=$(ug_trusted_path "$value" root "$user") || { printf 'it runs as %s and uses %s, but %s\n' "$user" "$value" "$why"; return 1; }
  done
  for key in StandardOutPath StandardErrorPath; do
    value=$(plutil -extract "$key" raw -o - "$plist" 2>/dev/null) || continue
    [[ ! -L $value ]] || { printf 'it logs to %s, which is a link\n' "$value"; return 1; }
    if [[ -e $value ]]; then
      why=$(stat -f %Su "$value") || why=unknown
      [[ $why == root || $why == "$user" ]] || { printf 'it logs to %s, which belongs to %s\n' "$value" "$why"; return 1; }
    fi
    why=$(ug_trusted_path "${value%/*}" root) || { printf 'it logs to %s, but %s; launchd opens the log before the job runs, so only root may own its folder\n' "$value" "$why"; return 1; }
  done
}

ug_render() {
  local out=$1 template=$2 shown=$3 key value left unsafe='[|&\\]' facts=()
  shift 3
  while IFS='=' read -r key value || [[ -n $key ]]; do
    [[ -n $key ]] || continue
    [[ ! $value =~ $unsafe ]] || { printf '%s holds %s=%s, which no template can take\n' "$ug_facts_file" "$key" "$value"; return 1; }
    facts+=(-e "s|@$(tr '[:lower:]' '[:upper:]' <<<"$key")@|$value|g")
  done <"$ug_facts_file"
  sed "${facts[@]}" "$@" "$template" >"$out" || { printf 'cannot render %s\n' "$shown"; return 1; }
  left=$(grep -o '@[A-Z_]\{1,\}@' "$out" | head -1) || true
  [[ -z $left ]] || { printf '%s has an unknown placeholder %s\n' "$shown" "$left"; return 1; }
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

ug_pf_refuses_listener() {
  local uid=$1 port=$2
  pfctl -s info 2>/dev/null | grep -q '^Status: Enabled' || return 1
  pfctl -a com.apple/underground -sr 2>/dev/null | grep -qx "block return in quick proto tcp from any to any port = $port user = $uid"
}
