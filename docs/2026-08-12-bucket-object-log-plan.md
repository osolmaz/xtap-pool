---
title: Move pool storage to an immutable Bucket log
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-12
---

# Move pool storage to an immutable Bucket log

The pool dataset uses about 311.7 GB while its current files use about 528.8 MB. Each ingest rewrites one or more growing JSONL files, and the dataset keeps the old revisions. This change must preserve every pooled post and durable enrichment record while replacing that storage path in one coordinated deployment.

The private Hugging Face Bucket `osolmaz/xtap-pool-data` will become the only raw system of record. The application will not keep dataset readers, dataset writers, dual writes, fallback reads, compatibility routes, or a legacy deployment period.

## Scope

This work will:

- store raw pool transactions as immutable compressed Bucket objects;
- store immutable source snapshots so any SQLite generation names its exact inputs;
- keep replaceable SQLite generations and their active manifest in the separate private index Bucket;
- import one explicitly pinned final dataset revision;
- prove exact preservation before production starts on the new storage path;
- update the Space, enrichment Job, setup, doctor, repair, deployment, and operator commands;
- remove `DATASET_REPO` and all dataset-backed runtime code; and
- leave the old dataset unchanged as a read-only cold backup.

The first deployment keeps all owned wire and storage formats at version 1. This repository has no public release, so the coordinated replacement changes version 1 in place.

## Non-goals

- Do not store or download images.
- Do not keep a queryable dataset projection.
- Do not use Git history as runtime storage.
- Do not add a service or another scheduler.
- Do not delete, rewrite, squash, or reclaim the old dataset in this task.
- Do not change pool identity, X capture, enrichment models, taxonomy meaning, or the Infinite Feed Scroller schedule.

## Required data

The import must preserve every valid record from these paths at the pinned revision:

| Source                                                  | Durable value                      |
| ------------------------------------------------------- | ---------------------------------- |
| `data/<contributor>/YYYY/MM/tweets-YYYY-MM-DD.jsonl`    | Pooled tweets                      |
| `enrichment/YYYY/MM/enrichment-YYYY-MM-DD.jsonl`        | Enrichment rows                    |
| `enrichment/attempts/YYYY/MM/attempts-YYYY-MM-DD.jsonl` | Attempt events                     |
| `enrichment/registry/YYYY/MM/registry-YYYY-MM-DD.jsonl` | Free-label registry events         |
| `enrichment/receipts/YYYY-MM-DD.jsonl`                  | Worker receipts                    |
| `config/pool.json`                                      | Pool membership and administrators |
| `config/service-accounts.json`                          | Service accounts                   |
| `config/labels.json`                                    | Taxonomy configuration             |
| `enrichment/vocabulary.json`                            | Durable vocabulary configuration   |

`index/current.json` is not imported. It belongs to the superseded index contract and is replaced by a new index manifest in the index Bucket.

## Storage layout

The raw Bucket contains only immutable version 1 objects:

```text
v1/segments/<category>/YYYY/MM/DD/<time-ms>-<uuid>-<sha256>.json.gz
v1/snapshots/<sha256>.json
```

`category` is `tweet`, `enrichment`, `attempt`, `registry`, `receipt`, `config`, or `mixed`. It helps bounded configuration reads and operator inspection. It does not control validation; each operation path does.

The index Bucket contains replaceable projections:

```text
index/databases/<sha256>.sqlite
index/current.json
```

The raw and index Buckets have different deletion rules. Runtime code never deletes a raw segment or raw snapshot. Index publication may retain the active SQLite generation and three predecessors and delete older index generations.

## Segment contract

One segment records one successful application transaction:

```json
{
  "schema_version": 1,
  "transaction_id": "dfbc9fea-f42c-42d8-ae2d-44f909c417bf",
  "created_at": "2026-08-12T12:34:56.789Z",
  "operations": [
    {
      "path": "data/osolmaz/2026/08/tweets-2026-08-12.jsonl",
      "mode": "append",
      "lines": ["{\"id\":\"...\"}"]
    }
  ]
}
```

An append operation contains one or more complete non-empty JSON lines for one approved record path. A write operation contains the complete UTF-8 value for one approved configuration path:

```json
{
  "path": "config/pool.json",
  "mode": "write",
  "content": "{\n  \"version\": 1\n}\n"
}
```

The segment object is canonical JSON with no insignificant whitespace and keys emitted in schema order. The SHA-256 in the key covers these uncompressed bytes. Gzip uses deterministic headers so a retry produces the same compressed bytes. The timestamp and UUID identify the transaction and give configuration writes a total order. A process must generate a timestamp greater than its prior transaction timestamp when two writes occur in the same millisecond or the clock moves backward.

The writer validates every path and record before upload. Unknown fields, unknown paths, malformed JSON, invalid records, duplicate operation paths, empty append sets, unsupported versions, and invalid timestamps fail closed.

The writer uploads to a new key, downloads it, decompresses it, verifies its uncompressed checksum and complete bytes, parses and validates it again, and only then returns success. A retry may reuse an existing key only when the stored object decodes to the exact same bytes. A conflicting object fails closed.

Content-addressed keys make concurrent raw writes independent. The chance of a different valid payload using the same SHA-256 key is below the operational risk threshold. No mutable raw head or compare-and-swap credential is required.

## Snapshot contract

A raw snapshot names the exact immutable objects used to build an index:

```json
{
  "schema_version": 1,
  "bucket": "osolmaz/xtap-pool-data",
  "files": [
    {
      "key": "v1/segments/tweet/2026/08/12/...json.gz",
      "oid": "immutable-hub-object-id",
      "size": 1234,
      "content_sha256": "sha256-from-segment-key"
    }
  ]
}
```

Files are sorted by key. The snapshot revision is the SHA-256 of the canonical snapshot bytes, and its key is `v1/snapshots/<revision>.json`. Snapshot creation lists raw segments, validates every key and immutable object ID, writes the content-addressed snapshot, reads it back, and verifies it.

A snapshot can omit a transaction that finishes after the listing passes its key. This is safe because the snapshot explicitly lists its complete input set and the next advance includes the new segment. No transaction can appear partly: Bucket uploads publish complete objects, and replay verifies each complete object before changing SQLite.

A reader never reconstructs an old snapshot from the current Bucket listing. It reads the exact immutable snapshot object named by the index manifest.

## Configuration ordering

Pool membership, service accounts, taxonomy, and vocabulary use write operations. The current value is the last valid write ordered by:

1. `created_at`;
2. `transaction_id`; and
3. segment key as a final deterministic tie-breaker.

Pool and service-account mutations remain serialized by the Space. The enrichment Job does not write these values. Taxonomy and vocabulary changes remain operator actions. A fresh restore derives configuration only from the raw Bucket.

## Runtime storage boundary

A `BucketLog` replaces `DatasetMirror`.

It must provide:

- validated and verified transaction upload;
- stable snapshot creation and loading;
- exact segment download and replay;
- current configuration reads;
- local bounded caching that is never authoritative; and
- the latest valid worker receipt observed during replay.

Ingest validates, stamps, and deduplicates a batch against SQLite. It writes one verified raw segment before updating SQLite or returning success. An upload or verification failure returns a storage error and leaves SQLite unchanged.

The enrichment worker writes rows, attempt events, registry events, and receipts as immutable segments before applying them locally. Its existing single-Job schedule remains non-concurrent. The Space and Job may write different segments concurrently.

## SQLite projection

The SQLite database is a disposable projection. Its metadata records:

```text
schema_version = 1
raw_bucket
raw_snapshot_revision
contract_hash
```

The source tables record each segment key, immutable Hub object ID, compressed byte length, uncompressed SHA-256, and row counts by record kind. A source object mutation, deletion from an exact snapshot, checksum mismatch, repeated key with changed identity, or replay count mismatch fails closed.

Index bootstrap builds a fresh database from one new raw snapshot. Index advance creates a new snapshot, compares exact segment keys with the local source table, rejects mutation or deletion, validates all new segments before starting a SQLite transaction, and applies all new segments atomically.

Index publication:

1. advances to one exact raw snapshot;
2. makes and validates a SQLite backup;
3. uploads the content-addressed SQLite generation;
4. downloads it and verifies its checksum, integrity, metadata, and counts;
5. writes `index/current.json` in the index Bucket;
6. reads the manifest back and verifies the complete value; and
7. prunes only old index generations.

The active manifest binds one exact raw snapshot and one exact SQLite generation:

```json
{
  "schema_version": 1,
  "source": {
    "bucket": "osolmaz/xtap-pool-data",
    "revision": "<snapshot-sha256>"
  },
  "projection": {
    "contract_hash": "<sha256>"
  },
  "database": {
    "key": "index/databases/<sha256>.sqlite",
    "sha256": "<sha256>",
    "predecessors": []
  },
  "counts": {
    "tweets": 0,
    "units": 0,
    "enrichments": 0,
    "attempt_events": 0,
    "registry_events": 0,
    "receipts": 0
  }
}
```

The manifest keeps physical counts because they detect the wrong or incomplete database before serving. The index Bucket has one authorized publisher at a time: the suspended setup/bootstrap command or the non-concurrent enrichment Job. The Space advances its local database after ingest but does not publish the shared generation.

If a manifest write fails after the SQLite upload, the generation is unreferenced and harmless. The next publication may reuse it. If manifest read-back differs, publication fails and does not prune anything.

## Import contract

The importer requires:

- an explicit dataset repository;
- an explicit 40-character dataset revision;
- the raw Bucket name;
- an output report path; and
- a local work directory with enough space for bounded files and verification data.

It refuses `main`, a branch name, or an unpinned source. Import is resumable and idempotent. Each source file maps to one deterministic transaction ID and one content-addressed segment. Re-running the same pinned import verifies and reuses matching objects.

The importer lists all approved source and configuration paths at the pinned revision. It downloads each file, validates UTF-8 and every record, and records:

- source path and immutable object ID;
- byte length and SHA-256;
- valid non-empty line count;
- record kind;
- for tweets, the sorted `(id, contributed_by)` identity digest and per-contributor/per-capture-day counts; and
- for configuration, the exact content SHA-256.

The importer uploads and verifies each target segment. It then creates a target snapshot and replays only that snapshot into a fresh SQLite database.

## No-loss reconciliation

Cutover is blocked unless all checks pass:

- every approved source path is represented once;
- every source non-empty line is represented once with the exact UTF-8 line bytes;
- source and target raw line counts match by kind and logical path;
- source and target sorted line digests match by kind and logical path;
- the complete sorted multiset of `(tweet id, contributor, exact line hash)` matches;
- unique `(tweet id, contributor)` sets match;
- per-contributor and per-capture-day tweet counts match;
- enrichment unit IDs and exact row hashes match;
- attempt event exact row hashes match;
- registry `(name, revision)` values and exact row hashes match;
- receipt exact row hashes match;
- pool, service-account, taxonomy, and vocabulary bytes match exactly;
- fresh Bucket-only replay produces the expected SQLite unique tweet and enrichment counts;
- SQLite `PRAGMA integrity_check` returns `ok`; and
- rebuilding a second time from the same snapshot produces the same logical table digests.

The report contains repository and Bucket names, source and snapshot revisions, object counts, row counts, aggregate hashes, and pass/fail results. It does not contain tweet text, configuration contents, access tokens, or service-account secrets.

## Fault tests

Tests must prove that reconciliation stops for:

- one deleted source line;
- one duplicated source line;
- one changed source line;
- one truncated compressed object;
- one object under the wrong key;
- one key with the wrong checksum;
- one source object with a changed immutable ID;
- one missing configuration file;
- one changed configuration byte;
- one unsupported or malformed record;
- one source object deleted after index state records it;
- one failed upload;
- one failed read-back; and
- one manifest that names the wrong snapshot or SQLite generation.

Tests must also prove retry idempotence, deterministic replay under shuffled listing order, safe concurrent segment creation, stable snapshot revisions, and a changed revision for any changed file set.

## Setup and credentials

Setup creates or verifies two private Buckets and one public Space:

- raw: `<namespace>/xtap-pool-data`;
- index: `<namespace>/xtap-pool-bucket`; and
- Space: `<namespace>/xtap-pool`.

`RAW_BUCKET` replaces `DATASET_REPO` everywhere. `INDEX_BUCKET` remains. The storage token validator requires read and write access to exactly both Buckets and rejects dataset-only scope. Setup, doctor, repair, and enrichment Job reconciliation use these names.

The raw Bucket already exists for this deployment, and the existing xTap storage token has already been granted access in its current secret source. The implementation may use that token in place. It must not print it or copy it into a new store. If the Space and Job already hold that same token, they keep the existing secrets. If deployment needs a credential copied from `offline/secrets` into a new destination, work stops for explicit source-and-destination approval.

## Deployment sequence

1. Finish implementation, focused tests, full `npm run check`, SimpleDoc, Pi Reviewer, PR review, CI, merge, and deployment staging.
2. Verify the new raw Bucket is private and empty or contains only objects from the same pinned import contract.
3. Suspend the enrichment schedule and verify that no enrichment Job is running.
4. Stop or pause the Space at a safe boundary. Extension durable staging queues must retain unsent captures while the ingest endpoint is unavailable.
5. Resolve and record the final dataset commit SHA after the Space is stopped.
6. Run the importer and no-loss reconciliation against that exact revision.
7. Create and verify the final raw snapshot.
8. Bootstrap the SQLite index from only that snapshot and publish its verified generation and index manifest.
9. Configure `RAW_BUCKET` and retain `INDEX_BUCKET`; remove `DATASET_REPO` from Space and Job variables.
10. Deploy the merged code. No production process may read the old dataset.
11. Wait for the Space to report `RUNNING`, the intended source revision, valid Bucket credentials, the intended raw snapshot, and the expected counts.
12. Let one already-staged real extension submission reach ingest. Verify its transaction segment, response, SQLite row, explorer/API visibility, pool sync receipt, and local xTap JSONL durability.
13. Restart the Space once. Verify a fresh process restores the published index, advances from the raw Bucket, and serves that real post.
14. Run the existing bounded enrichment canary. Verify raw enrichment segments, a new exact snapshot, a verified index generation, receipt durability, and matching source revision.
15. Resume the enrichment schedule only after the canary passes.
16. Verify pool sync and passive xTap capture without image downloads.
17. Resume the historical Infinite Feed Scroller backfill from its deepest verified safe day with a one-day overlap and continue its separate recovery-capable monitoring.

## Failure behavior

Before the final dataset revision is pinned, a failure leaves production on the old code and no cutover has started.

After the Space stops, any import, reconciliation, index, configuration, or deployment failure keeps ingestion offline. Operators fix the new Bucket path and retry from the same pinned source. They do not restart the legacy dataset runtime. Client staging queues retain captures during this bounded outage.

After the new Space starts, a failed real ingest, restart proof, or enrichment canary suspends enrichment and stops the Space if continued writes could make diagnosis unsafe. Recovery stays on the Bucket contract. The old dataset is input to the pinned recovery importer only and never becomes a production fallback.

A raw object conflict, checksum failure, missing pinned object, reconciliation mismatch, unknown record, invalid credential scope, or inconsistent index manifest is a material blocker. No cleanup follows it.

## Verification commands

The implementation must add documented commands for these operations:

```sh
npm run storage:import -- --dataset <repo> --revision <sha> --raw-bucket <bucket> --report <path>
npm run storage:verify -- --dataset <repo> --revision <sha> --raw-bucket <bucket> --report <path>
RAW_BUCKET=<bucket> INDEX_BUCKET=<bucket> npm run index:bootstrap
npm run doctor -- <space>
```

Before merge:

```sh
npm run check
npx -y @simpledoc/simpledoc check
pi-reviewer --base main
```

Production evidence must include the pinned source SHA, raw snapshot revision, imported source and target object counts, all reconciliation counts and digests, SQLite manifest counts, deployed Git SHA, Space runtime SHA, real ingest segment key and receipt identifiers without post text, restart proof, and enrichment canary receipt.

## Acceptance criteria

- The plan, schema, implementation, operator commands, and deployment behavior agree.
- The runtime contains no dataset source, dataset fallback, dataset variable, dataset write, dual read, or dual write.
- Exact pinned-source reconciliation proves that no valid post or durable record was lost.
- A fresh process builds and serves the same logical state using only the raw and index Buckets.
- A real extension submission is durable before success and remains visible after restart.
- The enrichment canary writes raw Bucket evidence and publishes a verified matching index.
- Production remains on Hugging Face and uses one raw Bucket plus one index Bucket.
- Images remain disabled.
- The old dataset remains unchanged and unavailable to production runtime code.
- Bob's historical backfill resumes only after storage cutover verification and preserves its existing receipts and local JSONL.
