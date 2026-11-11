# shellcheck shell=bash

vet_item() {
  local item=$1 base=$2 what=$3 secrets=$4 patterns=$5 odd leak
  odd=$(find "$item" \( -type l -o ! -type f ! -type d \) -print 2>/dev/null | head -1) || true
  [[ -z $odd ]] || ug_die ug-agent-setup "$what has a link or a special file, which the agent must not get: ${odd#"$base/"}"
  leak=$(grep -r -l -a -E -f "$patterns" "$item" 2>/dev/null | head -1) || true
  [[ -n $leak || ! -s $secrets ]] || leak=$(grep -r -l -a -F -f "$secrets" "$item" 2>/dev/null | head -1) || true
  [[ -z $leak ]] || ug_die ug-agent-setup "$what file ${leak#"$base/"} holds a token or a key; the agent reads every config file, so take it out"
}

front_name() {
  awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit } NR > 1 && /^name:/ { sub(/^name:[ \t]*/, ""); gsub(/["\047]/, ""); sub(/[ \t]+$/, ""); print; exit }' "$1"
}

stage_plugins() {
  local list=$1 out=$2 owner_home=$3 secrets=$4 patterns=$5
  local repo plugin tmp name item skill agent front s a
  local plugin_seen=" " skill_seen=" " agent_seen=" "
  for item in "$out"/skills/*/; do
    [[ -d $item ]] || continue
    item=${item%/}
    skill_seen+=" ${item##*/} "
  done
  for item in "$out"/agents/*.md; do
    [[ -f $item ]] || continue
    item=${item%.md}
    agent_seen+=" ${item##*/} "
  done
  while IFS= read -r repo || [[ -n $repo ]]; do
    [[ -n $repo ]] || continue
    repo=${repo/#\~/$owner_home}
    [[ -d $repo && ! -L $repo ]] || ug_die ug-agent-setup "the plugin repo $repo in the config repo's plugin-repos is not a folder"
    repo=$(cd "$repo" && pwd -P) || ug_die ug-agent-setup "cannot open the plugin repo $repo"
    [[ $repo == "$owner_home"/* ]] || ug_die ug-agent-setup "the plugin repo $repo is not inside $owner_home; setup reads plugin repos only from your home"
    tmp=$(mktemp -d "$out/.plugin.XXXXXX") || ug_die ug-agent-setup "cannot make a temp folder in $out for the plugin repo $repo"
    git -c "safe.directory=$repo" -C "$repo" archive --format=tar HEAD | tar -x -C "$tmp" || ug_die ug-agent-setup "cannot read the last commit of the plugin repo $repo"
    vet_item "$tmp" "$tmp" "the plugin repo $repo" "$secrets" "$patterns"
    plugin=$tmp/.claude-plugin/plugin.json
    [[ -f $plugin ]] || plugin=$tmp/plugin.json
    [[ -f $plugin ]] || ug_die ug-agent-setup "the plugin repo $repo has no plugin manifest at .claude-plugin/plugin.json or plugin.json in its last commit"
    name=$(/usr/bin/plutil -extract name raw -o - "$plugin" 2>/dev/null) || name=""
    [[ -n $name ]] || ug_die ug-agent-setup "the plugin manifest of the plugin repo $repo has no name"
    [[ $name =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,62}[A-Za-z0-9])?$ ]] || ug_die ug-agent-setup "the plugin name $name of the plugin repo $repo has characters that a folder name cannot hold"
    [[ $plugin_seen != *" $name "* ]] || ug_die ug-agent-setup "the plugin $name is named twice in plugin-repos; keep one line, or give the two plugin repos different names"
    s=0
    if [[ -d $tmp/skills ]]; then
      for item in "$tmp"/skills/*/; do
        [[ -d $item && -f $item/SKILL.md ]] || continue
        item=${item%/}
        skill=${item##*/}
        front=$(front_name "$item/SKILL.md")
        [[ -z $front || $front == "$skill" ]] || ug_die ug-agent-setup "the skill folder $skill of the plugin repo $repo has another name in its SKILL.md; omp uses that name, so make the two the same"
        [[ $skill_seen != *" $skill "* ]] || ug_die ug-agent-setup "the skill $skill of the plugin repo $repo is also in the config repo or an earlier plugin; rename one"
        skill_seen+=" $skill "
        s=$((s + 1))
      done
    fi
    a=0
    if [[ -d $tmp/agents ]]; then
      for item in "$tmp"/agents/*.md; do
        [[ -f $item ]] || continue
        agent=${item%.md}
        agent=${agent##*/}
        [[ $(front_name "$item") == "$agent" ]] || ug_die ug-agent-setup "the agent file $agent.md of the plugin repo $repo has another name in its frontmatter; omp uses that name, so make the two the same"
        [[ $agent_seen != *" $agent "* ]] || ug_die ug-agent-setup "the agent $agent of the plugin repo $repo is also in the config repo or an earlier plugin; rename one"
        agent_seen+=" $agent "
        a=$((a + 1))
      done
    fi
    plugin_seen+=" $name "
    mkdir -p "$out/plugins"
    cp -R "$tmp" "$out/plugins/$name"
    rm -rf "$tmp"
    ug_say ok "plugin repo $repo" "plugin $name: $s skills, $a agents"
  done <"$list"
}
