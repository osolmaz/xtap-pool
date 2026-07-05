#!/usr/bin/env bash
# Seed the pool dataset with an existing xtap-store archive.
#
# Maps <source>/YYYY/MM/tweets-*.jsonl (xtap-store layout) to
# data/<username>/YYYY/MM/ in the dataset repo. The Space rebuilds its index
# from this tree on next boot and infers attribution from the path for
# legacy lines without a contributed_by stamp.
#
# Usage: scripts/seed-dataset.sh <dataset-repo> <hf-username> <source-dir>
#   e.g. scripts/seed-dataset.sh osolmaz/xtap-pool-data osolmaz ~/xtap-store/data/tweets
set -euo pipefail

DATASET_REPO="${1:?dataset repo, e.g. osolmaz/xtap-pool-data}"
USERNAME="${2:?hf username the seed data belongs to}"
SOURCE_DIR="${3:?source dir, e.g. ~/xtap-store/data/tweets}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/data/$USERNAME"
cp -r "$SOURCE_DIR"/. "$STAGE/data/$USERNAME/"

COUNT=$(find "$STAGE" -name '*.jsonl' | wc -l)
echo "==> Uploading $COUNT daily files to $DATASET_REPO as data/$USERNAME/"
hf upload "$DATASET_REPO" "$STAGE" . --repo-type dataset \
  --commit-message "seed: $USERNAME xtap-store archive"
echo "==> Done. Restart the Space to rebuild its index."
