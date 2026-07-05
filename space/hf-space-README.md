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
[xtap-pool extension](https://github.com/dutifuldev/xtap-pool).

- `POST /api/ingest` — extension submissions (Bearer pool token)
- `GET /connect` — sign in with Hugging Face to connect the extension
- `/` — tweet explorer

Required Space secrets: `HF_TOKEN` (fine-grained, write access to the dataset
repo only), `POOL_SIGNING_SECRET`, `SESSION_SECRET`.
Required Space variables: `DATASET_REPO`, `ALLOWED_USERS` (comma-separated HF
usernames), `SPACE_HOST` (auto-injected by HF).
