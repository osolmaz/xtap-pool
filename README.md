# xtap-pool

Pool [xTap](https://github.com/mkubicek/xTap) captures with a group of friends.

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

Requires Node.js 22+, npm, the Hugging Face CLI, and a personal `hf auth login`
with write access to the target namespace:

```sh
npm ci
npm run setup
```

The setup flow creates or updates the private dataset repo and public Docker
Space, configures the Space variables and generated secrets, verifies the
dataset-only `HF_TOKEN`, and can import existing xTap JSONL files.

To redeploy an existing pool without re-entering repo names, the dataset token,
or import settings:

```sh
npm run update
```

By default this updates `<active-hf-user>/xtap-pool`. Pass a Space repo when
updating a different namespace:

```sh
npm run update -- osolmaz/xtap-pool
```

The update command reads the current Space variables, reuses the existing
dataset repo and membership bootstrap settings, preserves all secrets, and only
uploads the latest Space code plus any missing variables.
It will not create or rotate generated signing/session secrets; run the setup
flow if those were never initialized.

The lower-level scripts are still available when you want to do those steps
manually:

```sh
scripts/deploy-space.sh <namespace>
scripts/seed-dataset.sh <namespace>/xtap-pool-data <hf-username> ~/Downloads/xtap
```

After setup, admins manage pool users and one allowed Hugging Face organization
from the Space's **Admin** tab. The Space stores membership in
`config/pool.json` inside the private dataset repo, so adding friends does not
require CLI access, repo permissions, or a Space restart. Individual users and
members of the allowed organization can connect through HF sign-in; org-based pool
tokens are shorter-lived so removed org members eventually lose access without
manual cleanup. `ALLOWED_USERS` and `POOL_ADMINS` remain bootstrap/recovery
variables for first setup and break-glass access.

Only one organization grant is active. The `member_orgs` config key remains an
array for backwards compatibility, but multiple organization grants are
deprecated because Hugging Face OAuth `orgIds` behaves like a required-org check
rather than an any-of-orgs check. Setting a new organization replaces the
previous one; add out-of-org friends as individual members.

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
