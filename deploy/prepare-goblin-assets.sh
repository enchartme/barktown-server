#!/usr/bin/env bash
# Run as the same user who owns Barktown's production data (normally pi).
set -euo pipefail

if (( $# < 1 || $# > 2 )); then
  echo "Usage: bash deploy/prepare-goblin-assets.sh GOBLIN_CHECKOUT [MODEL_DIRECTORY]" >&2
  exit 2
fi

ssd=/srv/verbatim
mountpoint -q "$ssd" || { echo "$ssd is not mounted" >&2; exit 1; }

checkout=$(realpath -e -- "$1")
models=$(realpath -e -- "${2:-$checkout/models}")
revision=$(git -C "$checkout" rev-parse --verify HEAD)
model_files=(yamnet.tflite bark_classifier.tflite bark_classifier_meta.json)
for file in "${model_files[@]}"; do
  test -s "$models/$file" || { echo "Model file missing or empty: $models/$file" >&2; exit 1; }
done

umask 077
root="$ssd/barktown/goblin-assets"
install -d -m 0700 "$root"
[[ $(stat -c %d "$root") = "$(stat -c %d "$ssd")" ]] ||
  { echo "Asset directory is not on the Verbatim filesystem" >&2; exit 1; }

staging=$(mktemp -d "$root/.bundle.XXXXXX")
trap 'if [[ -n "$staging" ]]; then rm -rf -- "$staging"; fi' EXIT
git -C "$checkout" archive "$revision" bark tools/analyze_wav.py | tar -xf - -C "$staging"
install -d -m 0700 "$staging/models"
for file in "${model_files[@]}"; do
  install -m 0600 "$models/$file" "$staging/models/$file"
done
printf '%s\n' "$revision" > "$staging/GOBLIN_COMMIT"
(
  cd "$staging"
  sha256sum models/{yamnet.tflite,bark_classifier.tflite,bark_classifier_meta.json}
) > "$staging/MODELS.sha256"

bundle="$root/${revision:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$bundle" || { echo "Already exists: $bundle" >&2; exit 1; }
mv -T -- "$staging" "$bundle"
staging=''
printf 'BARKTOWN_GOBLIN_DIR=%s\n' "$bundle"
