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

Run the two-Job recovery canary while the schedule remains suspended. The
default 32-call configuration has a combined hard ceiling above $5, so record
the operator's explicit cumulative approval in the command:

```sh
npm run doctor -- osolmaz/xtap-pool --fix --canary \
  --approved-cost-ceiling-usd=25
```

Enable the recurring schedule only after the canary passes and the operator
confirms the displayed recurring cost:

```sh
npm run doctor -- osolmaz/xtap-pool --fix --canary \
  --approved-cost-ceiling-usd=25 --enable-schedule
```

The approved ceiling must cover the two-Job canary. It does not change either
Job's configured run limit.

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

A reviewed deployment can continue an unfinished enrichment plan from an older
worker revision only through one exact immutable revision handoff. The updater
must first prove that the canonical schedule is suspended, no enrichment Job is
active, and the active plan and checkpoint fully verify. It records the
secret-free handoff in `.xtap-deployment.json` in the Space commit. It does not
change any plan, checkpoint, result, claim, receipt, pointer, index, database,
or manifest in either Bucket.

The worker normally requires the plan worker revision to equal the deployed
source revision. A mismatch is valid only when the deployment manifest pins the
exact active generation, activation, run, plan, contract, source snapshot,
predecessor and target worker revisions, checkpoint pointer, sequence, object,
digest, and size. The worker verifies the complete handoff and restores the
pinned checkpoint before it creates a provider or any write-capable runtime
object. Missing, stale, conflicting, malformed, or forked identities fail
closed. There is no revision list, wildcard, fallback, or environment override.

Keep the schedule suspended and do not run a paid Job while preparing,
reviewing, deploying, or restore-testing this handoff. After deployment, verify
the exact Space repository and runtime revisions, manifest, health, one
suspended non-concurrent schedule, zero active Jobs, exact restore, zero orphan
segments, zero provider calls, and unchanged pointers and object listings. A
later paid retry needs its own cost and non-overlap gate. See
[Add small worker checkpoints](docs/2026-08-19-small-worker-checkpoints-plan.md#reviewed-worker-revision-handoff)
for the complete contract and repair plan.

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
The private raw Bucket is the system of record. The SQLite index is a
replaceable public read model.

A logical run freezes one source snapshot, queue order, registry order, and
enrichment contract. Each physical Job restores the small active plan and
compact checkpoint, then processes only missing ordinals. It does not download
the public SQLite database during normal queue or registry work. The completed
logical run restores the frozen base once, applies its verified result batches,
and publishes a new checksum-verified index.

After publication activates a verified successor, the same physical Job keeps
working when that successor has unresolved queue or registry work. The command
start time and $10 inference ceiling remain shared across every successor in
that physical Job. The Job stops cleanly when the active successor has no work
or when the existing 40-minute or $10 ceiling is reached. The next six-hour run
then resumes the same durable state.

Run enrichment manually only for local development:

```sh
npm run enrich --workspace space
```

The scheduled production command is `space/dist/src/enrich-job-main.js`. The
schedule must remain non-concurrent and use only `HF_TOKEN` and
`INFERENCE_TOKEN`. Setup doctor owns schedule creation, replacement, canaries,
and activation. Keep a replacement schedule suspended until bounded restore,
interruption recovery, final publication, successor activation, and the
required two-Job recovery canary have passed.

The checked-in defaults give each Job a 40-minute worker budget, a 45-minute
platform timeout, and a $10 inference limit. These are physical-Job limits and
do not reset when one Job advances to a successor plan. The operator-approved
cumulative ceiling must cover both canary Jobs before either starts. The web
Space keeps enrichment disabled, and GitHub Actions remains CI-only.

Use an explicit rebuild only as a recovery operation:

```sh
npm run index:bootstrap
```

See [Add small worker checkpoints](docs/2026-08-19-small-worker-checkpoints-plan.md)
for the logical-run contract, production transition gates, and failure rules.

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
