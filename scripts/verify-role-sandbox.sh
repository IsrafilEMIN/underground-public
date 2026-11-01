#!/usr/bin/env bash
set -uo pipefail

[[ -n ${PI_CONFIG_DIR:-} ]] || { printf 'run this inside a role session: !bash scripts/verify-role-sandbox.sh\n' >&2; exit 64; }

omp_root="$HOME/$PI_CONFIG_DIR"
agent="$omp_root/agent"
failed=0

# want yes: the operation must succeed. want no: the sandbox must refuse it, so it passes only
# when the operation fails with "Operation not permitted"; any other failure (a missing file,
# a folder that already exists, a plain unix permission) means the check could not test the sandbox.
check() {
  local want=$1 what=$2 got err
  shift 2
  if err=$("$@" 2>&1 >/dev/null); then got=yes; else got=no; fi
  if [[ $want == yes && $got == yes ]] || [[ $want == no && $got == no && $err == *"Operation not permitted"* ]]; then
    printf 'pass  %s\n' "$what"
  elif [[ $want == no && $got == no ]]; then
    printf 'FAIL  %s (cannot test: failed without a sandbox refusal: %s)\n' "$what" "$(printf '%s' "$err" | head -1)"
    failed=1
  else
    printf 'FAIL  %s (want %s, got %s)\n' "$what" "$want" "$got"
    failed=1
  fi
}

write_new() {
  [[ ! -e $1 ]] || { printf '%s already exists\n' "$1" >&2; return 1; }
  : >"$1" && rm -f "$1"
}

append() {
  [[ -f $1 ]] || { printf '%s is missing\n' "$1" >&2; return 1; }
  : >>"$1"
}

make_dir() {
  [[ ! -e $1 ]] || { printf '%s already exists\n' "$1" >&2; return 1; }
  mkdir -p "$1" && rmdir "$1"
}

rename_folder() {
  mv "$1" "$1.ug-probe" && mv "$1.ug-probe" "$1"
}

check yes "write a new sqlite journal in the omp agent folder" write_new "$agent/ug-probe.db-journal"
check yes "write a new file in the omp cache" write_new "$agent/cache/ug-probe"
check yes "write a new file in the omp root" write_new "$omp_root/ug-probe"
check no "write policy.yml" append "$agent/policy.yml"
check no "create AGENTS.md in the omp agent folder" write_new "$agent/AGENTS.md"
check no "write the rules of this role" append "${UG_ROLE_RULES:-/nonexistent}"
check yes "write a new file in the underground cache" write_new "$omp_root/underground/cache/ug-probe"
check no "create RULES.md" write_new "$agent/RULES.md"
check no "make an extensions folder" make_dir "$agent/extensions"
check no "make a commands folder" make_dir "$agent/commands"
check no "make a plugins folder" make_dir "$omp_root/plugins"
check no "rename the omp agent folder" rename_folder "$agent"
check no "read the owner's omp logins" cat "$HOME/.omp/agent/agent.db"
check no "read the owner's ssh folder" ls "$HOME/.ssh"
check yes "bind and reach a loopback port" node -e '
const net = require("node:net");
const server = net.createServer((s) => s.end("ok")).listen(0, "127.0.0.1", () => {
  net.connect(server.address().port, "127.0.0.1").on("data", () => process.exit(0)).on("error", () => process.exit(1));
});
setTimeout(() => process.exit(1), 3000);'
check yes "the auth broker refuses a call without a token" sh -c '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8765/v1/snapshot)" = 401 ]'

pin_target=$(readlink "$HOME/.agents/bin/pinned/omp")
pin=${pin_target:+$(basename "$pin_target")}
version=$(omp --version 2>/dev/null)
if [[ -z $pin ]]; then
  printf 'FAIL  a child omp runs the pinned version (no pin: readlink %s failed)\n' "$HOME/.agents/bin/pinned/omp"
  failed=1
else
  check yes "a child omp runs the pinned $pin (got: $version)" sh -c "printf '%s' \"$version\" | grep -qF '$pin'"
fi
check yes "omp usage shows at least one account" sh -c 'omp usage 2>/dev/null | grep -q " account"'

exit "$failed"
