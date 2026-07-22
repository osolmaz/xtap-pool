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
- `/` — tweet explorer

Required Space secrets: `HF_TOKEN` (fine-grained, read/write access to the
dataset repo only), `POOL_SIGNING_SECRET`, `SESSION_SECRET`.
Required Space variables: `DATASET_REPO`, `ALLOWED_USERS` (initial
comma-separated HF usernames), `POOL_ADMINS` (bootstrap admins), `SPACE_HOST`
(auto-injected by HF).

After setup, admins manage individual members and one allowed member organization
in the Space Admin tab. Durable membership is stored in the private dataset repo
at `config/pool.json`; the Space variables are kept as bootstrap and recovery
inputs. The `member_orgs` config key remains an array for backwards
compatibility, but only one organization grant is active.
