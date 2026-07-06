#!/usr/bin/env bash
# Deploy this repo to a Hugging Face Docker Space.
#
# Requires an HF token with write access to the target namespace (a personal
# session via `hf auth login`, not an agent's propose-only token).
#
# Usage:
#   scripts/deploy-space.sh <namespace>            # e.g. dutifuldev or osolmaz
#   SPACE_REPO=<ns>/<name> DATASET_REPO=<ns>/<name> scripts/deploy-space.sh
set -euo pipefail

NAMESPACE="${1:-${NAMESPACE:-}}"
SPACE_REPO="${SPACE_REPO:-${NAMESPACE:?usage: deploy-space.sh <namespace>}/xtap-pool}"
DATASET_REPO="${DATASET_REPO:-${NAMESPACE}/xtap-pool-data}"
ALLOWED_USERS="${ALLOWED_USERS:-osolmaz}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> Creating repos (idempotent)"
hf repos create "$DATASET_REPO" --repo-type dataset --private 2>/dev/null || true
# The Space itself is public: a private Space would put HF's repo-access gate
# in front of the app, blocking friends who are on ALLOWED_USERS but not
# Space collaborators. All data access is enforced in-app (OAuth allowlist +
# pool tokens); anonymous visitors only see the sign-in page. To keep the
# Space page private instead, add every friend as a Space collaborator.
hf repos create "$SPACE_REPO" --repo-type space --space-sdk docker 2>/dev/null || true

echo "==> Staging Space contents"
git -C "$ROOT" archive HEAD | tar -x -C "$STAGE"
cp "$ROOT/space/hf-space-README.md" "$STAGE/README.md"
rm -rf "$STAGE/docs" "$STAGE/extension"

echo "==> Uploading to $SPACE_REPO"
hf upload "$SPACE_REPO" "$STAGE" . --repo-type space --commit-message "deploy: $(git -C "$ROOT" rev-parse --short HEAD)"

echo "==> Setting Space secrets and variables"
python3 - "$SPACE_REPO" "$DATASET_REPO" "$ALLOWED_USERS" <<'PY'
import secrets
import sys

from huggingface_hub import HfApi

space, dataset, allowed = sys.argv[1:4]
api = HfApi()
variables = dict(api.get_space_variables(space))
api.add_space_variable(space, "DATASET_REPO", dataset)
api.add_space_variable(space, "ALLOWED_USERS", allowed)
# Secrets cannot be listed back, so a sentinel variable marks that they were
# set once. Never rotate silently: rotating logs everyone out / disconnects
# every extension.
if "SECRETS_INITIALIZED" not in variables:
    for name in ("POOL_SIGNING_SECRET", "SESSION_SECRET"):
        api.add_space_secret(space, name, secrets.token_hex(32))
    api.add_space_variable(space, "SECRETS_INITIALIZED", "1")
print("Set DATASET_REPO, ALLOWED_USERS, POOL_SIGNING_SECRET, SESSION_SECRET.")
print("Remaining manual steps:")
print(f"  1. Create a fine-grained token with read/write access to {dataset} only,")
print(f"     then: python3 -c \"from huggingface_hub import HfApi; HfApi().add_space_secret('{space}', 'HF_TOKEN', '<token>')\"")
print(f"  2. Optionally import history: scripts/seed-dataset.sh {dataset} <hf-username> ~/Downloads/xtap")
PY

echo "==> Done. Space: https://huggingface.co/spaces/$SPACE_REPO"
