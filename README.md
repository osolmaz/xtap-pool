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
  Space for browsing, filtering, searching, and administering the pool.
- **Consumer API** — revision-consistent enriched conversation-author units
  for downstream applications that should not scan the private dataset or
  repeat semantic extraction.

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the original design, [`docs/labels-and-free-labels-implementation-plan.md`](docs/labels-and-free-labels-implementation-plan.md) for the target two-output classification contract, and [`docs/durable-enrichment-implementation-plan.md`](docs/durable-enrichment-implementation-plan.md) for the durable worker and completion contract.

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

To diagnose an existing pool without changing secrets or restarting the Space:

```sh
npm run doctor -- osolmaz/xtap-pool
npm run --silent doctor -- osolmaz/xtap-pool --json  # JSON only on stdout
```

To repair missing or broken Space credentials, run the bounded repair flow. It
prompts for replacement tokens, validates them for their intended role, writes
the Space secrets, restarts once, waits, and verifies live health. `HF_TOKEN`
must be scoped to the dataset repo; `INFERENCE_TOKEN` must be a separate
fine-grained token with the `Make calls to Inference Providers` permission:

```sh
npm run doctor -- osolmaz/xtap-pool --fix
```

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
flow if those were never initialized. Keep `HF_TOKEN` scoped to read/write the
private dataset; if enrichment is enabled, use a separate fine-grained
`INFERENCE_TOKEN` with the `Make calls to Inference Providers` permission.

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
variables for first setup and break-glass access. If `config/pool.json` is malformed,
the Space stays unready but a bootstrap admin can still sign in and replace it
from the **Admin** tab. The repair action is unavailable for transient Hub read
failures, so cached bootstrap membership cannot overwrite a valid remote config.

Admins also issue and rotate named read-only service accounts from the **Admin**
tab. Service credentials are hashed in `config/service-accounts.json`, shown
only once, expire after 365 days, and never authorize ingest or administration.
Downstream applications consume complete enriched units through
`GET /api/units`; see [Unit consumer API](docs/unit-consumer-api.md) for scopes,
revision-consistent pagination, and atomic publication guidance.

Only one organization grant is active. The `member_orgs` config key remains an
array for backwards compatibility, but multiple organization grants are
deprecated because Hugging Face OAuth `orgIds` behaves like a required-org check
rather than an any-of-orgs check. Setting a new organization replaces the
previous one; add out-of-org friends as individual members.

## Scheduled enrichment

Production enrichment runs through the standalone `npm run enrich --workspace space`
command, not the web server. [`.github/workflows/enrichment.yml`](.github/workflows/enrichment.yml)
runs one bounded tick every six hours after `ENRICH_SCHEDULE_ENABLED=true` is
set as a repository variable. Keep `XTAP_DATASET_WRITER_TOKEN` and
`XTAP_INFERENCE_TOKEN` as separate purpose-scoped Actions secrets. Configure
`XTAP_DATASET_REPO`, all cost and pricing variables, and the other bounded worker
variables before enabling the schedule. Missing cost configuration fails before
any provider call. Four scheduled runs make the daily scheduled maximum four
times `ENRICH_MAX_COST_USD`. Scheduled and manually dispatched workflow runs
share one non-cancelling concurrency group, and the web API exposes no writer.
Do not launch an independent `enrich` command while a workflow run is active.

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
