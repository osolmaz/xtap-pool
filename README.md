# xtap-pool

Pool [xTap](https://github.com/osolmaz/xTap) captures with a group of friends.

xtap-pool is three pieces in one repo:

- **`extension/`** — a vendored fork of the xTap Chrome extension that keeps
  saving tweets locally exactly like xTap, and additionally syncs them to a
  shared Hugging Face Space (all access enforced in-app via HF sign-in and
  an allowlist).
- **`space/`** — the Hugging Face Docker Space that receives submissions,
  verifies who sent them, stamps attribution, deduplicates, and commits
  everything to a private HF dataset repo (the durable system of record).
- **`explorer/`** — a TypeScript + React + shadcn/ui web UI served by the
  Space for browsing, filtering, and searching the pooled tweets.

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the full
design and delivery plan.

## Set up a pool (once, by the pool owner)

Requires a personal `hf auth login` with write access to the target namespace:

```sh
scripts/deploy-space.sh <namespace>   # creates the dataset repo + Docker Space, sets secrets
```

The script prints the two remaining manual steps: storing a fine-grained
`HF_TOKEN` Space secret (write access to the one dataset repo) and optionally
seeding an existing xtap-store archive:

```sh
scripts/seed-dataset.sh <namespace>/xtap-pool-data <hf-username> ~/xtap-store/data/tweets
```

Add friends by putting their HF usernames in the Space's `ALLOWED_USERS`
variable — no repo permissions, no org membership needed.

## Join a pool (each friend)

1. Load `extension/` unpacked via `chrome://extensions` (Developer mode).
2. Click the extension icon → **Connect** → sign in with Hugging Face.
3. Browse X. Captures sync to the pool automatically; the explorer lives at
   the Space URL.

Local JSONL saving works exactly like upstream xTap if you also install the
daemon/native host from `extension/native-host/` — it is optional for pool
members.

## Development

```sh
npm ci
npm run check   # format, lint, typecheck, tests, coverage, dry
```

## License

[MIT](LICENSE)
