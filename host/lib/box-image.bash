# shellcheck shell=bash
# shellcheck source=host/lib/ug.bash disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/ug.bash"

box_image_tag() {
  local src=$1 h LC_ALL=C
  h=$( { grep -E '^(box_omp|box_omp_sha256|ovnfs|ovnfs_sha256)=' "$src/VERSIONS"; cat "$src"/box/* "$src/host/broker/client.ts" "$src/host/broker/protocol.ts"; } | shasum -a 256 | cut -c1-16)
  echo "ugbox:$h"
}

BOX_HOME_SIZE=64g
BOX_HOME_BYTES=$((64 * 1024 * 1024 * 1024))
# shellcheck disable=SC2016,SC2034
BOX_HOME_TAR='tar -C /home/agent -c --exclude ./checkouts --exclude ./.tmp --exclude ./.cache --exclude ./.omp/agent/cache --exclude node_modules . ; [ $? -le 1 ]'

box_home_create() {
  container volume create --opt "size=$BOX_HOME_SIZE" "$1" >/dev/null
}

box_home_capped() {
  local bytes
  bytes=$(container volume inspect "$1" | grep -o '"sizeInBytes"[^0-9]*[0-9]*' | grep -o '[0-9]*$')
  [[ -n $bytes && $bytes -le $BOX_HOME_BYTES ]]
}

box_image_build() {
  local src=$1 tag ctx status=0
  tag=$(box_image_tag "$src")
  if container image list --quiet | grep -qE "(^|/)${tag}\$"; then
    echo "box image: $tag in place"
    return 0
  fi
  ctx=$(mktemp -d) || return 1
  cp "$src"/box/* "$src/host/broker/client.ts" "$src/host/broker/protocol.ts" "$ctx/"
  container build -t "$tag" \
    --build-arg "OMP_VERSION=$(ug_pin "$src/VERSIONS" box_omp)" \
    --build-arg "OMP_SHA256=$(ug_pin "$src/VERSIONS" box_omp_sha256)" \
    --build-arg "OVNFS_VERSION=$(ug_pin "$src/VERSIONS" ovnfs)" \
    --build-arg "OVNFS_SHA256=$(ug_pin "$src/VERSIONS" ovnfs_sha256)" \
    -f "$ctx/Containerfile" "$ctx" || status=$?
  rm -rf "$ctx"
  [[ $status -ne 0 ]] || echo "box image: built $tag"
  return "$status"
}
