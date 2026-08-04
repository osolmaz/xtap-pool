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

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the original design, [`docs/labels-and-free-labels-implementation-plan.md`](docs/labels-and-free-labels-implementation-plan.md) for the target two-output classification contract, [`docs/durable-enrichment-implementation-plan.md`](docs/durable-enrichment-implementation-plan.md) for the durable worker and completion contract, and [Add a durable enrichment index](docs/2026-08-04-durable-enrichment-index-plan.md) for the verified SQLite index.

## Set up a pool (once, by the pool owner)

Requires Node.js 22+, npm, the Hugging Face CLI, and a personal `hf auth login`
with write access to the target namespace:

```sh
npm ci
npm run setup
```

The setup flow creates or updates the private dataset repo, private index
Bucket, and public Docker Space. It configures the Space, can import existing
xTap JSONL files, builds the first durable SQLite index, and verifies one
storage-only `HF_TOKEN` with read/write access to exactly the dataset and index
Bucket.

To diagnose an existing pool without changing secrets or restarting the Space:

```sh
npm run doctor -- osolmaz/xtap-pool
npm run --silent doctor -- osolmaz/xtap-pool --json  # JSON only on stdout
```

To repair missing or broken deployment configuration, run the bounded repair
flow. It owns both the Space and the scheduled Hugging Face enrichment Job. The
flow prompts privately for replacement tokens, validates their intended roles,
reconciles Space configuration, and creates or replaces the scheduled Job in a
suspended state. `HF_TOKEN` must be scoped to the dataset repo and index Bucket;
`INFERENCE_TOKEN` must be a separate fine-grained token with the `Make calls to
Inference Providers` permission:

```sh
npm run doctor -- osolmaz/xtap-pool --fix
```

Run the two-Job recovery canary while keeping the schedule suspended. Its hard
cumulative inference and CPU ceiling is below $5:

```sh
npm run doctor -- osolmaz/xtap-pool --fix --canary
```

Activating recurring paid work requires the canary and a separate explicit
confirmation that shows the schedule and per-run ceiling:

```sh
npm run doctor -- osolmaz/xtap-pool --fix --canary --enable-schedule
```

Hugging Face stores scheduled Job secrets with the Job configuration. Existing
Space secret values are write-only, so repair requires the original token values
or purpose-scoped replacements when Job secrets must be created or rotated. It
does not mint tokens, copy values out of the Space, print them, or save them
locally. It stops with the missing input when safe reconciliation is impossible.

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
dataset repo, index Bucket, and membership bootstrap settings, preserves all
secrets, and only uploads the latest Space code plus any missing variables.
It will not create or rotate generated signing/session secrets; run the setup
flow if those were never initialized. Keep `HF_TOKEN` scoped to read/write the
private dataset and index Bucket. The Space keeps `ENRICH_ENABLED=false`; doctor
provisions the separate inference credential only on the Hugging Face enrichment
Job.

The lower-level scripts are still available when you want to do those steps
manually. The deploy script first creates the private dataset and index Bucket.
If `XTAP_STORAGE_TOKEN` is absent, it stops before deployment and prints the two
exact resources the token needs. Import optional history at this point, before
index bootstrap. Then create the fine-grained read/write token and rerun the
script. Supplying the variable explicitly authorizes the script to use it for
index bootstrap and install it as the Space `HF_TOKEN` secret.

```sh
scripts/deploy-space.sh <namespace> # creates resources, then stops for the token
scripts/seed-dataset.sh <namespace>/xtap-pool-data <hf-username> ~/Downloads/xtap # optional
XTAP_STORAGE_TOKEN=... scripts/deploy-space.sh <namespace>
```

The script publishes and verifies `index/current.json` before uploading reader
code, and sets `INDEX_BUCKET`, `LLM_MODEL`, and `TAXONOMY_VERSION` to the same
contract used for bootstrap.

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

Production enrichment runs through the standalone enrichment command in a
scheduled Hugging Face Job, not in the web Space:

```sh
npm run enrich --workspace space
```

The repair flow owns this schedule and uses `cpu-basic`, an explicit timeout,
and disabled concurrency so two workers cannot overlap. New or replaced
schedules start suspended. `--canary` triggers two bounded physical Jobs and
verifies their durable receipts, continuation contract, source revision, and
cost accounting. `--enable-schedule` resumes the schedule only after the canary
passes and recurring paid work is explicitly approved.

The Job receives separate purpose-scoped storage and inference secrets through
Hugging Face Jobs. Its environment contains the dataset repo, index Bucket,
model, taxonomy, pricing, elapsed-time, error-rate, discarded-assignment-rate,
and cumulative-cost ceilings. The discarded-assignment quality guard counts rejected
model labels per successfully enriched unit. It defaults to 0.15 after 200 units,
so healthy large runs do not stop merely because they process more data. Missing
credentials or cost configuration fails before any provider call. The default
repair configuration caps each canary Job at $2 of inference and 40 minutes of
worker time. Two canary Jobs plus their worst-case `cpu-basic` time have a
cumulative hard ceiling below $4.02.
Scheduled and manually triggered runs use the same non-concurrent Hugging Face
schedule. Each fresh process reads `index/current.json` from the private dataset,
restores its checksum-verified SQLite generation from the private Bucket, and
applies only new JSONL files or strict append suffixes. The manifest uses an
exact parent commit so concurrent publishers cannot replace it. The dataset
remains authoritative. A missing, corrupt, truncated, or rewritten
source fails closed instead of triggering an automatic full replay. An operator
can intentionally rebuild and publish the index with:

```sh
npm run index:bootstrap
```

The web API exposes no enrichment writer, and GitHub Actions remains CI-only.

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
