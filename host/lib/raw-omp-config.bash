# shellcheck shell=bash
# The raw omp's config (docs/SPEC.md, B2). The wrapper (host/bin/omp-arena) at each start, and setup
# (host/bin/ug-setup) before its probe, source this file. Setup removes the macOS build record
# before the probe, so the wrapper cannot start until the probe passes; if only the wrapper wrote
# this file, a fresh ~/.omp would fail the probe's raw-models check for good.
#
# The raw omp (GLOSSARY.md): the pinned omp by full path, with no sandbox, reads ~/.omp/agent. The
# config repo's raw-omp/config.yml replaces ~/.omp/agent/config.yml, so its disabledProviders line
# turns off the keyless built-in providers there (omp model-registry.ts, omp 18.13.2). The first
# file that it replaces stays as config.yml.before-ug. The sandbox never sees this file: raw-omp is
# not in the wrapper's config_names. The caller defines die and sets ug_tag for its warnings.

# The config repo that ~/.ug/host/config-repo names, or nothing. A leading ~/ means the home folder.
ug_config_repo() {
  local file="$HOME/.ug/host/config-repo" repo=""
  [[ -f $file ]] && repo=$(sed -n '1p' "$file")
  # shellcheck disable=SC2088  # the ~ is the literal text of the file, not a path to expand here
  [[ ${repo:0:2} == "~/" ]] && repo="$HOME/${repo:2}"
  printf '%s' "$repo"
}

# write_raw_config <config repo folder>
write_raw_config() {
  local repo=$1 from omp_root="$HOME/.omp" dir="$HOME/.omp/agent" to tmp d
  from="$repo/raw-omp/config.yml"
  to="$dir/config.yml"
  if [[ ! -e $from && ! -L $from ]]; then
    printf '%s: warning: the config repo %s has no raw-omp/config.yml, so a raw omp by full path keeps its own settings, and its keyless providers stay on\n' "${ug_tag:-omp}" "$repo" >&2
    return 0
  fi
  [[ -f $from && ! -L $from ]] || die "the config repo's raw-omp/config.yml must be a file, not a link"
  grep -q '^disabledProviders:' "$from" ||
    printf '%s: warning: the config repo'\''s raw-omp/config.yml has no disabledProviders line, so the keyless providers of a raw omp stay on\n' "${ug_tag:-omp}" >&2
  for d in "$omp_root" "$dir"; do
    if [[ -e $d || -L $d ]]; then
      [[ -d $d && ! -L $d && -O $d ]] || die "$d must be a folder that you own, not a link"
    else
      install -d -m 700 "$d"
    fi
  done
  [[ ! -L $to && (! -e $to || -f $to) ]] || die "$to must be a file, not a link"
  cmp -s "$from" "$to" && return 0
  [[ ! -f $to || -e $to.before-ug ]] || cp -p "$to" "$to.before-ug"
  tmp=$(mktemp "$dir/.config.yml.XXXXXX")
  cp "$from" "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$to"
}
