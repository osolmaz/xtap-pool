---
title: xtap-pool
emoji: 🐦
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
hf_oauth: true
hf_oauth_expiration_minutes: 43200
pinned: false
---

# xtap-pool

Private tweet pool for a group of friends running the
[xtap-pool extension](https://github.com/osolmaz/xtap-pool).

- `POST /api/ingest` — extension submissions (Bearer pool token)
- `GET /connect` — sign in with Hugging Face to connect the extension
- `GET /api/units` — revision-consistent enriched units for scoped service accounts
- `/` — tweet explorer and pool administration
- `GET /healthz` and `GET /readyz` — machine-readable runtime health

Required Space secrets: `HF_TOKEN` (fine-grained, read/write access to the
dataset repo only), `POOL_SIGNING_SECRET`, `SESSION_SECRET`. When enrichment is
enabled, set `INFERENCE_TOKEN` separately as a fine-grained token with the
`Make calls to Inference Providers` permission.
Required Space variables: `DATASET_REPO`, `ALLOWED_USERS` (initial
comma-separated HF usernames), `POOL_ADMINS` (bootstrap admins), `SPACE_HOST`
(auto-injected by HF).

If `ENRICH_MAX_COST_USD` is set, also set `ENRICH_MAX_COST_PER_CALL_USD` to a
conservative upper bound for one classification or registry-review request,
plus `ENRICH_INPUT_TOKEN_USD` and `ENRICH_OUTPUT_TOKEN_USD` in USD per token
for the configured model. Cost-limited runs refuse to start without all three
values and stop before a bounded request could exceed the run ceiling.

After setup, admins manage individual members and one allowed member organization
in the Space Admin tab. Durable membership is stored in the private dataset repo
at `config/pool.json`; the Space variables are kept as bootstrap and recovery
inputs. The `member_orgs` config key remains an array for backwards
compatibility, but only one organization grant is active.

Admins issue read-only machine credentials from the Admin tab. Only credential
hashes are stored in `config/service-accounts.json`; raw credentials are shown
once. `units:read` grants `GET /api/units`, while `taxonomy:read` grants the
label, free-label, and graph read endpoints. These credentials cannot ingest or
administer the pool.
