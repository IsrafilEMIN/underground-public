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
  printf '%s no active ruleset of %s makes main need your approval.%s Fix it in the repo settings under Rules (docs/SPEC.md, onboarding check 6).\n' "$open" "$repo" "${report:- It has no active branch ruleset.}" >&2
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
  /usr/sbin/sshd -T -f "$1" -o HostKey="$2" -C user=ugagent,host=localhost,addr=127.0.0.1 2>/dev/null | grep -qix 'denyusers ugagent'
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

ug_render_plist() {
  local out=$1 template=$2 shown=$3 left
  shift 3
  sed "$@" "$template" >"$out" || { printf 'cannot render %s\n' "$shown"; return 1; }
  left=$(grep -o '@[A-Z_]*@' "$out" | head -1) || true
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
