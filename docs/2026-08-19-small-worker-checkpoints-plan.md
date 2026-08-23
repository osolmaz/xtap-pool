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
[HF Job Control](https://github.com/osolmaz/hf-job-control/blob/feat/durable-job-resume/docs/2026-08-19-durable-job-resume-plan.md).

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
- Prepare the next compact work database from the already open final publication database, advance that local copy to the latest raw snapshot, carry the completed registry baseline forward while retaining candidates first observed after the frozen plan time, and activate the successor only after its plan and bootstrap checkpoint verify.
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

A normal continuation downloads the frozen plan and small checkpoint. It then
replays only the raw output segments claimed by that checkpoint into the compact
worker database so queue results, registry statuses, and registry revisions are
exact before new work starts. It does not restore the public database. The Job
builds that database once after queue and registry work is complete.

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

## Bootstrap preparation and commit

Bootstrap has two phases. Preparation is read-only. Commit owns every remote
write.

This boundary fixes a defect found during the production transition. The first
bootstrap resolved taxonomy before it loaded the validated raw snapshot. An
empty `BucketLog` therefore treated all 19,140 historical segment files as new,
downloaded them serially, retained them in memory, and reported no exact
progress. The repair must load known snapshot identities before taxonomy
resolution.

### Bucket capabilities

Reader interfaces expose only listing, download, and text reads. Writer
interfaces add upload, deletion, checkpoint publication, activation, and
pointer replacement. Preparation accepts readers only. The read-only shadow
binary must not import a provider, checkpoint writer, activation writer, upload
method, delete method, or schedule method.

A validated snapshot can seed `BucketLog` only after all of these checks pass:

- The snapshot bytes hash to the source revision in `index/current.json`.
- The snapshot names the expected raw Bucket.
- Every segment key, size, content hash, and listed object identity is valid.
- No key or identity is duplicated.

Seeding records known immutable identities. It does not claim that the current
process downloaded those segment bodies. Head discovery still lists all keys
so it can detect deletion, size drift, or identity drift. It downloads and
fully verifies bodies only for new or conflicting tail objects.

Tail body verification can use a small fixed worker pool. Verification results
must be retained by immutable key and applied in sorted key order, so request
completion order cannot change the projection. The first missing, deleted,
changed, duplicate, or invalid object fails preparation.

### Read-only preparation

Preparation does this work in order:

1. Read and parse `index/current.json`. Record its exact bytes and SHA-256.
2. Require the expected raw Bucket, database key and SHA-256, source snapshot
   revision, projection contract hash, predecessor identities, and counts.
3. Use the manifest contract hash only to restore the already validated
   database and raw snapshot. Verify the 1,328,619,520-byte database, its
   SHA-256, provenance, schema, and `PRAGMA quick_check` result.
4. Seed `BucketLog` with the validated snapshot before it reads taxonomy.
5. Resolve taxonomy from the seeded log. Derive the taxonomy and model contract
   and require exact equality with the manifest contract before tail work.
6. Discover the current raw head against the known snapshot. Check every known
   listing identity and download only the tail.
7. Verify tail bodies with bounded concurrency and apply them in deterministic
   order. Durable registry revision 31,201 must appear exactly once after base
   revision 31,200.
8. Advance a disposable local database. Verify source continuity, receipt
   continuity, queue state, registry state, leases, retry timestamps, and all
   physical row counts.
9. Export queue IDs and input hashes in deterministic order. Build the completion
   bitmap and preserve unresolved retry or blocked details.
10. Build the registry candidate plan with the production discovery algorithm.
    Verify the saved cursor by scanned count, last name, and receipt time.
    Exclude old candidates at or before that name, but retain candidates first
    observed after the receipt even when their names sort before the cursor.
11. Build and verify the compact local work database. Run its SQLite integrity
    and provenance checks.
12. Return a content-addressed `BootstrapCandidate`. Do not write a remote
    object.

The candidate records:

- The source pointer bytes and digest.
- The base database key, size, digest, and source revision.
- The validated raw snapshot and discovered head revisions.
- The ordered tail digest and counts.
- The taxonomy, model, provider, worker revision, and contract digest.
- Queue and registry totals, baselines, ordinals, cursor, and unresolved state.
- The compact local database path, size, and digest.
- Exact progress totals and elapsed time for each preparation stage.

Observational timestamps do not contribute to semantic identity. Repeated
preparation from the same inputs must produce the same candidate identities and
local artifact digests.

### Exclusive commit

`commitBootstrapCandidate` is the only bootstrap operation that can write the
plan, work database, initial checkpoint, activation claim, or active-run hint.
It must revalidate the candidate digest, source head, public pointer bytes, and
exclusive-writer admission immediately before its first write. It uses the
existing `bootstrapEnrichmentRun` and `activateEnrichmentRun` formats. The repair
must not change compact-run keys, checkpoint formats, claims, or public pointer
formats.

The production bootstrap command composes preparation and commit. The shadow
command calls preparation only. A candidate prepared while another writer is
active cannot commit until a later exclusive-writer check passes.

### Progress

Preparation reports these stable stages:

- Manifest and pointer validation.
- Database download and byte verification.
- Snapshot load and known-identity seeding.
- Head listing and known-identity checks.
- Tail body verification.
- Deterministic tail application.
- Queue and registry projection.
- Compact database validation.
- Candidate validation.

Each stage reports exact completed and total items or bytes and elapsed
milliseconds. These events are local observations. They do not add a remote
progress API or a new durable format.

### Read-only shadow validation

While the original production importer is active, a shadow run must remain
structurally read-only. For this transition, session 216 and PID 3252076 identify
the original importer and only possible writer:

1. Create a clean repair worktree from merged revision
   `c0a1a95ebf6a4209f9f4d9505e9b6748af08216b`. Leave the dirty documentation
   tree and exact deployment worktree unchanged.
2. Record the original process state and I/O, active xTap Jobs, Space revision,
   enrichment state, suspended schedule, public pointer bytes, and complete
   `operations/enrichment/runs` object listing.
3. Run all deterministic tests, repository gates, mutation tests, and review in
   the repair worktree. Fix all P0 and P1 findings before a live shadow run.
4. Start the shadow in a fresh local directory with only the approved storage
   credential mapped to `HF_TOKEN`. Do not load `INFERENCE_TOKEN`.
5. Use conservative tail concurrency. Stop only the shadow if it harms original
   process I/O or host health.
6. Monitor exact shadow progress and the original process independently. Do not
   signal, cancel, restart, or replace the original process while it progresses.
7. If the original writes during shadow preparation, treat that as observed
   source drift. The shadow remains read-only and must revalidate its candidate
   before later use.
8. Verify the candidate schema and digest, local artifact sizes and hashes,
   SQLite integrity and provenance, source and ordinal continuity, queue and
   registry parity, and exact single application of revision 31,201.
9. Prove provider calls are zero.
10. Re-read the public pointer, active-run object listing, Jobs, Space, and
    schedule after the shadow exits. Require no shadow-caused change.

The shadow writes only local candidate and evidence files. It cannot write a
plan, checkpoint, activation claim, publication, pointer, Space setting, or
schedule. It cannot launch a Hugging Face Job.

Do not commit, push, open, merge, or deploy the repair during shadow validation.
If the original importer completes validly, compare its immutable result with
the shadow candidate and prefer the accepted production result. If the original
fails without writes, the production transition can consider the reviewed
repair only after it proves that no writer is active and repeats all admission
checks.

## Files

Add:

```text
space/src/enrich-run-plan.ts
space/src/enrich-checkpoint.ts
space/src/enrich-state.ts
space/src/enrich-batch.ts
space/src/enrich-planned-command.ts
space/src/bootstrap-enrichment-run.ts
space/src/prepare-enrichment-bootstrap.ts
space/src/verify-enrichment-bootstrap-main.ts
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
space/package.json
package.json
```

`durable-index.ts` remains the public-index import and publication boundary.
Normal queue and registry work uses the work plan and checkpoint plus immutable
raw output segments. The new preparation module is the shared read-only import
path. The production bootstrap adds commit capability at its composition root.
The shadow composition root has read capability only.

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

The bootstrap repair also needs tests for:

- Validated snapshot seeding, known-body skipping, and rejection of duplicate,
  missing, deleted, changed, malformed, or wrong-Bucket identities.
- The tail verification concurrency ceiling, deterministic application order,
  fail-fast behavior, and exact progress totals.
- Manifest-first database and snapshot restore followed by independent taxonomy
  and model contract verification.
- Queue and registry parity, source continuity, and exactly one application of
  registry revision 31,201.
- Read-only capability enforcement, zero provider construction, and zero remote
  writes from the shadow binary.
- `BootstrapCandidate` schema, canonical bytes, digest, local artifact hashes,
  and repeated-run determinism.
- Prepared-state equivalence between seeded-tail preparation and full replay.
- Live before-and-after evidence for pointer bytes, active-run objects, Jobs,
  Space state, original process state, progress counts, and provider calls.

## Production baseline

The final legacy Job completed on 2026-08-20. Use this generation as the only
bootstrap input:

- Public pointer SHA-256:
  `5a259cc95a3437d1c983d7d123efe476cf6bf3d48e14f97fec31bb4067834740`.
- Database SHA-256:
  `9e9940b063f615dae42ed86ba08ec6aab27873b61b8da8b7ad42ee8fff413c12`.
- The database is 1,328,619,520 bytes.
- The queue has 252,042 completed records out of 252,504. It has 462 pending
  records, no leases, and no retry timestamps.
- The registry scan has checked 15,840 of 25,675 candidates.
- The database contains registry revision 31,200.
- The later durable registry revision is 31,201. The importer must apply it
  exactly once after the base revision.
- Settled restoration spend is $102.3746080.
- Conservative exposure before the new canaries is $602.3746080.
- The approved cumulative restoration ceiling is $2,000.
- The merged worker revision is
  `c0a1a95ebf6a4209f9f4d9505e9b6748af08216b`.

The final receipt, pointer, full database hash, `PRAGMA quick_check`, source
identity, queue state, registry revision, and raw segment hashes were verified.
The legacy schedule is suspended and no enrichment Job is active.

## Production transition

This is a hard replacement. Do not start another legacy full-index worker.
Keep all schedules suspended until the final activation step.

1. Re-read the final receipt, pointer, database, raw segment frontier, Job list,
   and schedule. Stop if any identity differs from the production baseline.
2. Create or verify a clean deployment worktree at the exact merged worker
   revision. Keep documentation updates outside that worktree. Do not deploy
   uncommitted files or a later revision, and do not merge or change the pinned
   HF Job Control dependency during this transition.
3. Before each paid action, add settled spend, prior unreceipted attempt caps,
   active reservations, and the next worst-case action. Stop before an action
   that can take conservative exposure above $2,000.
4. Load only the approved storage and inference credentials in a short-lived,
   non-traced process. The Space, canary Jobs, and scheduled Job may contain
   only `HF_TOKEN` and `INFERENCE_TOKEN` where each interface requires them.
5. During the bounded bootstrap repair, leave the original importer running as
   the only possible writer. Run the repaired shadow with `HF_TOKEN` only. It
   prepares and verifies a local candidate but cannot commit or activate it.
   If the original importer completes validly, use its immutable result and
   compare it with the candidate. If it fails without writes, use the repaired
   commit path only after all tests and review pass and a new admission check
   proves no writer is active.
6. Run `npm run enrich:bootstrap-run` from the accepted exact worktree only when
   exclusive-writer admission passes. The importer must restore the exact base,
   advance over later valid raw segments including registry revision 31,201,
   write the frozen plan, compact work database, bootstrap checkpoint,
   activation claim, and active-run hint, then read them back. A repaired
   bootstrap must prepare the candidate first and revalidate the pointer,
   source head, candidate digest, and writer exclusion before commit.
7. Treat `operations/enrichment/runs` as the isolated future-runtime namespace.
   The suspended legacy schedule and old deployed worker do not read it.
   Capture `index/current.json` before and after import and require byte equality.
8. Validate the imported plan SHA, run ID, source snapshot, worker revision,
   contract hash, base reference, queue and registry order, cursor, ordinal
   coverage, checkpoint sequence, activation chain, claims, output frontiers,
   object hashes, and unresolved rows. Revision 31,201 must be neither missing
   nor applied twice.
9. Restore the active plan and checkpoint twice into clean directories, with
   the second run using no local cache. Both restores must return the same state
   in less than five minutes, make zero provider calls, and leave all production
   pointers unchanged.
10. Deploy the merged revision from the exact deployment worktree with:

```sh
npm run update -- osolmaz/xtap-pool
```

Wait for the exact repository and runtime revision to become `RUNNING` and
`READY`. Require HTTP 200 from `/readyz`, ready storage, and enrichment
disabled before schedule repair.

11. Inspect the schedule contract without mutation:

    ```sh
    npm run --silent doctor -- osolmaz/xtap-pool --json
    ```

    Then use `npm run doctor -- osolmaz/xtap-pool --fix` to replace the legacy
    schedule. Read back exactly one suspended, non-concurrent `cpu-upgrade`
    schedule at `17 */6 * * *`. It must run
    `space/dist/src/enrich-job-main.js`, use the merged deployment contract,
    have a 2,700-second platform timeout and 2,400,000-millisecond worker budget,
    keep the checked-in $10 run ceiling, and use only `HF_TOKEN` and
    `INFERENCE_TOKEN`.

12. Recheck cost admission and trigger one physical Job from the suspended
    schedule. Require restore under five minutes and wait for a verified output
    claim and checkpoint boundary before any interruption.
13. Save the Job inspection, logs, active run, plan, checkpoint hashes, output
    frontier, provider receipt frontier, and cost evidence. Cancel only that
    physical Job. Do not create a receipt for work that did not publish one.
14. After the canceled Job is terminal and no xTap Job is active, trigger the
    same suspended schedule once. The replacement must use the same run ID and
    plan SHA, restore the prior checkpoint, reconcile orphan outputs, process
    only missing ordinals, and keep progress monotonic. At most the documented
    in-flight concurrency batch may repeat.
15. Continue the frozen run one physical Job at a time. After each attempt,
    validate the terminal state, exact receipt, referenced outputs, checkpoint
    chain, claims, cost, and no-overlap state before another trigger. A valid
    deterministic blocked record is data, not a shared failure.
16. After queue and registry completion, validate resumable publication. The
    database key must equal its SHA-256, `PRAGMA quick_check` must return `ok`,
    metadata and counts must match the frozen plan and completed checkpoint,
    and every manifest and receipt reference must exist. Move
    `index/current.json` only after full read-back.
17. Resolve every activation claim and require one contiguous chain. The
    completed plan must create exactly one verified successor, with no competing
    plan or work object. The active hint must match the last valid claim.
18. Run the two-Job steady canary while the schedule is suspended. Use the hard
    ceiling reported by setup doctor and pass the approved ceiling explicitly:

    ```sh
    npm run doctor -- osolmaz/xtap-pool --fix --canary \
      --approved-cost-ceiling-usd=<approved-canary-ceiling>
    ```

    Validate both receipts and every referenced output. Both Jobs must use the
    successor, restore bounded state, and remain non-overlapping.

19. Activate only after every earlier gate passes:

    ```sh
    npm run doctor -- osolmaz/xtap-pool --fix --canary \
      --approved-cost-ceiling-usd=<approved-canary-ceiling> --enable-schedule
    ```

    Read back exactly one active canonical schedule. Remove the legacy schedule
    and source revision. Leave no physical xTap Job active at handoff.

## Failure handling

Fail closed before new provider calls or pointer writes when an identity, hash,
ordinal, predecessor, cursor, source revision, or count differs.

If import writes only part of the new immutable graph, keep the public pointer
and schedules unchanged. Re-run only after every existing immutable object
matches the intended bytes.

If a read-only shadow detects pointer, source, or object drift, stop only the
shadow and preserve its candidate and evidence. It must not signal the original
importer or commit remote state. Revalidate the candidate only after the source
and writer state are stable.

If shadow CPU, memory, disk, or network use harms the original importer or host,
stop only the shadow. Keep its bounded concurrency low and preserve the original
as the only writer.

If deployment fails, keep the schedule suspended. Repair only the bounded defect
inside this repository, run the full quality gates and review, and repeat the
failed gate. Do not substitute an upstream dependency or unreviewed runtime.

If a Job stops outside a verified boundary, preserve its inspection and logs,
then restore from the last valid checkpoint and reconcile orphan outputs. Do not
fabricate a receipt or mark unverified work complete.

If repeated work exceeds one in-flight concurrency batch, stop the run and
investigate the claim frontier before another paid attempt.

If the next action can take conservative exposure above $2,000, do not launch
it. Preserve the current state and report the exact cost evidence.

## Acceptance criteria

The work is complete when:

- Read-only preparation seeds the validated snapshot before taxonomy lookup,
  downloads no known historical body, verifies only the tail, and reports exact
  progress.
- Shadow validation makes zero provider calls and leaves the public pointer,
  active-run objects, Jobs, Space, and schedule unchanged.
- The exact legacy generation and revision 31,201 are imported without changing
  the public pointer or any raw object.
- A normal continuation does not download the public SQLite database.
- Two cold checkpoint restores take less than five minutes and make zero
  provider calls.
- Checkpoint restore takes less than five minutes at current production size.
- Queue and registry totals remain fixed for one logical run.
- Completed queue work and registry decisions are not repeated.
- At most one in-flight concurrency batch repeats after interruption.
- Progress stays monotonic across physical attempts.
- Registry work never resets because queue work or new source data appeared.
- A completed run activates exactly one verified successor, and the next
  scheduled Job uses it without schedule replacement.
- Interrupted final publication resumes from its last claimed state and reuses
  uploaded or verified immutable artifacts.
- Resumed and uninterrupted runs produce the same logical database and manifest.
- Invalid, duplicate, overlapping, or conflicting ordinal state fails before
  new provider calls or pointer writes.
- Two steady canary receipts and every referenced output validate.
- Settled spend and conservative exposure stay at or below $2,000.
- The Space is healthy on the merged runtime with enrichment disabled.
- Production uses one active non-concurrent schedule at `17 */6 * * *`, with
  only `HF_TOKEN` and `INFERENCE_TOKEN`, and no legacy runtime path.
- No physical xTap Job is active at final handoff.
