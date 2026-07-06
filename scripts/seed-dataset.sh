#!/usr/bin/env bash
# Seed the pool dataset with existing xTap JSONL output.
#
# Finds tweets-YYYY-MM-DD.jsonl files anywhere under <source-dir> and maps
# them to data/<username>/YYYY/MM/ in the dataset repo. This supports xTap's
# default flat output directory as well as already-nested archives.
#
# Usage: scripts/seed-dataset.sh <dataset-repo> <hf-username> <source-dir>
#   e.g. scripts/seed-dataset.sh osolmaz/xtap-pool-data osolmaz ~/Downloads/xtap
set -euo pipefail

DATASET_REPO="${1:?dataset repo, e.g. osolmaz/xtap-pool-data}"
USERNAME="${2:?hf username the seed data belongs to}"
SOURCE_DIR="${3:?source dir, e.g. ~/Downloads/xtap}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "source directory does not exist: $SOURCE_DIR" >&2
  exit 1
fi

COUNT=0
while IFS= read -r -d '' file; do
  name="$(basename "$file")"
  day="${name#tweets-}"
  day="${day%.jsonl}"
  year="${day:0:4}"
  month="${day:5:2}"
  target="$STAGE/data/$USERNAME/$year/$month/$name"
  mkdir -p "$(dirname "$target")"
  cp "$file" "$target"
  COUNT=$((COUNT + 1))
done < <(find "$SOURCE_DIR" -type f -name 'tweets-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].jsonl' -print0)

if [[ "$COUNT" -eq 0 ]]; then
  echo "no tweets-YYYY-MM-DD.jsonl files found under $SOURCE_DIR" >&2
  exit 1
fi

echo "==> Uploading $COUNT daily files to $DATASET_REPO as data/$USERNAME/"
hf upload "$DATASET_REPO" "$STAGE" . --repo-type dataset \
  --commit-message "seed: $USERNAME xTap output"
echo "==> Done. Restart the Space to rebuild its index."
