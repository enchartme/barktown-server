#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'HELP'
Usage (run as the Barktown data owner, normally pi):
  bash deploy/database.sh init TARGET
  bash deploy/database.sh snapshot LIVE_DB TARGET
  bash deploy/database.sh restore BACKUP TARGET
  bash deploy/database.sh check DB
Set BARKTOWN_DB_IMAGE to override barktown-server:production.
HELP
  exit 2
}

operation=${1:-}
case "$operation:$#" in
  init:2) target=$2 ;;
  check:2) source=$2 ;;
  snapshot:3|restore:3) source=$2; target=$3 ;;
  *) usage ;;
esac

ssd=/srv/verbatim
mountpoint -q "$ssd" || { echo "$ssd is not mounted" >&2; exit 1; }
image=${BARKTOWN_DB_IMAGE:-barktown-server:production}
runtime=(--rm --network none --user "$(id -u):$(id -g)" --entrypoint node)
args=("/app/deploy/database.mjs" "$operation")

if [[ -n ${target:-} ]]; then
  directory=$(realpath -e -- "$(dirname -- "$target")")
  [[ "$directory" = "$ssd/"* && -w "$directory" ]] ||
    { echo "Target directory must already exist and be writable on $ssd" >&2; exit 1; }
  [[ $(stat -c %d "$directory") = "$(stat -c %d "$ssd")" ]] ||
    { echo "Target directory is not on the Verbatim filesystem" >&2; exit 1; }
  runtime+=(--mount "type=bind,src=$directory,dst=/output")
  args+=("/output/$(basename -- "$target")")
fi

if [[ -n ${source:-} ]]; then
  source=$(realpath -e -- "$source")
  [[ -f "$source" && -r "$source" ]] ||
    { echo "Source must be a readable database file" >&2; exit 1; }
  runtime+=(--mount "type=bind,src=$(dirname -- "$source"),dst=/input,readonly")
  args+=("/input/$(basename -- "$source")")
fi

sudo docker image inspect "$image" >/dev/null
sudo docker run "${runtime[@]}" "$image" "${args[@]}"
[[ -z ${target:-} ]] || ls -lh -- "$target"
