#!/usr/bin/env bash
# Deploy this repo to a Hugging Face Docker Space.
#
# Requires an authenticated Hugging Face CLI session that can create Spaces and
# Buckets. XTAP_STORAGE_TOKEN must have read/write access to exactly the raw and
# index Buckets. Supplying it authorizes this script to install it as the Space
# HF_TOKEN secret.
#
# Usage:
#   PINNED_IMPORT_REPORT=/safe/path/report.json XTAP_STORAGE_TOKEN=... \
#     scripts/deploy-space.sh <namespace>
#   SPACE_REPO=<ns>/<name> RAW_BUCKET=<ns>/<name> INDEX_BUCKET=<ns>/<name> \
#     PINNED_IMPORT_REPORT=/safe/path/report.json XTAP_STORAGE_TOKEN=... \
#     scripts/deploy-space.sh
# Set ALLOW_EMPTY_POOL=1 only for a confirmed new pool with no legacy data.
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

if [[ "${ALLOW_EMPTY_POOL:-0}" != "1" ]]; then
  if [[ -z "${PINNED_IMPORT_REPORT:-}" || ! -f "$PINNED_IMPORT_REPORT" ]]; then
    cat >&2 <<EOF
PINNED_IMPORT_REPORT must name the verified report from storage:import.
The deployment will not bootstrap an empty replacement over a legacy pool.
For a confirmed new pool with no legacy data, set ALLOW_EMPTY_POOL=1 explicitly.
EOF
    exit 2
  fi
  SPACE_REPO="$SPACE_REPO" RAW_BUCKET="$RAW_BUCKET" \
    PINNED_IMPORT_REPORT="$PINNED_IMPORT_REPORT" python3 <<'PY'
import json
import os
import re

from huggingface_hub import HfApi

with open(os.environ["PINNED_IMPORT_REPORT"], encoding="utf-8") as handle:
    report = json.load(handle)
if report.get("reconciliation", {}).get("passed") is not True:
    raise SystemExit("pinned import report did not pass reconciliation")
target = report.get("target", {})
if target.get("bucket") != os.environ["RAW_BUCKET"]:
    raise SystemExit("pinned import report targets a different raw Bucket")
if not isinstance(target.get("objects"), int) or target["objects"] < 1:
    raise SystemExit("pinned import report has no imported objects")
if re.fullmatch(r"[a-f0-9]{64}", str(target.get("snapshot_revision", ""))) is None:
    raise SystemExit("pinned import report has no valid snapshot revision")
source = report.get("source", {})
source_repo = str(source.get("dataset", ""))
source_revision = str(source.get("revision", ""))
if re.fullmatch(r"[a-f0-9]{40}", source_revision) is None:
    raise SystemExit("pinned import report has no valid dataset revision")
api = HfApi()
variables = dict(api.get_space_variables(os.environ["SPACE_REPO"]))
if "DATASET_REPO" in variables:
    raise SystemExit(
        "legacy writers are not cut over: pause the Space, suspend enrichment, "
        "pin and import the final dataset revision, then remove DATASET_REPO in the "
        "coordinated cutover before using this deployment script"
    )
current_revision = api.dataset_info(source_repo).sha
if current_revision != source_revision:
    raise SystemExit("dataset advanced after the pinned import; quiesce writers and re-import")
print("Verified the pinned final revision and completed legacy writer cutover.")
PY
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
