# shellcheck shell=bash

box_image_tag() {
  local src=$1 h
  h=$( { grep -E '^(box_omp|box_omp_sha256|ovnfs|ovnfs_sha256)=' "$src/VERSIONS"; cat "$src"/box/* "$src/host/broker/client.ts" "$src/host/broker/protocol.ts"; } | shasum -a 256 | cut -c1-16)
  echo "ugbox:$h"
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
    --build-arg "OMP_VERSION=$(sed -n 's/^box_omp=//p' "$src/VERSIONS")" \
    --build-arg "OMP_SHA256=$(sed -n 's/^box_omp_sha256=//p' "$src/VERSIONS")" \
    --build-arg "OVNFS_VERSION=$(sed -n 's/^ovnfs=//p' "$src/VERSIONS")" \
    --build-arg "OVNFS_SHA256=$(sed -n 's/^ovnfs_sha256=//p' "$src/VERSIONS")" \
    -f "$ctx/Containerfile" "$ctx" || status=$?
  rm -rf "$ctx"
  [[ $status -ne 0 ]] || echo "box image: built $tag"
  return "$status"
}
