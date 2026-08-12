#!/usr/bin/env bash
# Deploy this repo to a Hugging Face Docker Space.
#
# Requires an authenticated Hugging Face CLI session that can create Spaces and
# Buckets. XTAP_STORAGE_TOKEN must have read/write access to exactly the raw and
# index Buckets. Supplying it authorizes this script to install it as the Space
# HF_TOKEN secret.
#
# Usage:
#   XTAP_STORAGE_TOKEN=... scripts/deploy-space.sh <namespace>
#   SPACE_REPO=<ns>/<name> RAW_BUCKET=<ns>/<name> INDEX_BUCKET=<ns>/<name> \
#     XTAP_STORAGE_TOKEN=... scripts/deploy-space.sh
set -euo pipefail

NAMESPACE="${1:-${NAMESPACE:-}}"
SPACE_REPO="${SPACE_REPO:-${NAMESPACE:?usage: deploy-space.sh <namespace>}/xtap-pool}"
RAW_BUCKET="${RAW_BUCKET:-${NAMESPACE}/xtap-pool-data}"
INDEX_BUCKET="${INDEX_BUCKET:-${NAMESPACE}/xtap-pool-bucket}"
ALLOWED_USERS="${ALLOWED_USERS:-osolmaz}"
LLM_MODEL="${LLM_MODEL:-zai-org/GLM-5.2:fireworks-ai}"
TAXONOMY_VERSION="${TAXONOMY_VERSION:-1}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
INDEX_WORK="$(mktemp -d)"
trap 'rm -rf "$STAGE" "$INDEX_WORK"' EXIT

echo "==> Creating storage and Space resources (idempotent)"
hf buckets create "$RAW_BUCKET" --private --exist-ok
hf buckets create "$INDEX_BUCKET" --private --exist-ok
# The Space itself is public: a private Space would put HF's repo-access gate
# in front of the app. Anonymous visitors still see only the sign-in page.
hf repos create "$SPACE_REPO" --repo-type space --space-sdk docker 2>/dev/null || true

if [[ -z "${XTAP_STORAGE_TOKEN:-}" ]]; then
  cat >&2 <<EOF
XTAP_STORAGE_TOKEN is required before deployment.
Create a fine-grained token with read/write access to exactly:
  Bucket: $RAW_BUCKET
  Bucket: $INDEX_BUCKET
Rerun with XTAP_STORAGE_TOKEN set. The script will bootstrap the durable index
and install the same value as the Space HF_TOKEN.
EOF
  exit 2
fi

echo "==> Bootstrapping and verifying the durable index"
DATA_DIR="$INDEX_WORK" \
RAW_BUCKET="$RAW_BUCKET" \
INDEX_BUCKET="$INDEX_BUCKET" \
HF_TOKEN="$XTAP_STORAGE_TOKEN" \
LLM_MODEL="$LLM_MODEL" \
TAXONOMY_VERSION="$TAXONOMY_VERSION" \
npm --prefix "$ROOT" run index:bootstrap

echo "==> Setting Space secrets and variables"
SPACE_REPO="$SPACE_REPO" \
RAW_BUCKET="$RAW_BUCKET" \
INDEX_BUCKET="$INDEX_BUCKET" \
ALLOWED_USERS="$ALLOWED_USERS" \
LLM_MODEL="$LLM_MODEL" \
TAXONOMY_VERSION="$TAXONOMY_VERSION" \
XTAP_STORAGE_TOKEN="$XTAP_STORAGE_TOKEN" \
python3 <<'PY'
import os
import secrets

from huggingface_hub import HfApi

space = os.environ["SPACE_REPO"]
api = HfApi()
variables = dict(api.get_space_variables(space))
if "DATASET_REPO" in variables:
    api.delete_space_variable(space, key="DATASET_REPO")
for name in (
    "RAW_BUCKET",
    "INDEX_BUCKET",
    "ALLOWED_USERS",
    "LLM_MODEL",
    "TAXONOMY_VERSION",
):
    api.add_space_variable(space, name, os.environ[name])
api.add_space_secret(space, "HF_TOKEN", os.environ["XTAP_STORAGE_TOKEN"])
# Secrets cannot be listed back, so a sentinel variable marks that they were
# set once. Never rotate silently: rotating logs everyone out or disconnects
# every extension.
if "SECRETS_INITIALIZED" not in variables:
    for name in ("POOL_SIGNING_SECRET", "SESSION_SECRET"):
        api.add_space_secret(space, name, secrets.token_hex(32))
    api.add_space_variable(space, "SECRETS_INITIALIZED", "1")
print("Set Bucket variables, contract variables, and the scoped HF_TOKEN.")
PY

echo "==> Staging Space contents"
git -C "$ROOT" archive HEAD | tar -x -C "$STAGE"
cp "$ROOT/space/hf-space-README.md" "$STAGE/README.md"
rm -rf "$STAGE/docs" "$STAGE/extension"

echo "==> Uploading to $SPACE_REPO"
hf upload "$SPACE_REPO" "$STAGE" . --repo-type space --commit-message "deploy: $(git -C "$ROOT" rev-parse --short HEAD)"

echo "==> Done. Space: https://huggingface.co/spaces/$SPACE_REPO"
