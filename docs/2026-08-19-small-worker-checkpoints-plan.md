---
title: Add small worker checkpoints
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-19
tags: [enrichment, sqlite, checkpoints, hugging-face, resume]
---

# Add small worker checkpoints

## Purpose

A replacement enrichment Job must resume useful work without first restoring and
later republishing the complete public SQLite index.
Physical Jobs should be disposable. The logical run, fixed work plan, verified
results, queue state, and registry cursor must survive them.

The current durable index removed full raw-history replay, as described in
[Add a durable enrichment index](2026-08-04-durable-enrichment-index-plan.md).
The index is now about 1.3 GB, so making every physical Job restore it has become
the next bottleneck. The existing
[resumable registry plan](2026-08-16-resumable-registry-review-plan.md) saves a
cursor, but new enrichment work can still reset that scan.

This plan keeps the raw Bucket as the system of record and the public index as a
replaceable read model. It adds a separate compact work plan and worker
checkpoint. The shared checkpoint mechanics come from
[HF Job Control](https://github.com/osolmaz/hf-job-control/blob/main/docs/2026-08-19-durable-job-resume-plan.md).

## Outcome

A normal continuation will download one small work plan and checkpoint, then
process only missing units or registry candidates. It will not open the public
index. The large index will be restored and updated once, during final
publication for the logical run.

## Requirements

The implementation must:

- Freeze one source snapshot, enrichment contract, queue order, and registry
  candidate order for each logical run.
- Keep one logical run ID across physical Jobs.
- Keep each physical Job under a separate attempt ID.
- Store completion with compact bitmaps instead of full completed queue rows.
- Preserve retry and blocked details only for unresolved work.
- Save a registry cursor that queue work cannot reset.
- Persist one ordered registry event for every scanned candidate, including candidates that stay unchanged, so the cursor can always advance across exact names and ordinals.
- Validate every orphan row and attempt against the frozen unit input hash, taxonomy version, and enrichment contract before recovery advances progress.
- Publish and verify immutable result batches before checkpoint progress moves.
- Treat a checkpoint failure after a durable success as an orphan-output recovery case, not as a failed provider result.
- Use immutable sequence claims as the authoritative checkpoint history.
- Use a contiguous immutable activation-claim chain as the authoritative active-run history.
- Treat the mutable active-run pointer as a startup shortcut only.
- Resolve the active run from that claim chain so the recurring schedule never pins one completed run forever.
- Prepare the next compact work database from the already open final publication database, advance that local copy to the latest raw snapshot, and activate the successor only after its plan and bootstrap checkpoint verify.
- Repeat no more than one in-flight concurrency batch after interruption.
- Keep progress monotonic across attempts in one logical run.
- Build and fully verify the public SQLite index only after work completes.
- Reuse an already uploaded final database after an interrupted publication.
- Use the existing raw and index Buckets.
- Preserve the current model and provider. Preserve taxonomy, privacy, receipt
  semantics, and public index behavior.
- Keep one physical enrichment Job at a time.

## Boundaries

This work does not change enrichment prompts, model selection, provider,
taxonomy meaning, queue fairness, public routes, or capture storage. It does not
create another Bucket, Dataset, service, scheduler, or credential.

The current immutable recovery Jobs and their saved data remain untouched. New
code is implemented and tested on a feature branch. Production deployment waits
until recovery finishes and its final index validates.

The deployment is a hard replacement. After it is active, normal worker code
will not retain the old full-index startup path. Existing immutable databases,
segments, and receipts remain available for audit and operator-directed
rollback.

## Resume model

Each completed batch is saved once. A small claimed checkpoint records the
finished ordinals and unresolved work. `current.json` points to the latest known
claim so startup is fast, but the immutable claims remain the source of truth.

A normal continuation downloads the frozen plan and small checkpoint. It does
not restore the public database. The Job builds that database once after queue
and registry work is complete.

## Logical run plan

Create one canonical run plan:

```ts
export type ObjectReference = {
  key: string;
  sha256: string;
  bytes: number;
};

export type EnrichmentRunPlan = {
  schema_version: 1;
  run_id: string;
  created_at: string;
  source: {
    bucket: string;
    snapshot_revision: string;
    ordered_segments: ObjectReference;
  };
  contract: {
    worker_revision: string;
    contract_sha256: string;
    taxonomy_version: number;
    model: string;
    provider: string;
  };
  base_index: {
    key: string;
    sha256: string;
    bytes: number;
    source_revision: string;
    source_segment_count: number;
    receipt_count: number;
    registry_revision: number;
  };
  work: ObjectReference & {
    queue_total: number;
    queue_baseline_done: number;
    registry_total: number;
    registry_baseline_scanned: number;
  };
};
```

Canonical JSON bytes without `run_id` determine the plan SHA-256. The run ID is
`xtap-` plus the first 32 hexadecimal characters of that hash. Stored plan bytes
include the derived run ID and remain stable across attempts.

New raw segments and candidates wait for the next logical run. They cannot
change the total or reset progress in an active run.

## Immutable work plan

Store the fixed work order in `work-plan.sqlite`:

```sql
CREATE TABLE worker_queue_plan (
  ordinal INTEGER PRIMARY KEY,
  unit_id TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  taxonomy_version INTEGER NOT NULL,
  initial_status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_retry_at TEXT
);

CREATE TABLE worker_registry_plan (
  ordinal INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  evidence_hash TEXT NOT NULL
);

CREATE TABLE plan_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  run_id TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  queue_total INTEGER NOT NULL,
  registry_total INTEGER NOT NULL
);
```

Rows use deterministic ordinal order. The database retains only tweets needed
by unresolved queue work and evidence needed by remaining registry candidates.
Historical completed rows are represented by the baseline count and bitmap, so
the worker database stays small. The plan is immutable and downloaded once per
physical attempt.

## Compact worker state

The checkpoint payload contains compact application state:

```ts
export type OutputFrontier = {
  sequence: number;
  chain_sha256: string | null;
};

export type EnrichmentCheckpointState = {
  schema_version: 1;
  run_id: string;
  plan_sha256: string;
  sequence: number;
  previous_checkpoint_sha256: string | null;
  queue: {
    completed_bitmap: Uint8Array;
    done: number;
    retrying: RetryRecord[];
    blocked: BlockedRecord[];
  };
  registry: {
    next_ordinal: number;
    approved: number;
    rejected: number;
  };
  outputs: {
    enrichment: OutputFrontier;
    attempt: OutputFrontier;
    registry: OutputFrontier;
    receipt: OutputFrontier;
  };
  publication: {
    state: "pending" | "building" | "uploaded" | "verified" | "published";
    database_key: string | null;
    database_sha256: string | null;
    database_bytes: number | null;
    manifest: DurableIndexManifest | null;
  };
};
```

A 251,000-item completion bitmap is about 31 KB. Completed queue rows do not
remain in mutable SQLite state. Retry and blocked arrays contain only unresolved
records. Output chain frontiers replace an ever-growing list of result objects.

The adapter serializes this state into the content-addressed HF Job Control
checkpoint bundle. Before restore, it validates bitmap length, counts, ordinals,
hashes, and output frontiers. Restore finds the latest committed state from
immutable sequence claims. `current.json` only avoids listing those claims on a
normal startup.

## Deterministic batches

Each batch has this identity:

```text
<run_id>:<phase>:<batch_sequence>
```

The batch intent names its exact ordinals. The result object names the intent,
contract, predecessor result hash, unit outcomes, and exact immutable segment
reference.

For each batch, the worker:

1. Reads missing ordinals from the frozen plan.
2. Saves the batch identity and exact unit list locally.
3. Runs at most the configured concurrency.
4. Writes one immutable attempt segment, including concurrent dispatch
   reservations before provider calls.
5. Uploads the segment and downloads it for SHA-256 verification.
6. Updates the local bitmap and retry details, then updates counters and the output chain.
7. Commits and verifies a small checkpoint bundle.
8. Publishes and verifies its immutable sequence claim.
9. Updates and reads back the pointer hint.
10. Publishes progress from that checkpoint sequence.

A process that stops before the raw result upload may repeat that batch. On
startup, recovery compares verified raw segments after the frozen source
snapshot with deterministic result manifests. If a raw segment exists without a
claimed result, recovery creates the same result manifest, applies it, and
commits a checkpoint before any provider call.

## Queue semantics

The queue total comes from the frozen plan. A unit is done only when its result
segment is durable and the verified checkpoint marks its ordinal complete.

Retries retain attempts, error class, next retry time, and input identity.
Blocked records retain the deterministic reason and evidence needed by the
existing completion contract. Queue completion requires no pending or retrying
records and only explicitly validated blocked records.

Leases remain physical-attempt state. They are not restored. The deterministic
batch identity and result reconciliation prevent a cleared lease from losing a
completed result.

## Registry semantics

Registry candidates have a fixed order in `worker_registry_plan`. The checkpoint
stores `next_ordinal` and decision counters. Every decision is uploaded and
verified before the cursor advances.

Enrichment work cannot reset the cursor. New candidates wait for the next
logical run. A completed scan means `next_ordinal === registry_total` and the
registry output chain agrees with all decisions in that prefix.

## Final public index

Normal worker attempts do not call `DurableIndex.restore()`.

After queue and registry completion, the publication attempt:

1. Commits publication state `building`.
2. Downloads the exact base public database named by the frozen plan.
3. Verifies byte count, SHA-256, metadata, and `PRAGMA quick_check`.
4. Applies only the verified raw output segments named by this run's result
   manifests.
5. Verifies queue totals, registry revision, source frontier, and physical row
   counts.
6. Runs `PRAGMA quick_check` and uploads the database under
   `index/databases/<sha256>.sqlite`.
7. Commits state `uploaded` with the immutable key, digest, byte count, and
   complete manifest.
8. Downloads it and verifies the bytes and digest. It then verifies metadata and
   counts, checks integrity, and commits state `verified`.
9. Confirms that `index/current.json` still has the frozen predecessor bytes.
10. Replaces the public pointer, reads it back, and commits state `published`.
11. Publishes the final receipt from the claimed `published` checkpoint.

Each state change has its own checkpoint claim. A replacement reuses an uploaded
or verified database and continues at the next step. If the public pointer was
written before the `published` checkpoint, recovery recognizes the same
manifest and commits that state without another pointer write.

## Storage layout

Use the existing index Bucket:

```text
operations/enrichment/runs/<run_id>/plan.json
operations/enrichment/runs/<run_id>/work-plan.sqlite
operations/enrichment/runs/<run_id>/checkpoints/sha256-<hash>/checkpoint.hfjob
operations/enrichment/runs/<run_id>/checkpoints/claims/sequence-<n>/<attempt_id>.json
operations/enrichment/runs/<run_id>/batches/<phase>/<sequence>/result.json
operations/enrichment/runs/<run_id>/current.json
index/databases/<sha256>.sqlite
index/current.json
```

All paths except the two current pointers are immutable. The run pointer is a
startup hint. `index/current.json` keeps its existing public read contract and
changes only after a verified immutable publication claim.

## Production state import

Add a read-only bootstrap command. It will:

1. Read `index/current.json` twice and require equal bytes.
2. Download the referenced database at the base index's own frozen source
   revision, not the newer work-plan snapshot.
3. Verify size and SHA-256. Verify provenance and schema, then run
   `PRAGMA quick_check`.
4. Verify raw Bucket, source snapshot, contract, source segment count, receipts,
   registry revision, and queue state.
5. Export queue IDs and input hashes in deterministic order.
6. Build the completion bitmap and preserve unresolved retry or blocked details.
7. Build the registry candidate plan with the production discovery algorithm.
8. Verify the saved cursor by its scanned count, last name, and receipt time.
   Exclude old candidates at or before that name, but retain candidates first
   observed after the receipt even when their names sort before the cursor.
9. Write a plan and initial checkpoint under an isolated prefix.
10. Download and verify every new object.
11. Read `index/current.json` again and abort if it changed during import.

The command never writes `index/current.json`. Because recovery is still moving,
implementation tests may import a stable observed generation, but deployment
must repeat the import from the final recovery generation. After the final
production import and canary, remove the importer from the runtime image and
retain its source only as an explicit audit and migration command.

## Files

Add:

```text
space/src/enrich-run-plan.ts
space/src/enrich-checkpoint.ts
space/src/enrich-state.ts
space/src/enrich-batch.ts
space/src/enrich-planned-command.ts
space/src/bootstrap-enrichment-run.ts
space/src/bootstrap-enrichment-main.ts
```

Change:

```text
space/src/enrich-command.ts
space/src/enrich-worker.ts
space/src/enrich-store.ts
space/src/durable-index.ts
space/src/job-progress.ts
space/src/bucket-log.ts
```

`durable-index.ts` becomes the public-index import and publication boundary.
Normal queue and registry work will use the work plan and checkpoint plus
immutable raw output segments.

## Forced-stop tests

Stop the worker at each boundary:

- Before result upload.
- After result upload and before verification.
- After result verification and before checkpoint upload.
- After checkpoint upload and before claim publication.
- After claim publication and before pointer-hint publication.
- After pointer-hint publication and before progress publication.
- During public database build.
- During public database upload.
- After the `uploaded` checkpoint and before verification.
- After the `verified` checkpoint and before `index/current.json` replacement.
- After pointer replacement and before the `published` checkpoint.
- After the `published` checkpoint and before the final receipt.

Each replacement must restore verified state, avoid repeating durable batches,
and produce the same final output as an uninterrupted reference.

Corruption tests cover wrong run and plan identities, wrong hashes or sizes,
missing predecessors, multiple roots, different claims for one sequence,
malformed bitmaps, inconsistent counters, changed source snapshots, missing
result segments, broken output chains, invalid SQLite files, stale pointer
hints, and conflicting public publication claims.

## Verification

Run:

```bash
npm run check
npm run mutate
npm run doctor
npm run storage:verify
npx -y @simpledoc/simpledoc check
```

Add tests for plan determinism, production import, checkpoint round trips,
missing-only queue work, registry cursor continuity, deterministic batch replay,
publication recovery, and resumed-versus-uninterrupted equivalence.

## Delivery

1. Adopt the released HF Job Control TypeScript checkpoint package.
2. Add plans, compact state, deterministic batches, and local recovery.
3. Add the read-only production importer.
4. Run the complete forced-stop and corruption suites locally.
5. Import a stable production generation under an isolated test prefix.
6. Verify that no production pointer or existing object changed.
7. Run a remote canary only after the changed Job contract has approval.
8. Wait for the immutable recovery to finish and validate its final artifacts.
9. Suspend the old schedule and verify no enrichment Job is active.
10. Repeat the import from the final production generation.
11. Deploy the tested Space revision with Space enrichment disabled.
12. Replace the old Job schedule with one suspended exact new schedule that
    resolves the active run from immutable activation claims and has no per-run
    environment values.
13. Run the required sequential canary and verify resume, successor activation,
    and publication.
14. Activate the canonical schedule, remove the old runtime path, and keep the
    bootstrap importer outside normal runtime execution.

## Acceptance criteria

The work is complete when:

- A normal continuation does not download the public SQLite database.
- Checkpoint restore takes less than five minutes at current production size.
- Queue and registry totals remain fixed for one logical run.
- Completed queue work and registry decisions are not repeated.
- At most one in-flight concurrency batch repeats after interruption.
- Progress stays monotonic across physical attempts.
- Registry work never resets because queue work or new source data appeared.
- A completed run activates exactly one verified successor, and the next scheduled Job uses it without schedule replacement.
- Interrupted final publication resumes from its last claimed state and reuses
  uploaded or verified immutable artifacts.
- Resumed and uninterrupted runs produce the same logical database and manifest.
- Invalid, duplicate, overlapping, or conflicting ordinal state fails before new provider calls or pointer writes.
- Existing production objects remain unchanged during implementation and import.
- Production uses one active non-concurrent schedule and no legacy runtime path.
