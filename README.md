# xtap-pool

Pool [xTap](https://github.com/mkubicek/xTap) captures with a group of friends.

xtap-pool has these parts:

- **`extension/`** — a vendored xTap Chrome extension that keeps local captures
  and syncs them to a shared Hugging Face Space.
- **`space/`** — a Hugging Face Docker Space that authenticates contributors,
  validates and deduplicates submissions, and commits them to an immutable raw
  Bucket log before it returns success.
- **`explorer/`** — a React web interface for browsing, filtering, searching,
  and administering the pool.
- **Consumer API** — revision-consistent enriched conversation-author units for
  downstream applications.

The private raw Bucket is the system of record. A separate private Bucket holds
replaceable, checksum-verified SQLite index generations.

See [Move pool storage to an immutable Bucket log](docs/2026-08-12-bucket-object-log-plan.md)
for the storage contract and cutover procedure. The other implementation plans
under [`docs/`](docs/) record earlier design work.

## Set up a pool

You need Node.js 22 or newer, npm, the Hugging Face CLI, and an active
`hf auth login` with write access to the target namespace.

```sh
npm ci
npm run setup
```

Setup creates or verifies the private raw and index Buckets and the public
Docker Space. It configures the Space, publishes the first SQLite index, and
verifies a storage token with read/write access to exactly both Buckets.

New production pools write their initial configuration through the Bucket log.
The migration commands below are only for the one-time dataset cutover.

## Diagnose and repair

Inspect an existing pool without changing secrets or restarting it:

```sh
npm run doctor -- osolmaz/xtap-pool
npm run --silent doctor -- osolmaz/xtap-pool --json
```

Run bounded repair when deployment configuration or the scheduled enrichment
Job is missing or invalid:

```sh
npm run doctor -- osolmaz/xtap-pool --fix
```

The repair flow prompts privately for replacement credentials when required.
The storage token must cover the raw and index Buckets. The inference token must
be a separate token with the `Make calls to Inference Providers` permission.
The flow does not copy credentials from another store, print them, or save them
locally.

Run the two-Job recovery canary while the schedule remains suspended. Its hard
combined inference and CPU ceiling is below $5:

```sh
npm run doctor -- osolmaz/xtap-pool --fix --canary
```

Enable the recurring schedule only after the canary passes and the operator
confirms the displayed recurring cost:

```sh
npm run doctor -- osolmaz/xtap-pool --fix --canary --enable-schedule
```

## Update an existing pool

```sh
npm run update
npm run update -- osolmaz/xtap-pool
# Only after the pinned import and index verification:
npm run update -- osolmaz/xtap-pool \
  --verified-bucket-cutover=/secure/path/import-report.json
```

Update reads the current `RAW_BUCKET` and `INDEX_BUCKET` variables, keeps all
secrets, uploads the current Space code, and reconciles missing variables. It
removes the retired `DATASET_REPO` variable. It does not create or rotate
signing or session secrets.

The lower-level deployment script is also available. Supplying
`XTAP_STORAGE_TOKEN` authorizes the script to bootstrap the index and install
that value as the Space `HF_TOKEN` secret. An existing pool also requires the
verified report from the pinned final dataset revision. Run it only after the
coordinated cutover has paused legacy writers and removed `DATASET_REPO`. It
checks that the dataset head still equals the imported revision before it can
bootstrap the index. Use `ALLOW_EMPTY_POOL=1` only for a confirmed new pool.

```sh
scripts/deploy-space.sh <namespace> # creates resources, then stops for credentials
PINNED_IMPORT_REPORT=/secure/path/import-report.json \
  XTAP_STORAGE_TOKEN=... scripts/deploy-space.sh <namespace>
```

## Import the retired dataset

These commands read one explicit 40-character dataset commit only. They are
migration tools and are not part of the runtime storage path.

```sh
npm run storage:import -- \
  --dataset osolmaz/xtap-pool-data \
  --revision <40-character-sha> \
  --raw-bucket osolmaz/xtap-pool-data \
  --report /secure/path/import-report.json \
  --work-dir /secure/path/work

npm run storage:verify -- \
  --dataset osolmaz/xtap-pool-data \
  --revision <same-sha> \
  --raw-bucket osolmaz/xtap-pool-data \
  --report /secure/path/verify-report.json \
  --work-dir /secure/path/work
```

The importer validates every approved record, writes deterministic immutable
segments, creates an exact snapshot, and compares source and target counts and
digests. Reports contain hashes and counts, not post text. Existing report paths
are never overwritten.

Build a fresh SQLite projection from only the two Buckets:

```sh
RAW_BUCKET=osolmaz/xtap-pool-data \
INDEX_BUCKET=osolmaz/xtap-pool-bucket \
HF_TOKEN=... \
npm run index:bootstrap
```

## Pool administration

Admins manage members and one allowed Hugging Face organization from the Space
**Admin** tab. Membership is stored in the raw Bucket at `config/pool.json`.
The Space bootstrap variables remain recovery inputs.

Admins can also issue read-only service credentials. The raw credential is
shown once; only its hash is stored in `config/service-accounts.json`.

## Scheduled enrichment

Production enrichment runs in one non-concurrent scheduled Hugging Face Job.
The Job uses the same immutable raw log and SQLite index as the Space.

```sh
npm run enrich --workspace space
```

Each process restores the current verified SQLite generation, creates an exact
raw snapshot, and applies only immutable segments absent from the generation.
A missing, corrupt, rewritten, or conflicting object fails closed. Operators
can rebuild and publish the projection intentionally:

```sh
npm run index:bootstrap
```

The default recovery canary limits each Job to $2 of inference and 40 minutes.
The web Space never runs enrichment, and GitHub Actions remains CI-only.

## Join a pool

1. Load `extension/` unpacked from `chrome://extensions` in Developer mode.
2. Select the extension icon, select **Connect**, and sign in with Hugging Face.
3. Browse X. Captures sync to the pool automatically.

Local JSONL saving stays available when the optional daemon/native host under
`extension/native-host/` is installed. Image downloads remain disabled in the
pool deployment.

## Development

```sh
npm ci
npm run check
```

## License

[MIT](LICENSE)
