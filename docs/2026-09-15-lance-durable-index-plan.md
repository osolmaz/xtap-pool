---
title: Replace the durable SQLite index with Lance
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-15
tags: [lance, storage, index, hugging-face, operations]
---

# Replace the durable SQLite index with Lance

## Goal

Run xTap enrichment and index publication every two hours without downloading and uploading the complete 5.4 GB SQLite index on every completed run.

The private raw Bucket remains the system of record. Lance replaces the large published SQLite projection. The live site must keep returning complete, revision-consistent results while one background Job updates the projection.

This work starts with xTap. Our Models stays unchanged until xTap has run the new design successfully in production.

## Decision

Use Lance tables in the existing private index Bucket. One non-concurrent Hugging Face Job is the only writer. The Job reads only new raw objects and saved enrichment results, updates the affected Lance tables, verifies one complete generation, and then replaces one small pointer.

The Space reads through the Hugging Face S3 interface rather than a mounted Bucket. Each request uses the exact table versions named by one verified generation, so a reader sees the complete old generation or the complete new generation.

Run this path beside SQLite for six two-hour cycles. The shadow path must make no provider calls and must not change the live pointer. After all gates pass, replace the SQLite contract in place and remove the old runtime path.

The small SQLite files used for a frozen work plan or local checkpoint may remain. They do not cause the large transfer problem and are not the published read model.

## Related work

This plan replaces the large SQLite publication and restore parts of [Add a durable enrichment index](2026-08-04-durable-enrichment-index-plan.md). It keeps the raw Bucket, exact source revisions, checksums, and verified pointer publication from that design.

It keeps the logical-run, attempt, checkpoint, immutable result batch, and recovery rules from [Add small worker checkpoints](2026-08-19-small-worker-checkpoints-plan.md). A logical run must still survive several physical Jobs without repeating completed provider work.

It preserves the consumer cursor and history contracts in [Incremental consumer reads and engagement history](2026-09-07-incremental-consumer-and-engagement-history-plan.md). Storage can change without changing response meaning.

## Why this design

### Current cost

The active SQLite object is 5,398,294,528 bytes. Any database change creates a new content hash, so publication uploads another complete file. The next Job must download that complete file before final publication work.

At a two-hour schedule, twelve completed runs per day would move about 64.8 GB per day in each direction if every run downloads and uploads one 5.4 GB file. A longer timeout makes these copies more likely to finish, but it does not remove them.

### Full-size Lance pilot

The private pilot used the full xTap database and PyLance 11.0.0.

- All 20 logical tables matched SQLite by row count and ordered row hash.
- The 5.40 GB SQLite file became 1.47 GB of Lance data, a reduction of 3.93 GB or 72.74%.
- One real production delta contained 26,036 inserted rows, 5,813 updated rows, and 221 deleted rows across 18 tables.
- Applying that delta added 8,854,565 bytes to the Bucket. This was 99.84% less than another full SQLite copy.
- The table updates took about 6 minutes 45 seconds from the pilot machine.
- A complete remote comparison of all 20 tables took about 2 minutes 54 seconds.
- An intentional stop after six tables saved a durable checkpoint. A later process skipped those tables and completed the update.
- A pointer poll observed 15 reads of the old generation and 15 reads of the new generation, with no partial or malformed result.
- A private Space restarted, opened the exact remote table versions, and passed the representative timeline, author, contributor, and label queries without downloading SQLite.
- The restarted Space added only 6,007 bytes to its disk cache.
- A Hugging Face Job stopped after a saved checkpoint. A second Job resumed it and verified append, update, delete, and a production-sized timeline query.
- A Hugging Face Job refreshed all five tweet indices for a new fragment in 5.28 seconds.
- The final 542,019-row tweet table still matched SQLite exactly after index maintenance and canary cleanup.

### Minimum worthwhile effect

The retrospective threshold for this decision is:

- transfer less than 100 MB for a normal two-hour update;
- complete update, index refresh, verification, and pointer publication in less than 20 minutes after enrichment work ends;
- no full index download at Space startup;
- no result difference in a contract test;
- no mixed generation under concurrent reads; and
- no new external database service.

The full-size pilot passed the transfer and update thresholds by a large margin. One measured production delta is enough to justify a shadow implementation. It is not enough to approve a live replacement because repeated operation, the TypeScript reader, exact search, and concurrent-reader capacity are not yet proven.

### Rejected alternatives

#### Longer Jobs with SQLite

A 120-minute timeout gives the current transfer more time, but every completed run still moves the full file. Runtime and failure exposure continue to grow with the database.

#### SQLite on a mounted Bucket

SQLite requires filesystem locking and random writes. A Bucket mount is object storage presented as files and does not provide a safe SQLite database filesystem.

#### Lance on a mounted Bucket

A fresh Hugging Face Job failed on the plain hard-link operation that Lance uses while publishing a manifest:

```text
[Errno 95] Operation not supported: manifest#1 -> manifest
```

This matches the writer problem addressed by [huggingface/hf-mount#207](https://github.com/huggingface/hf-mount/pull/207). The current managed Job mount still reproduces the failure. Production must not depend on the mount until Hugging Face confirms the deployed fix and the same probe passes.

#### SQL patch files and periodic SQLite rebuilds

A custom patch log can reduce transfers between rebuilds, but it creates a second transaction, replay, compaction, and recovery system. Lance already provides immutable fragments, versions, deletion records, and indices for this job.

#### External Postgres

Postgres would handle transactions and concurrent writers, but it adds an external service, a new failure domain, and ongoing administration. xTap does not need concurrent writers. The raw Bucket already provides the durable source needed to rebuild the projection.

## Requirements

### Data and publication

- Keep `osolmaz/xtap-pool-data` as the authoritative immutable raw log.
- Reuse `osolmaz/xtap-pool-bucket` for the production Lance projection.
- Do not create another production index Bucket.
- Preserve exact source revision, source object identity, projection contract hash, schema hash, row counts, and content checks in each generation.
- Publish immutable data and one immutable generation record before replacing the current pointer.
- Open exact table versions from the generation. Never ask each table for its latest version during a request.
- Apply updates from raw source objects and immutable enrichment result batches. Production must not create two full SQLite snapshots and compare them to discover changes.
- Keep at least the current and previous verified Lance generations available while requests can still reference them.
- Remove old files only after the retention check proves that no retained generation references them.

### Writer

- Keep one physical writer.
- Keep the Hugging Face schedule non-concurrent.
- Reuse the existing logical-run and attempt identities.
- Refuse publication when another writer attempt is active.
- Do not use `HfFileSystem.open(..., "xb")` as a lock. The pilot showed that all eight supposed exclusive creates could succeed.
- Treat the current scheduled launcher and its admitted attempt as the write authority. Manual commands default to read-only verification and require an admitted attempt before they can write.
- Save a checkpoint after every completed table and index stage.
- Make each resumed table operation idempotent. A retry must detect whether its row set or index fragment is already present.
- Stop before pointer publication if any table, index, count, source identity, schema, or content check fails.
- Mark the data work complete after the final checkpoint is saved. A later progress-reporting failure must not change completed data work into failed data work.

### Readers

- Use direct object-store reads. Do not read Lance through the mounted Bucket filesystem.
- Keep one long-lived reader session per Space process so metadata and hot index pages can be reused.
- Pin one generation at the start of each HTTP request.
- Keep the old generation open until all requests using it finish.
- Refresh the pointer between requests without stopping the Space.
- Bound memory and metadata caches. Do not read every table into memory at startup.
- Preserve keyset pagination, cursor identity, history windows, privacy removal, selection binding, label visibility, and response byte limits.
- Replace the hard-coded two-active-read limit only after a load test finds a safe value.
- Return bounded overload responses rather than letting requests exhaust memory.

### Search

The current SQLite search turns a plain word query into an FTS5 phrase with a prefix on the final token. Queries containing punctuation use a literal substring path. Author names are searched with the text.

The pilot's default Lance index used a simple tokenizer with lowercase conversion, stemming, stop-word removal, and ASCII folding. That is a different contract. For the test word, SQLite returned 63,445 rows and Lance returned 63,236 after all fragments were indexed. The latest 51 rows matched, but the 209 missing rows are a real difference.

The implementation must:

- keep the current token and punctuation rules;
- use a broad Lance index only to find candidates when needed;
- apply an exact final token-prefix or literal-substring check with the same normalization as the current code;
- search text and author names;
- apply timeline order after exact matching rather than relevance order; and
- compare complete result ID sets, not only the first page.

A small pilot showed that Lance n-gram `prefix_only` behavior is not an exact FTS5 replacement by itself. Do not ship it without the exact final check.

### Credentials

- Use purpose-scoped credentials.
- Give the Space read access to the index and only the existing writes it needs for the raw log and configuration.
- Give the publisher Job read access to the raw Bucket and write access to the index Bucket.
- Generate S3 credentials only from a token scoped to the required Bucket and namespace.
- Keep the S3 access key ID and secret in Hugging Face secrets.
- Keep the endpoint and region in nonsecret variables.
- Never put credential values in Git, logs, checkpoints, manifests, or reports.
- Obtain explicit approval before copying each credential from its source to its Space or Job destination.

### Frequency and cost

The target schedule is `17 */2 * * *`.

Keep the worker's enrichment budget at 40 minutes. Raise the platform timeout from 45 to 120 minutes. Start final publication only when at least 70 minutes remain. If less time remains, save the checkpoint and let the next Job publish it.

The current `cpu-upgrade` rate is $0.0005 per minute, or $0.03 per hour. A 120-minute Job has a maximum CPU cost of $0.06. Twelve maximum-length Jobs would cost $0.72 per day before inference. Normal cost should be much lower, but the six shadow runs must measure it.

Changing from four to twelve Jobs per day also changes the possible inference exposure. Do not activate the two-hour production schedule until a cumulative control-plane ceiling covers the approved period and uses measured inference cost from the shadow and current production records. The shadow publisher makes no provider calls and does not duplicate enrichment work.

## Storage contract

### Layout

Use the existing index prefix and version number. The shadow pointer is temporary and is removed after the replacement.

```text
index/current.json
index/lance-shadow-current.json
index/generations/<generation-sha256>.json
index/tables/<table-name>.lance/
operations/enrichment/runs/<run-id>/...
operations/lance-shadow/runs/<run-id>/...
```

`index/current.json` remains the production pointer. During shadow operation it keeps its current SQLite meaning. `index/lance-shadow-current.json` points to the tested Lance generation and has no production reader.

At replacement, change the `index/current.json` contract in place. Keep schema version `1`; do not add a parallel `v2` runtime. Remove `index/lance-shadow-current.json` after the production pointer and Space have been verified.

### Current pointer

The current pointer contains only the information needed to find and verify one immutable generation:

- schema version;
- generation object key;
- generation SHA-256;
- source revision;
- projection contract hash; and
- publication time.

Replacing this small object is the only step that makes a generation current.

### Generation record

One generation record contains:

- source Bucket and exact source revision;
- ordered source-tail digest;
- projection contract and schema hashes;
- logical run ID and publishing attempt ID;
- one entry for every required table;
- one entry for every required index;
- complete physical counts;
- verification hashes and receipt identities;
- predecessor generation identity; and
- creation and verification times.

Each table entry contains the stable table path, exact Lance version, row count, primary-key definition, schema hash, and ordered content hash. A reader rejects a generation with a missing, extra, duplicate, or invalid table entry.

The implementation must draft the exact JSON Schema and Zod schema together and review the field model before code depends on it.

## Table design

The first shadow conversion preserves all 20 logical tables and their current primary keys. This gives exact comparison with the active SQLite projection and avoids combining a storage change with a domain-model change.

Add read-optimized columns or tables only when a measured query needs them. In particular, label and free-label reads should not load five complete tables on every request. The likely fix is a materialized visible-label list keyed by post ID, updated by the same publisher generation. Its schema and invalidation rules require a separate measured design before implementation.

Keep these properties:

- stable row IDs where Lance supports them;
- deterministic table order and primary-key order;
- explicit nullability and Arrow types;
- no unchecked coercion from raw JSON;
- no hidden schema inference in production writes; and
- no table-local latest-version lookup in production reads.

## Writer flow

### Bootstrap

Bootstrap is a one-time migration operation.

1. Read and hash the active `index/current.json` bytes.
2. Download the referenced SQLite database once.
3. Verify its object identity, size, SHA-256, provenance, schema, and `PRAGMA integrity_check` result.
4. Convert all 20 logical tables in bounded Arrow batches.
5. Build the required scalar and text candidate indices.
6. Compare every table by count and ordered row hash.
7. Write the immutable Lance generation record.
8. Read back every referenced object and version.
9. Publish only the shadow pointer.
10. Confirm the production pointer is byte-for-byte unchanged.

Bootstrap does not call the inference provider and does not change the production Space or schedule.

### Incremental update

Each later shadow or production attempt does this work:

1. Restore the logical-run checkpoint and exact base generation.
2. Verify that the admitted attempt is the only writer.
3. Discover and validate only raw objects after the base source revision.
4. Load already persisted enrichment result batches for the same logical run.
5. Produce deterministic insert, update, and delete sets by table and primary key.
6. Record the mutation-set hash before writing.
7. Apply each table mutation against the exact base version.
8. Save the new table version and completion receipt before moving to the next table.
9. Refresh each affected index for only the new fragments.
10. Save the candidate generation after all table work is durable.
11. Verify every table, index, cross-table invariant, source boundary, and result receipt.
12. Save and read back the verified immutable generation.
13. Replace the shadow or production pointer.
14. Save the final completed checkpoint.
15. Report progress as a separate best-effort action.
16. Exit. Do not start a new logical run in the same physical Job.

A resumed Job reads the checkpoint, verifies every claimed version, and skips completed stages. It never repeats a provider call whose immutable result receipt already exists.

### Transfer retries

Retry interrupted object transfers up to three times. Keep a partial transfer only when the remote object's identity, size, and immutable source version still match the saved receipt. Otherwise discard the partial transfer and start that object again.

Lance reads and writes many immutable objects, so normal updates should not need one 5.4 GB transfer. The retry rule still applies to bootstrap, repair, compaction, and any large fragment.

### Index maintenance

Refresh delta indices after each changed fragment. Compact only when measured fragment count, deletion ratio, or query latency crosses a checked-in threshold.

Compaction writes a new table version. It follows the same candidate, verification, and pointer flow as any other update. It must not remove files referenced by the current or retained predecessor generations.

Record:

- fragments before and after;
- indexed and unindexed rows;
- deletion ratio;
- bytes read and written;
- elapsed time;
- old and new versions; and
- every generation that still references the old files.

## Reader flow

### TypeScript S3 canary

The TypeScript object-store path is the remaining unproven part. Test it before changing application code.

1. Generate temporary purpose-scoped S3 credentials for the private pilot Bucket after explicit credential-copy approval.
2. Pin the exact official `@lancedb/lancedb` release and its native binary.
3. Connect to `https://s3.hf.co/<namespace>` with path-style S3 access and `us-east-1`.
4. Open an exact Lance table version written by the pilot.
5. Verify point, timeline, author, contributor, label, search, and history results.
6. Verify reads during a pointer replacement return one complete generation.
7. Run the two-writer race through the S3 path. Require both writes to survive or one writer to receive a clean conflict. A silent lost write fails the canary even though production uses one writer.
8. Run the same canary in the exact Space image and architecture.

If the official TypeScript package cannot open exact versions or support the required query plan, stop and revise this plan. Do not silently add a Python sidecar or community runtime.

### Query adapter

Keep HTTP routes and domain rules separate from storage. Replace direct `better-sqlite3` use with typed storage interfaces under `space/src/`.

The adapter must cover:

- explorer timeline and keyset pagination;
- deduplicated and per-contributor views;
- author, contributor, date, media, and article filters;
- preset, free, all, any, and unlabeled filters;
- exact text and author search;
- contributor counts;
- consumer bootstrap, changes, reconciliation, and history;
- privacy removals;
- source and taxonomy boundaries; and
- current readiness and physical counts.

Keep external API schemas and cursor formats unchanged. Validate every object-store response and Arrow value before it reaches domain code. New TypeScript stays strict and does not use `any`, unchecked casts, or `@ts-ignore`.

### Generation refresh

The Space loads and verifies the current generation at startup. A bounded background check looks for a changed pointer. It opens and warms the new exact versions before making them available.

A request takes a reference to the current reader set. Pointer refresh creates a new reader set and swaps one in-memory reference. The old set closes only after its active request count reaches zero.

A failed refresh leaves the last verified generation active and marks readiness degraded. It does not combine old and new table versions.

### Reader capacity

The pilot proved correctness under light use, not high concurrency. Test the exact production Space image at 2, 4, 8, 16, and 32 concurrent readers.

Use a mixed workload containing:

- 40% timeline and cursor reads;
- 20% author or contributor filters;
- 15% label and free-label filters;
- 10% text searches;
- 10% consumer change pages; and
- 5% history requests.

Run cold-start, warm-cache, pointer-change, and index-maintenance cases. Record request counts, response hashes, bytes read, memory, CPU, p50, p95, p99, 429 responses, and 5xx responses.

Proposed acceptance at 32 concurrent readers is:

- zero mixed-generation or invalid-cursor responses;
- zero 5xx responses caused by storage;
- no process restart or out-of-memory event;
- explorer timeline and simple filters below 5 seconds at p95;
- search and label filters below 10 seconds at p95;
- consumer reads within their existing 60-second deadline; and
- bounded 429 responses only after the measured safe queue is full.

Review these capacity targets before implementation. If code and cache changes cannot meet them, use the practical-significance rule before paying for larger Space hardware. Prefer the cheaper option when the measured difference does not clear a user-visible latency target.

## Failure handling

### Writer stops before a verified generation

Keep the current pointer unchanged. Preserve completed table and index receipts. Resume from the first incomplete stage.

### Writer stops after the generation is verified

Read back the immutable generation and its verification receipt. If the pointer still names the predecessor, publish the already verified generation. Do not rebuild it.

### Writer stops after pointer replacement

If the pointer names the verified generation, save the completed checkpoint and exit. A failed progress update does not change this result.

### Reader cannot open the new generation

Keep serving the last verified generation and report degraded readiness. Do not fall back to SQLite or open table-local latest versions.

### Corrupt or missing Lance object

Reject the generation. Keep the prior verified generation active. Repair by rebuilding a new generation from the raw Bucket and immutable result receipts.

### Unexpected second writer

Stop before the next table commit and keep the current pointer unchanged. Preserve evidence for both attempt IDs. Do not guess which unreferenced table version should win.

### Search mismatch

Keep the production pointer on SQLite during shadow operation. After replacement, keep the previous verified Lance generation active and fix the search projection before publishing another generation. Do not add a hidden SQLite search fallback.

## Implementation phases

### Phase 1: Runtime and S3 proof

- Add a private, bounded TypeScript canary for the official Lance package.
- Verify exact version reads through the HF S3 gateway.
- Verify the full query contract on the pilot data.
- Verify pointer swaps with active readers.
- Run the writer race and record the result.
- Measure cache size and 2-to-32-reader behavior.
- Select and pin the exact package versions only after these checks pass.

No production resource or secret changes occur in this phase.

### Phase 2: Contracts and adapters

- Define and review the pointer, generation, table-entry, index-entry, and checkpoint schemas.
- Add strict parsers and canonical serialization.
- Add a typed Lance reader interface and a typed publisher interface.
- Port query behavior behind the interfaces without changing HTTP contracts.
- Add complete search compatibility fixtures.
- Add failpoints before and after every publication boundary.

### Phase 3: Shadow publisher

- Add the bootstrap command.
- Add direct raw-tail-to-Lance mutation planning.
- Add per-table and per-index checkpoints.
- Add full generation verification and shadow pointer publication.
- Add a CPU-only two-hour shadow schedule with no provider token and no provider imports.
- Keep the canonical production enrichment schedule active and non-concurrent.

The shadow schedule uses only persisted production data. It does not perform duplicate enrichment.

### Phase 4: Shadow reader and load test

- Deploy the private reader against the shadow pointer.
- Replay representative explorer and consumer requests against SQLite and Lance.
- Compare full response bodies after removing only expected timing fields.
- Run the 2-to-32-reader load matrix.
- Run reads while a shadow generation changes.
- Record latency, memory, bytes, and errors.

### Phase 5: Six two-hour cycles

Each cycle must record:

- source predecessor and successor revisions;
- inserted, updated, and deleted rows per table;
- transferred bytes;
- table and index versions;
- checkpoint and resume state;
- publication time;
- complete table hashes;
- query and search result hashes;
- reader load results;
- CPU runtime and cost; and
- active writer count.

All six cycles must finish cleanly. A failed cycle restarts the six-cycle acceptance window after the defect is fixed because the change needs repeated operational evidence.

### Phase 6: Production replacement

1. Confirm no xTap Job is active.
2. Suspend the canonical schedule only for the replacement window.
3. Verify the final shadow generation against the active SQLite generation and raw source head.
4. Deploy the Space revision that reads only Lance.
5. Replace `index/current.json` with the verified Lance pointer contract.
6. Start the Space and run explorer, consumer, search, history, privacy, readiness, and concurrent-reader checks.
7. Replace the scheduled Job with the reviewed 120-minute, non-concurrent contract.
8. Run one bounded no-provider restore and publication canary.
9. Activate the `17 */2 * * *` schedule only after its cumulative spending ceiling and secrets are verified.
10. Remove the SQLite restore, publication, fallback, and dual-read code in the same replacement.
11. Restore normal background operation.

Prefer one hard replacement. Do not keep an automatic SQLite reader, dual publication, or indefinite compatibility path.

### Phase 7: Bounded cleanup

After the reviewed retention period:

- list every unreferenced SQLite database and Lance object;
- report exact reclaimable bytes;
- confirm no retained manifest or recovery record references them;
- obtain explicit cleanup approval;
- remove approved objects;
- verify the active and predecessor Lance generations again; and
- update the README and old plans to describe the shipped state.

## Code map

Expected implementation areas include:

- `space/src/durable-index.ts`: replace the large SQLite generation contract in place;
- `space/src/server.ts`: load and refresh exact Lance generations;
- `space/src/store.ts`: move explorer reads behind the typed query adapter;
- `space/src/consumer-worker-read.ts`: port consumer reads without changing response contracts;
- `space/src/consumer-runtime.ts`: replace the hard-coded read limit with measured bounded capacity;
- `space/src/enrich-planned-command.ts`: publish Lance from saved result batches;
- `space/src/enrich-checkpoint.ts`: record table and index stages;
- `space/src/job-progress.ts`: keep completed data work complete after reporting failures;
- `space/src/config.ts`: validate S3, cache, capacity, and publication settings;
- `setup/`: validate secrets, schedule identity, runtime revision, and the shadow-to-production transition;
- `shared/`: add only schemas shared across processes; and
- tests beside the corresponding `space/src/` and setup modules.

Do not put storage logic in HTTP route handlers.

## Test plan

### Unit tests

- Strict pointer and generation parsing.
- Canonical hashing and schema hashing.
- Primary-key mutation planning.
- Duplicate, missing, and conflicting row detection.
- Exact table-version pinning.
- Search token, phrase-prefix, punctuation, case, Unicode, and author behavior.
- Cursor and page boundaries across a generation swap.
- Writer admission and attempt identity.
- Completed-data versus failed-progress state.
- Retention reachability.

### Integration tests

- Full 20-table SQLite-to-Lance conversion on fixtures.
- Raw-tail-to-Lance update without a second SQLite snapshot.
- Insert, update, and delete across every changed table.
- Index refresh for new and deleted rows.
- Stop and resume after every table and index boundary.
- Stop before and after generation upload, verification, pointer replacement, and final checkpoint.
- Old reader plus new pointer plus new reader.
- Corrupt manifest, missing fragment, stale source, wrong schema, and wrong hash rejection.
- Search result equality for complete ID sets.
- Explorer and consumer response equality.
- Object retry with verified partial identity.
- Compaction with retained predecessor readers.

### Focused documentation check

```bash
npx -y @simpledoc/simpledoc check
```

### Implementation checks

Run these when code exists:

```bash
npm run check
```

Also run the live private canaries, six-cycle shadow check, and capacity matrix described above. A local unit suite cannot establish Bucket, S3 gateway, Space, Job, or concurrency behavior.

## Acceptance criteria

The Lance replacement is ready when:

- the official TypeScript runtime passes the S3 canary in the exact Space image;
- all 20 tables match the active SQLite generation exactly;
- normal updates read only new raw objects and saved result batches;
- a normal update transfers less than 100 MB;
- final publication finishes in less than 20 minutes after enrichment work;
- all mutation and publication failpoints resume without repeating completed work;
- one non-concurrent writer is enforced;
- readers see one complete generation during pointer changes;
- search returns the exact current result set and order for the compatibility corpus;
- explorer and consumer API contracts remain unchanged;
- the approved concurrent-reader target passes without storage 5xx errors or memory failure;
- six consecutive two-hour shadow cycles pass;
- shadow work makes zero provider calls;
- observed CPU and inference costs fit the approved cumulative ceiling;
- the Space uses read-only index credentials and the Job uses scoped write credentials;
- the raw and index Buckets remain private;
- the production schedule is active, non-concurrent, and owned by setup doctor;
- the old SQLite runtime path is removed after replacement;
- focused and full implementation checks pass at the correct stages; and
- the final deployment report records source revisions, object identities, costs, and live checks.

## Open review decisions

The reviewer must confirm:

1. A two-hour public-index freshness window is acceptable after raw ingest. Raw capture remains durable immediately.
2. The proposed target of 32 concurrent readers is the right capacity goal for the private pool.
3. Exact SQLite search behavior must remain the contract. This plan assumes yes.
4. Compact logical-run and checkpoint SQLite files may remain. This plan replaces only the large published SQLite projection.
5. S3 credentials may be created from separate purpose-scoped Space and Job tokens during implementation, with explicit source-to-destination approval.
6. The two-hour schedule may be activated only after measured cost and a cumulative spending ceiling are in place.
