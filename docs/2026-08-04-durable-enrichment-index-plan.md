---
date: 2026-08-04
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
title: Add a durable enrichment index
tags: [enrichment, sqlite, hugging-face, operations]
---

# Add a durable enrichment index

## Goal

Every fresh xtap-pool process currently reconstructs SQLite from the complete private dataset. One production Job scanned about 90,000 tweet rows, 74,000 enrichment rows, and 134,000 attempt events and spent about three hours before useful work began. A later rebuild was much faster, so the exact delay varies, but the amount of replay work grows with the full history.

Replace full replay with a checksum-verified SQLite index in the private Hugging Face Bucket `osolmaz/xtap-pool-bucket`. The private dataset `osolmaz/xtap-pool-data` remains authoritative. The index is a disposable projection that the Space and enrichment Job can restore and advance from strict JSONL append suffixes.

## Requirements

- Use the existing purpose-scoped `HF_TOKEN`, which has read and write access to exactly `osolmaz/xtap-pool-data` and `osolmaz/xtap-pool-bucket`.
- Keep one non-concurrent enrichment Job and the current paid inference, reservation, retry, quality, and runtime limits.
- Bind every index generation to one exact dataset Git revision and enrichment contract hash.
- Upload an immutable database before replacing the current manifest.
- Verify the database checksum, SQLite integrity, provenance, and physical counts before use and before publication.
- Apply only new JSONL files or strict byte-for-byte append suffixes during normal startup.
- Reject deleted files, changed prefixes, unknown paths, malformed manifests, and incompatible database schemas.
- Preserve durable batch commits and receipts when a Job exits before publishing a new index. The next process must recover them from the dataset tail.
- Keep the Space available as a public service and keep the dataset and Bucket private.
- Replace full replay in production. Do not keep an automatic legacy fallback after the initial index has been seeded.

## Scope

This work covers:

- the Bucket manifest and immutable SQLite files;
- source-file inventory and exact dataset revision tracking;
- index restore, incremental replay, validation, publication, and retention;
- Space startup and enrichment Job startup;
- setup configuration, token validation, schedule hashing, doctor checks, and deployment staging;
- bootstrap and repair commands for an explicit full rebuild;
- local, CI, and live recovery verification.

This work does not change:

- tweet, unit, enrichment, attempt, registry, or receipt contracts;
- classifier prompts or labels;
- inference providers, pricing, or concurrency;
- the dataset's role as the system of record;
- Our Models storage or publication.

## Storage model

### Current manifest

The mutable dataset file `index/current.json` points to one immutable SQLite file in the private Bucket:

```json
{
  "schema_version": 1,
  "dataset": {
    "repo": "osolmaz/xtap-pool-data",
    "revision": "0123456789abcdef"
  },
  "projection": {
    "contract_hash": "<sha256>"
  },
  "database": {
    "key": "index/databases/<sha256>.sqlite",
    "sha256": "<sha256>",
    "predecessors": ["index/databases/<previous-sha256>.sqlite"]
  },
  "counts": {
    "tweets": 84571,
    "units": 73374,
    "enrichments": 74325,
    "attempt_events": 134568,
    "registry_events": 1
  }
}
```

The manifest is strict and versioned. Publishing it uses a dataset commit whose `parentCommit` is the exact revision recorded in the database. Hugging Face rejects the commit if ingest or another publisher advances the dataset first, so two publishers cannot replace the pointer concurrently. Keys outside `index/` are outside this feature's control.

### SQLite metadata

The index keeps the existing tweet and enrichment tables and adds two small metadata tables:

```sql
CREATE TABLE index_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  dataset_repo TEXT NOT NULL,
  dataset_revision TEXT NOT NULL,
  contract_hash TEXT NOT NULL
);

CREATE TABLE source_files (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  oid TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL
);
```

`source_files` covers authoritative JSONL inputs only. The content hash describes exactly `byte_length` bytes. When a file grows, the updater hashes the same prefix in the new object and parses only the remaining complete lines. A shorter object, a prefix mismatch, or a deleted path requires an explicit rebuild.

Schemator reviewed the draft model and converged after two iterations. The accepted simplifications remove timestamps and duplicated taxonomy metadata from the manifest, use `dataset` instead of `source`, and use `enrichments` for the physical result count.

## Runtime flow

### Restore and advance

1. Read and strictly parse `index/current.json` from one exact dataset revision.
2. Download the referenced immutable SQLite object to a temporary path.
3. Verify its SHA-256 digest, `PRAGMA quick_check`, metadata, contract hash, and physical counts.
4. Pin the current dataset Git revision.
5. List authoritative JSONL files at that revision with their Git object IDs and sizes.
6. Skip unchanged files, parse complete new files, and parse only verified append suffixes.
7. Commit all database and source inventory changes in transactions.
8. Re-run integrity, metadata, and count checks before serving or claiming work.

The Space opens a writable local copy because successful ingest requests still update the local projection after the dataset commit. The published Bucket object remains immutable. The Job uses the same restore path before it claims enrichment work.

### Publish

After the worker writes its final durable receipt, it pins a dataset revision that includes every worker output, advances the local index through that revision, and then:

1. writes exact metadata and counts;
2. checkpoints SQLite and creates a compact standalone copy;
3. hashes and validates that copy;
4. uploads it under `index/databases/<sha256>.sqlite` in the Bucket;
5. downloads and validates the uploaded object;
6. commits `index/current.json` to the dataset with the indexed dataset revision as its required parent commit;
7. reads the manifest back from the returned commit and verifies the active generation; and
8. removes old unreferenced Bucket generations while retaining the current generation and three recent predecessors.

A crash before the manifest commit leaves the previous generation active. The next Job loads it and replays the durable dataset tail, including partial work committed by the crashed Job. A concurrent dataset write makes the parent-commit check fail and leaves the uploaded database unreferenced; the next successful publication removes that orphan during retention cleanup.

### Bootstrap and repair

A separate command performs the intentional full replay and publishes the first generation. Production startup requires a valid manifest after bootstrap. Missing or invalid index state fails closed with a direct repair command; it does not silently spend hours rebuilding history.

The first deployment order is:

1. build and validate an index from the current dataset without changing production;
2. upload and read back the first generation;
3. deploy the Space reader;
4. create the exact replacement schedule suspended;
5. run the required two-Job recovery canary;
6. compare the second Job's restored counts and tail size with the first;
7. activate scheduling only after all checks pass.

## Setup and credentials

Add `INDEX_BUCKET=osolmaz/xtap-pool-bucket` to Space and Job configuration. Include it in schedule identity and doctor checks.

The token validator must accept one fine-grained token scoped to exactly the dataset and index Bucket, with read and write permissions on both and no unrelated global or repository permissions. It must perform direct authenticated reads against both resources without printing the token. The setup prompts continue to install this value as `HF_TOKEN` in the Space and scheduled Job.

The Bucket client uses the official `@huggingface/hub` release already pinned by the project. No external service, source build, third-party runtime, or credential copy is required.

## Validation

### Unit and integration tests

- Strict manifest parsing rejects unknown fields, bad hashes, wrong repositories, and unsafe object keys.
- Database validation rejects checksum, integrity, provenance, contract, and count mismatches.
- A new source file applies once.
- A strict append applies only its suffix.
- Reapplying the same dataset revision changes nothing.
- Prefix edits, truncations, deletions, malformed final lines, and unknown source kinds fail closed.
- Tweet, enrichment, attempt, registry, and receipt suffixes reproduce full replay results.
- A crash before database upload, before manifest replacement, and after manifest replacement recovers safely.
- The Space and Job restore the same generation and counts.
- Token checks require both exact scopes.
- Schedule hashes change with `INDEX_BUCKET`.
- Retention cannot delete the active database or any retained predecessor.

### Local checks

Run:

```bash
npx -y @simpledoc/simpledoc check
npm run check
```

Also run a local full-replay-versus-incremental comparison over representative tweet and enrichment fixtures. Compare every relevant SQLite table, queue total, contract hash, and physical count.

### Live checks

- Publish a bootstrap generation and download it with the purpose-scoped token.
- Verify anonymous Bucket access remains `401`.
- Confirm the Space reaches ready state from the index.
- Run two non-overlapping Jobs from the suspended exact schedule.
- Verify both receipts, source revisions, index manifests, database hashes, integrity results, counts, tail rows, and costs.
- Confirm the second Job restores the first generation rather than replaying all history.
- Resume cron and verify the next scheduled Job uses the same source revision and index contract.

## Implementation measurements

A local read-only production-data check pinned dataset revision `a4bbebdba5cde0c508bd4365480d32b488974da6`. The clean replay read 91,384 tweet rows, 74,913 enrichment rows, 135,744 attempt events, and 13,808 registry events in 120.351 seconds. Loading the resulting index and checking for an unchanged dataset revision took 1.417 seconds, a reduction of 118.934 seconds, or 98.8%.

The durable and clean projections matched for tweets, unit membership, enrichment results, label assignments, label evidence, the free-label registry, recent errors, and the registry revision. Queue rows also matched except for `updated_at`, which records the local rebuild time and is not part of completion, retry, or consumer semantics.

## Acceptance criteria

The feature is complete when:

- normal Space and Job startup does not replay unchanged historical JSONL rows;
- the dataset manifest references a checksum-verified Bucket database covering one exact dataset revision;
- incremental state matches a clean full replay in tests and the live canary;
- a stale or corrupt index cannot become active;
- a crashed Job's durable results are recovered from the dataset tail;
- production has one exact non-concurrent active schedule;
- the Bucket and dataset remain private;
- CI is green and Pi Reviewer reports no P0 or P1 findings; and
- the pull request is merged with a final validation report.

If exact source provenance, strict append detection, deterministic replay, or safe manifest replacement cannot be established, leave production on the suspended schedule and report the blocker.
