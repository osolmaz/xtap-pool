---
title: Incremental consumer reads and engagement history plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-07
tags: [consumer-api, observations, engagement, incremental, extension, storage]
---

# Incremental consumer reads and engagement history plan

Our Models needs two source capabilities from xTap: efficient access to changed content, and timestamped engagement observations for story ranking. Implement them together in xtap-pool before resuming the dependent story work.

The earlier Our Models work stopped repeated AI processing and made checks cheap when xTap's revision stayed unchanged. It did not eliminate the complete source read after a revision change. The reported failure case was a 56-minute run over roughly 42,550 source entries that found no new, changed, or deleted entries and needed no AI calls. Another reported changed-data run took 86 minutes. These are incident inputs, not measurements repeated for this document. Verify the entry-versus-individual-post counts during the baseline measurement.

The required result is specific: a harmless source revision change must not cause a complete post download, and a new likes/views observation must not rerun semantic processing. Saving future counts in Our Models alone would leave both historical access and the content-change problem unresolved.

Status: **implementation in progress** on `feat/incremental-consumers`. The bounded raw-history audit, repeat delivery, indexed source effects, historical point reads, content clocks, bootstrap readiness, signed cursors, bounded change pages, and private history reads pass local tests. The HTTP APIs, bootstrap cutover, Our Models integration, and live verification are not complete. No replacement extension, Space, Job, schedule, credential, resource, or spending limit has been deployed by this implementation. Existing approved enrichment work remains active.

## Ownership and related work

This is the canonical cross-repository explanation of the xTap prerequisite. Keep source collection, provenance, observation history, and incremental source reads here. Our Models owns model eligibility, story grouping and writing, attention calculations, ranking, and its website publication.

Related documents:

- [Unit consumer API](2026-07-27-unit-consumer-api.md): the current full-read contract. Its normal full-download procedure will be replaced when the new reader and consumers pass the checks below.
- [Immutable Bucket log](2026-08-12-bucket-object-log-plan.md): the authoritative storage and replay boundary. This plan extends that design; it does not restore Dataset/Git runtime storage.
- [Small worker checkpoints](2026-08-19-small-worker-checkpoints-plan.md): logical runs, durable results, revision handoff, and scheduled Job recovery remain applicable.
- [Browser scrape-job receipts](2026-08-06-scrape-job-receipts-plan.md): browser-local coverage receipts are distinct from engagement observations.
- [Our Models story plan](https://huggingface.co/spaces/osolmaz/ourmodels/blob/main/docs/2026-09-06-daily-feed-and-organizations-plan.md): the consumer's model-only story requirements. This is an operational source link; the public website is [ourmodels.cc](https://ourmodels.cc).

Do not copy this plan into Our Models. Link to it from the consumer implementation record. Keep the separate model-profile work independent.

## Current implementation evidence

The following facts were checked in the repository at `3945d92`. They describe the checked-in implementation, not proof of the installed browser version or the amount of historical production data.

| Area                                                | Current behavior                                                                                                                                                              | Consequence                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/tweet.ts`                               | Validates basic tweet fields with a loose schema. Extra fields, including supplied metrics, survive validation.                                                               | Historical counter values can exist in stored records, but the schema does not establish complete or well-typed counter coverage. |
| `space/src/ingest.ts`                               | Appends accepted records to the verified raw Bucket log before updating the local index or returning success.                                                                 | Accepted repeat observations are durable.                                                                                         |
| `space/src/store.ts`                                | Accepts only a newer `captured_at` for each post/contributor. Keeps only the latest record within a submitted batch and in its current SQLite row.                            | Older arrivals and intermediate same-batch observations can be discarded before reaching the raw log.                             |
| `space/src/bucket-log.ts`                           | Writes complete accepted records into immutable, verified segments.                                                                                                           | The raw log is the existing history source. No additional raw archive is needed.                                                  |
| `extension/background.js`, `extension/lib/dedup.js` | Uses persisted seen post IDs to skip ordinary repeats before `poolEnqueue`. Article and image-backfill exceptions are not a general engagement-history path.                  | Repeated browsing does not prove repeated metrics reached the pool.                                                               |
| `extension/lib/pool-sync.js`                        | Uses a persistent, at-least-once queue. Its current overflow behavior drops the oldest entries.                                                                               | Increasing observation volume requires explicit queue bounds, recovery, and loss reporting.                                       |
| `extension/lib/scrape-receipts.js`                  | Records list/run observations before ordinary post deduplication. The records contain post IDs, post times, observation times, and run positions, but no engagement counters. | A scroller coverage receipt cannot reconstruct past likes or views.                                                               |
| `shared/src/hash.ts`                                | Excludes counters and capture timestamps from semantic input hashes.                                                                                                          | Preserve this separation. A repeat observation must not reclassify unchanged text.                                                |
| `space/src/unit-store.ts`                           | Uses a process boot UUID plus SQL revision triggers. Many table writes invalidate cursors, including tweet and queue writes.                                                  | Revision changes are not a list of actual content changes. A restart can invalidate a consumer read without changing its content. |
| `space/src/unit-store.ts`                           | The cutoff filters the latest stored capture for a unit. It is not a historical version lookup.                                                                               | A later count observation can affect cutoff membership unless content and observation times are separated.                        |
| `space/src/durable-index.ts`, `space/src/server.ts` | Restore a verified index, discover raw segments, and apply a verified tail. The Space advances locally after ingest and checks external results every 5–60 seconds.           | Reuse this bounded source-advance path to build change indexes.                                                                   |
| Existing index publication                          | The non-concurrent Job, or an authorized maintenance command, owns the shared `index/current.json` publication. The Space does not publish that shared generation.            | Do not introduce a second mutable publication authority for this feature.                                                         |

The statement “xTap already saves history” therefore needs a qualification: its raw storage preserves accepted repeated records, but the current extension and ingest deduplication can prevent those records from arriving or being saved. Production history coverage remains unmeasured.

## Requirements

- Preserve useful observations of existing posts, including unchanged counter values at genuinely different observation times.
- Keep exact content changes, observation changes, and internal bookkeeping changes separate.
- Let consumers read only changes since a durable cursor, without scanning all post bodies to discover them.
- Include removals, unit membership changes, label changes, registry visibility changes, and public-source eligibility changes. A new-observation endpoint alone does not satisfy this requirement.
- Give a consumer one consistent source boundary for content, labels, related metadata, and observations. Identify observation freshness separately from content completeness.
- Preserve the current author-ID allowlist and `public-original` restrictions. No subscriber-only content, retweet-only units, contributor credentials, or private administration data may enter a public consumer feed.
- Make paging and replay safe across concurrent source writes, retries, Space restarts, and consumer crashes.
- Reuse the private raw Bucket, private index Bucket, existing Space, existing extension storage, and existing Job/checkpoint machinery.
- Keep observations useful to ordinary authorized consumers. Do not require a Story schema, an Our Models dependency, or an agent-specific progress protocol in xTap.
- Validate both source efficiency and the final website update time. Fewer AI calls alone do not complete the work.

## Scope and non-goals

The implementation includes a production-history audit, the repeated-observation path, typed normalized history, indexed content differences, stable snapshot/cursor reads, bounded recovery, setup checks, and the coordinated Our Models reader change.

It does not add a new Bucket, Dataset, database service, scheduler, queue service, vector database, or independent raw store. It does not change the enrichment model, taxonomy meaning, hardware, schedule, source account permissions, or spending limits as an incidental fix.

There is no automatic creation of new X requests or a guarantee that a six-hour list visit observes every post again. A changed browsing/revisit policy is a separate, explicitly reviewed step after coverage is measured. Do not bypass platform access restrictions.

The capture implementation must follow `AGENTS.md`: passive browser-level observation from extension-owned contexts. The existing main-world fetch/XHR interception must be replaced rather than extended or copied. First inventory any existing compliant capture adapter. If a replacement needs additional browser permissions or a debugger attachment, report those requirements and obtain approval before enabling it. Do not use page-owned API wrappers as a temporary fallback.

## History and capture audit

Perform this first, before promising growth measurements or freezing the history schema.

1. Identify the actual installed extension build and the capture path used by the scheduled browser visits. Compare it with the checked-in deduplication and pool enqueue paths. Check whether another approved exporter sends repeats.
2. Pin a verified raw Bucket snapshot and record its identity. Inspect a bounded sample across the last seven days and more than one completed visit. Start with at most 50 segments or 64 MiB compressed input, whichever is reached first. Report the actual files, bytes, and time. Expand only through an explicit bounded audit decision.
3. Count physical records, distinct post IDs, distinct normalized observation identities, posts with two observations, and posts with three observations. Report counter availability separately for likes, replies, reposts, and views.
4. Compare observation times with browser run receipts. A run receipt proves that a post was encountered, not that its metrics were retained or sent.
5. Inspect time gaps, exact duplicates, same-time conflicting counts, counter decreases, invalid timestamps, and values that were missing, rounded, or represented as strings.
6. Run a small browser canary using the approved capture path: observe a selected public post, observe it again, and confirm distinct observation times survive browser restart, queue delivery, raw persistence, and index replay. Use recorded fixtures for most tests; do not generate unnecessary X traffic.
7. Record whether the first implementation can recover useful history, has only sparse history, or must begin measuring growth from deployment onward.

Store raw audit inputs only in approved private working storage. Track the bounded audit procedure, aggregate counts, snapshot/checksum references, and conclusions in this repository. Do not commit captured text, account-specific browsing history, credentials, or a raw export.

No repeat records means unknown historical growth. Do not fabricate an earlier count of zero. Do not infer metrics from scroller receipts, current totals, or a post's publication date.

### September 7 audit and first implementation slice

The audit used existing local Hugging Face authentication in place. It read only the canonical private raw and index Buckets. The source snapshot was `36f27e68bf5ba7cfa53a6fedd7ba6fa66906113d058a048dd1384e7aa37034aa`; the active manifest named database checksum `2083eaf860cc69d038371eb2e3adf83366411baf21fbcb83e0062d44d3f623e2` and projection contract `2a2814ad4162457c0b8fe6de9cc07e0813f9fffadd3bde21ca46c731cc58de69`.

The selection took seven evenly spaced tweet segments per available UTC day from September 1 through September 6. The pinned snapshot had no September 7 tweet segment. Each selected object passed compressed-size and uncompressed-checksum verification. This was a bounded sample, not a complete history audit.

| Measure                                              |             Observed value |
| ---------------------------------------------------- | -------------------------: |
| Selected segments                                    |                         42 |
| Compressed bytes                                     |                    263,173 |
| Physical records and distinct raw observation tuples |                      1,196 |
| Distinct post IDs                                    |                      1,136 |
| Posts with two distinct observation times            |                         60 |
| Posts with three observation times                   |                          0 |
| Repeat pairs from the same contributor               |                         60 |
| Repeat pairs 1–18 hours apart                        |                         18 |
| Minimum / median / maximum interval, hours           | 5.8992 / 25.6423 / 25.6427 |
| Download and first-pass audit time, seconds          |                     33.682 |

All 60 pairs had changed view counts. Likes changed in 40 pairs, replies in 29, and reposts in 16. Two pairs had decreasing reply counts. Among the 18 pairs 1–18 hours apart, nonzero, nondecreasing endpoints were available for likes in 16 pairs, replies in 10, reposts in 8, and views in all 18. This sample supports some historical growth measurements, but does not establish acceleration coverage.

All 1,196 records had numeric values for the four counters. That does not prove that each counter was observed: the old parser replaced absent likes, replies, and reposts with zero, and partially parsed view strings. The sample contains 289 zero likes, 574 zero replies, and 918 zero reposts without a format marker. Their original meaning cannot be recovered from the saved parser output. Historical normalized zero values therefore remain null. Positive historical values retain their raw source reference; the original GraphQL counter was not independently verified.

New parser output marks the metrics object with `format: "exact-v1"`, admits only exact nonnegative safe integers or exact decimal strings, and preserves actual zero separately from null. This marker is excluded from content identity with the other metric fields. It does not change historical raw records.

The checked-in extension already uses passive Chrome Debugger Network capture in `lib/graphql-capture.js`. It does not need a new capture permission or a replacement main-world script for this task. A read-only process check found no local Chrome or Chromium browser, so the installed browser build and live browser canary remain unverified.

The first source slice adds normalized observations, immutable content versions, and physical provenance keyed by segment, operation, logical path, and line position. Server admission keeps delayed and same-batch observations. Exact logical retries remain idempotent. Browser delivery occurs before unique-post export deduplication, and queue admission is saved with sampling state. A full queue leaves staged work pending; it does not discard the oldest observation. Staged responses now survive browser restart and retain their original observation time.

A complete ingest acknowledgment accounts for every submitted observation as accepted, duplicate, or explicitly rejected. The browser saves explicit rejections in a local archive capped at 500 records; it continues valid work without silently dropping rejected data. Queue removal and rejection records are saved together. Archive overflow blocks removal and leaves the pending batch intact.

Local validation of this slice passed `npm run check`: formatting, lint, TypeScript, 597 Vitest tests, 188 extension tests, 180 native Python tests, coverage, and the duplicate-code check. Raw replay tests compare the same physical source references against immediate ingest, including operation and line positions. These are local results, not evidence of deployment or end-to-end publication speed.

The next committed slices add historical content/result dependencies and point reads for old and target source sets. Metric-only updates and exact result retries produce no content candidates. Membership changes, label approvals, delayed source keys, and content conflicts remain candidates for exact comparison. Historical reads reconstruct only the requested entries in a bounded temporary database, not a complete old database.

Content coverage now uses the start of the current content version, not the latest metric observation. Tests cover all six delivery orders of a three-observation edit/revert sequence, late discovery of an intervening edit, UTC normalization, and same-time private changes. Current and historical result reads use the same deterministic tie rule.

A separate consumer projection hash binds the derived index rules without changing the LLM contract. The saved consumer boundary contains the actual approved registry state and commits with the source inventory. Every new segment checks its observation, membership, and result-reference counts. Unsupported historical result rows retain a physical reference but cannot supply current labels. An old index with empty new tables remains unavailable to consumer reads and cannot publish a new index until explicit bootstrap. Output-segment application now stores the verified source snapshot before committing its rows and boundary; a storage failure does not acknowledge partially applied work.

These slices passed `npm run check`: 635 Vitest tests, 189 extension tests, 180 native Python tests, formatting, lint, TypeScript, coverage, and the duplicate-code check. The overall line coverage was 86.11%. These are local checks, not live throughput measurements.

These changes alone do not remove the Our Models full read. The bounded HTTP contract, explicit production bootstrap, and incremental website publication remain required before this task is complete.

## Repeated observations

### Separate delivery from post-ID deduplication

Keep the post-ID deduplication needed by local unique-post exports independent from pool observation delivery. A known post must still reach the observation path when it is observed again. Count unique posts and observations separately in local status.

Create a stable observation identity before durable enqueue. Persist the observation and delivery state together before marking it handled. A worker restart or retry must resend the same observation identity and timestamp, not invent a fresh observation at recovery time. Staged browser responses must retain their original observation time as well; reparsing a staged response must not stamp it with the recovery time.

Use the existing pool outbox where it can provide these guarantees. If its current storage cannot update queue and dedup state safely together, use a transaction in the extension's existing IndexedDB storage. Do not maintain two competing outboxes. Treat a full queue as an explicit degraded/blocked state; do not silently discard acknowledged work or persist a seen marker for an observation that was never saved.

For burst control, start with at most one ordinary metric sample per post per five-minute sampling interval. Record its actual observation time, never the interval boundary. Six-hour visits must not be suppressed by lifetime post-ID deduplication. Content edits and visibility changes must be delivered immediately and must not wait for this metric sampling interval. Test and report any intentional sampling loss; do not describe sampled history as every browser response.

A distinct later sample with unchanged counters is useful: it supports a measured zero increase. Within an interval, exact delivery replays are duplicates. Do not replace several independently queued observations with only the latest record before persistence.

### Server acceptance

Replace the current “latest timestamp per post/contributor” ingest admission rule for observations with observation-identity idempotence. Keep a separate latest-post projection for browsing.

- Accept a valid delayed observation even if a newer one is already stored. It must not overwrite newer content or newer latest counts.
- Preserve multiple valid observations for one post in the same batch.
- Treat an exact retry as one logical observation. A successful retry returns the original result without writing duplicate logical work.
- Preserve conflicting observations rather than silently selecting the larger count. Identical IDs with different bytes are an integrity error.
- Normalize valid timestamps to UTC before comparison. Bound future clock skew and report invalid or unsupported timestamps. Receipt time and observation time remain distinct.
- Keep contributor attribution server-controlled. Client observation IDs do not authorize another contributor's identity.
- Persist accepted raw records before success. A projection failure after raw persistence remains recoverable by replay and does not require recapture.

Historical raw objects remain immutable. The new reader normalizes old accepted records during the explicit backfill; it does not rewrite them to look like newly generated observations.

## Observation data

Use a small normalized observation record. The following is a proposed consumer example, not a currently available endpoint response:

```json
{
  "id": "obs-example-001",
  "post_id": "1234567890",
  "observed_at": "2026-09-07T06:00:00.000Z",
  "received_at": "2026-09-07T06:00:12.000Z",
  "content_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "metrics": {
    "likes": 400,
    "replies": 18,
    "reposts": 25,
    "views": null
  },
  "source_ref": "opaque-source-record-reference"
}
```

The example IDs are illustrative. Freeze the actual identity encoding and canonicalization vectors in shared schemas and tests during implementation.

| Field          | Type           | Meaning and validation                                                                                                                                            |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | string         | Stable logical observation identity. Deduplicate delivery by this value, independently of post identity.                                                          |
| `post_id`      | string         | Immutable X post ID. Retweet wrappers must not add another copy of the original post's counters.                                                                  |
| `observed_at`  | UTC timestamp  | When the source actually observed these counts. Preserve the original time through retries.                                                                       |
| `received_at`  | UTC timestamp  | First durable pool receipt time for this logical observation. Useful for delay measurements, never a substitute for observation time.                             |
| `content_hash` | SHA-256 string | Reference to the observed content version. A later content edit must not attach an old observation to an invented text version.                                   |
| `metrics`      | object         | Required named counters, each an exact nonnegative safe integer or null. Unknown is null.                                                                         |
| `source_ref`   | opaque string  | Resolves internally to immutable segment identity, operation, and record position. It does not expose a Bucket URL or contributor identity to the public website. |

Use `reposts` in the new consumer contract and normalize the source's existing `retweets` field at the source-reader boundary. Do not maintain two synonymous consumer fields. Preserve supplied bookmarks, quotes, and other raw fields in the original record; they do not need to become ranking inputs in this task.

Do not turn an abbreviated display such as `1.2K` into an exact count of 1,200. For the initial exact-count contract, report that metric as null and retain the original value and normalization outcome in private provenance. Invalid or negative historical fields are also unknown with a diagnostic, not silently clamped to zero.

Define logical identity from stable normalized source identity, observation time, content identity, and counters. Preserve enough authenticated source context internally to distinguish independent observations and diagnose conflicts. Exclude receive/retry time from logical identity. Keep exact raw references for duplicate deliveries; the consumer must not count those deliveries separately. Historical normalization must produce the same IDs across shuffled replay, index rebuild, and process restart.

## Indexed storage and change detection

### Canonical storage

Inventory and reuse the deployed `RAW_BUCKET` and `INDEX_BUCKET`; the existing design uses `osolmaz/xtap-pool-data` for raw segments and `osolmaz/xtap-pool-bucket` for replaceable indexes. Verify actual deployment variables during implementation. An access failure does not authorize replacement resources or credential copying.

Retain the raw Bucket as the only complete source history. Extend the existing SQLite projection with normalized observations, distinct content versions, and reverse indexes for affected posts and units. Keep immutable source references and replay checkpoints in the existing storage scheme.

Do not add a separately mutable consumer head or an independent feed publisher. The Space can derive and serve bounded changes from its verified local source advance, as it already does for current reads. The existing authorized index publisher remains the only writer of the shared index manifest.

### Stable boundaries

Use a content-addressed raw snapshot plus the semantic contract and normalized selection as the durable consumer boundary. The current boot UUID and SQL revision counter are unsuitable for this purpose.

A consumer cursor must describe the exact raw object set already consumed, not a timestamp or a lexicographic segment-key high-water mark. Raw writers can run concurrently, and a newly discovered object can have an earlier timestamp. Compare verified snapshot membership to find new segments. Store the exact snapshot manifest before issuing a durable cursor that refers to it; an unpersisted local hash is insufficient.

This reuses the existing immutable snapshot mechanism. Snapshot manifests are metadata, not duplicate post exports. Normal advance reads and applies only new source segments. Query handlers must not rescan historical segment bodies.

The audited snapshot has 38,219 segment descriptors and takes 15,752,981 bytes as canonical JSON. A metadata-size diagnostic used that snapshot with synthetic tails of 1, 16, 128, and 1,024 files. A retained base reference plus those exact additions took 502, 6,682, 52,837, and 422,019 bytes, respectively. At 1,024 additions, it saves 15,330,962 bytes per boundary, or 97.32%, before amortizing a new full base. This exceeds the 90% minimum worthwhile reduction chosen for this extra metadata logic. These are deterministic size calculations, not historical source deltas, network throughput, USD cost estimates, or launch approval.

The bounded page engine now compares exact old and target content, emits removals, and returns retained observations when content first becomes eligible. It filters by historical account membership before reading content and checks current privacy on every upsert and history read. Raw retries do not duplicate logical observations. Recorded classifier results can be reused after an exact content revert; an invalid later quote does not erase a valid prior result. Local validation passed: `npm run check` with 667 Vitest tests, 189 extension tests, 180 native extension tests, 86.80% line coverage, and `npx simpledoc check`. HTTP authorization, worker deadlines, and live recovery remain separate unfinished gates.

The implementation therefore stores an immutable full base through the existing raw snapshot store and places its hash plus explicit additions in the read context. It rolls the base after 1,024 additions or a 1 MiB descriptor. Reconstruction verifies the checksum of the complete source set. It rejects removed, mutated, or duplicated files and includes late keys; it does not use a key watermark. At most two loaded bases are cached in memory. Read contexts belong in the existing index Bucket and do not replace its shared manifest. HTTP deadlines, retained-context cleanup, and real publication timing still need their rollout checks.

Separate the time of a substantive content version from the time of its latest metric observation. A count-only revisit must neither remove an already completed unit from cutoff selection nor advance content completeness by itself. Status and content reads must use the same completed-content boundary. An edit that invalidates the current enrichment must produce the documented pending/removal state until a matching result is ready; stale enrichment must not be attached to the edited text. Include this distinction in status, replay, and cutoff regression tests.

### Derived indexes

Settle exact SQL names in the shared schema review, but implement these distinct responsibilities:

| Derived data            | Required key/index                                                            | Purpose                                                                            |
| ----------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Normalized observations | Unique observation ID; `(post_id, observed_at, id)`; source segment reference | Bounded post history and idempotent replay.                                        |
| Content versions        | `(post_id, content_hash)` with source references and visibility metadata      | Separate text/context edits from metrics; evaluate a pinned source version.        |
| Source effects          | `(segment_key, affected_entity_kind, affected_id)`                            | Find changed candidates from a raw snapshot difference without scanning all posts. |
| Unit dependencies       | Post-to-unit and prior-to-current membership references                       | Handle added replies, splits, merges, author corrections, and removed membership.  |
| Label dependencies      | Unit-to-label and label-to-unit references, including registry decisions      | Find the units whose consumer-visible labels or selection changed.                 |
| Pinned read metadata    | Snapshot identity, contract identity, selection, bounded page position        | Reproduce a multi-page read without relying on process memory.                     |

Build source-effect entries in the same SQLite transaction that applies a verified raw segment and advances the indexed source inventory. A crash must not mark a segment applied without its observations and change candidates. A schema/bootstrap change must not discard these indexes merely because the latest-post table can still be restored.

For each candidate unit, compare the exact consumer-visible content at the old and target boundaries. Emit an upsert only if its content or permitted relationships changed. Exclude counts, observation time, pooled time, queue bookkeeping, and attempt receipts from that content identity. Include text, expanded links, media metadata used by consumers, authorship, membership, visibility, and published labels. Keep the narrower existing enrichment input hash where its semantics remain unchanged.

An account rename can require display metadata to change without requiring an LLM call. A registry approval/rejection can change label selection without changing tweet text. Distinguish these dependencies explicitly rather than using one hash to invalidate every processing stage.

An internal attempt, receipt, or queue write can advance the raw snapshot while producing zero consumer changes. It should advance the consumer cursor through a small empty result. A taxonomy/policy change that truly affects all selected units is broad work; report it explicitly and require the bounded re-evaluation or reset procedure. Do not disguise it as an ordinary small update.

### Historical reads and bounded page construction

The selected approach is indexed differences between pinned source snapshots, using stored content/observation versions and source effects. Do not create a globally increasing consumer sequence independently in each process. Such sequences can disagree after a Job restore or a Space restart.

Before finalizing this implementation, prove that the old and target selected views can be read for affected IDs without reconstructing a full old database. Test delayed segments, unit regrouping, and registry changes. If the existing SQLite model cannot provide this, extend its version/dependency indexes before adding API handlers.

A page must remain fixed while new source data arrives. Read the target version through indexed immutable versions, or freeze the necessary bounded response batch in checksum-addressed derived storage in the existing index Bucket. Use one mechanism after the prototype; do not ship parallel fallback readers. Any derived page cache is temporary, authorization-checked, and reconstructible. It must not become a second permanent source archive or a mutable publication authority.

This proof is a design gate. “Fetch changed IDs and then read each ID's latest row” is insufficient: a concurrent edit could mix versions, and a removal may no longer have a current row.

## Consumer API

Change the owned version-1 contract in place and coordinate its consumers. Do not add a parallel `v2`, boot-epoch fallback, or automatic full-scan compatibility path. Keep current query routes that still serve independent browsing or administration uses; do not retain them as a hidden fallback for the incremental publisher.

### Bootstrap

A new consumer explicitly requests one pinned snapshot for its normalized selection. Continue using `/api/units` for this explicit bootstrap, with the new durable snapshot/cursor semantics. Use exact author IDs, label mode, and `publication=public-original` throughout.

The bootstrap returns the matching complete content state, approved label/graph state or exact references to them, a declared observation-history range, and the resume cursor at the same boundary. Bootstrap pages must survive a Space restart and later source writes. The consumer does not advance its durable cursor until the snapshot is fully validated and saved.

A pre-existing verified Our Models publication may be adopted as the bootstrap baseline only if its source snapshot, contract, selection, content digest, and cursor boundary are proven to match. Otherwise perform one explicit bootstrap. “It looks similar” and matching row counts are insufficient.

### Changes

Proposed route:

```http
GET /api/changes?after=<opaque-cursor>&limit=200
Authorization: Bearer <configured-service-credential>
```

The cursor binds the normalized author/label/publication selection from bootstrap. Reject conflicting query filters. Do not expose raw segment URLs or ask the consumer to list the Bucket.

Proposed response envelope:

```json
{
  "schema_version": 1,
  "source": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "complete_through": "2026-09-07T01:22:00.000Z",
  "observations_through": "2026-09-07T06:00:00.000Z",
  "cursor": "opaque-next-position",
  "has_more": false,
  "changes": []
}
```

`source` names the pinned raw snapshot. `complete_through` describes completed content/enrichment coverage for the selected accounts. `observations_through` is the latest included observation time, or null if none is available; it is not a promise of complete observation coverage up to that time.

The returned `cursor` is the position to save only after applying that page. While `has_more` is true, it remains inside the same fixed old-to-target snapshot comparison. After the final page it represents the fully consumed target boundary. New writes wait for the next comparison. A response with zero changes can still advance the source boundary.

Provide typed changes for:

- **Unit upsert:** complete selected content and published associations/labels for a new or changed unit, with a stable content hash. Separate metrics from this content identity.
- **Unit removal:** the previously visible unit ID and an appropriate public removal reason, without the withdrawn text. Include old IDs after regrouping, author/filter changes, subscriber-only transitions, or label eligibility changes.
- **Observation:** a normalized observation for a selected, permitted post. It must not imply that content changed.
- **Shared metadata change:** approved taxonomy/registry/graph changes, or exact bounded references to matching state at this source boundary. They must not require a full post read to update metadata.

Emit observations for currently completed, publishable content without waiting for another LLM pass on unchanged text. An observation associated with content that is not yet eligible must not leak through the public-original selection. When that content first becomes eligible, provide its permitted retained observations even if they were received before the consumer's previous cursor. Test this explicitly.

Compute removals against both old and target membership. Filtering only the newest rows misses posts that left the selection. An absent post in a browsing session is not evidence of deletion; use an explicit source removal, an observed content/visibility change, or a documented membership/eligibility change.

### Post history

Proposed route:

```http
GET /api/observations?post_ids=1234567890,2345678901&since=2026-09-01T00:00:00Z&until=2026-09-08T00:00:00Z&at=<source-cursor>&limit=200
Authorization: Bearer <configured-service-credential>
```

Use inclusive `since` and exclusive `until` on actual observation time. Require a bounded post-ID set and time range. Return stable pages ordered by `(post_id, observed_at, id)` at the pinned source boundary. Include observation counts/coverage and the earliest available history bound. Missing history must be explicit.

This endpoint supports the initial bounded history recovery, audits, and later story activation. Normal operation uses `/api/changes`; it must not re-read the complete history of every story on every poll.

### Bounds, validation, and errors

Initial limits to verify against real unit sizes and throughput:

- 200 changes or observations per page by default; 500 maximum.
- 100 post IDs and a 30-day range per history request.
- 2 MiB target response size and an 8 MiB hard page limit.
- 30 seconds maximum server-side work per request; client deadlines must leave time to receive the response.
- A 48-hour lease for an unfinished pinned page sequence; 30 days of supported incremental cursor recovery and hot observation history initially.

These are proposed operational limits, not measured capacity or spending approval. Test unusually large threads and articles. Never silently truncate a complete unit or skip it and acknowledge its cursor. If a valid unit exceeds the hard limit, return a specific oversized-source error. If the audit finds such units in the required source set, bounded unit-member paging is an implementation prerequisite rather than a production surprise.

Return structured errors:

| Status        | Meaning                                                                         | Consumer action                                                                      |
| ------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `400`         | Malformed cursor, dates, IDs, limits, or conflicting selection                  | Correct the request. Do not retry unchanged.                                         |
| `401` / `403` | Missing, expired, revoked, or insufficient credentials                          | Stop; preserve the last good publication.                                            |
| `409`         | Contract/selection mismatch or a privacy change that invalidates an active page | Reconcile the explicit reason; do not silently restart a complete download.          |
| `410`         | Cursor or pinned page lease is outside retained support                         | Use explicit bounded recovery or an approved bootstrap.                              |
| `413`         | One valid content item exceeds the supported complete-item bound                | Stop that content advance with an actionable error; do not fabricate a partial item. |
| `429`         | Capacity limit                                                                  | Retry the same cursor with bounded backoff and `Retry-After`.                        |
| `502` / `503` | Temporary source/index unavailability                                           | Retry the same page with a finite elapsed-time and attempt limit.                    |

Cursor decoding validates schema, size, source references, selection, contract, and position. A cursor is not an authorization token. Never trust a client-supplied Bucket path or fetch an arbitrary URL from it. Ordinary source writes and restarts do not invalidate a valid cursor.

### Authorization and privacy

Reuse service accounts and configured credentials in place. Define an explicit observation-history read permission alongside the current unit/taxonomy permissions. Confirm whether the existing Our Models account has the required grants; a broader grant or credential copy requires the named operator action before rollout.

Apply current authorization on every page, including cached pages. Historical selection never grants access to subscriber-only, revoked, or otherwise withdrawn source bodies. If a privacy withdrawal invalidates an unfinished page, stop that page with a specific privacy-change response and provide a safe removal/reconciliation path. A consumer must not need to fetch the forbidden body to process its removal.

Do not expose contributor IDs, raw private history, API credentials, or private Bucket URLs in Our Models. Its browser reads only the published public result.

## Growth measurements and rechecks

xTap supplies source observations and coverage facts. Our Models calculates attention using ordinary code, not an LLM.

For a valid pair, retain both counts and both timestamps. Calculate the absolute difference and divide by actual elapsed hours. A change from 100 to 400 likes over six hours is an increase of 300, averaging 50 per hour. It does not identify when those likes arrived within the interval.

Use at least three suitable observations for acceleration. Compare adjacent elapsed-time-adjusted rates, retaining both interval lengths. Do not mix a twelve-hour gap with a six-hour interval without accounting for the difference.

Missing counters, a first observation, identical timestamps, excessive gaps, stale endpoints, and conflicting observations produce an unavailable signal for that metric. Counter decreases remain recorded as corrections/anomalies; do not convert them into positive growth or silently clamp them to zero. Missing intervals must not prevent other valid intervals from being inspected.

Keep likes, replies, reposts, and views separate. Views are not unique people or endorsements. Compare similar post ages; use author baselines only when enough matched observations exist. Keep raw counts, intervals, coverage, and sample sizes alongside normalized scores. Cap individual-post and author contributions in Our Models, and treat copied/reposted sources as shared evidence rather than independent confirmation.

Start with existing visits. If coverage is inadequate and a revisit policy is later approved, evaluate:

- Broad coverage of new relevant posts during their first 48 hours, at the existing six-hour cadence.
- Continued visits for posts in active discussions for a few more days.
- Older posts only when new evidence or an explicit request justifies them.

Do not select only already popular posts. Do not couple xTap to Our Models Story IDs; any requested post set must remain a normal, bounded source operation with its own authorization. Changes to Infinite Feed Scroller belong in that repository and need their own implementation/merge authority. This plan does not silently expand that work.

## Our Models integration

Implement this consumer phase only after xTap's source contract and recovery tests pass.

1. Replace revision-triggered full reads with explicit bootstrap plus persisted change cursors. Reuse the existing frozen source work and publication coordination machinery.
2. Apply each page's content, removals, observations, and metadata in a local transaction with its resume cursor. A failed transaction leaves the earlier cursor intact.
3. Save the applied source state and cursor through the existing durable checkpoint mechanism. Distinguish the cursor already applied to a staged result from the cursor actually published to the website.
4. Reuse cached results by their real dependencies. Text/model-relevant evidence changes can require association, claims, grouping, or writing. Display-only changes need only display updates. Metrics-only changes require **zero** association, claim, grouping, writing, or checking calls.
5. Map changed observations to existing supporting post IDs, then recompute only affected stories' attention. New popularity cannot bypass model eligibility, change impact into a factual claim, duplicate a story, or rewrite its original date.
6. Remove or recheck stories when their supporting source or eligibility changes. Keep the last verified story only when its evidence still remains valid.
7. Retry a failed fetch or publication from the durable page/batch boundary. Never fall back to a complete read on ordinary `409`, `502`, or `503` responses.
8. Keep exactly one publication writer. Publish a coherent verified result, then advance the live manifest and its published cursor together.

Do not stop at an incremental API. The consumer must also stop decoding the complete result cache and rebuilding/verifying/uploading the full JSON and SQLite artifacts for every count update. Measure those stages separately. Reuse the existing accepted source state and update affected data with indexed writes; make the small public story/feed result independently publishable under the same authoritative manifest if measurements show the large commentary artifact still blocks freshness. This is a consumer publication change, not a new xTap store or competing writer. Select the exact artifact layout in the Our Models implementation plan and verify atomic consistency before shipping.

Preserve one-time full build/bootstrap and explicit repair paths. Remove normal-path full scans after the coordinated replacement; do not retain them as indefinite compatibility code.

## Retention and recovery

Keep full source history in the immutable raw Bucket. Do not delete or rewrite raw segments for this task.

Start with a rolling 30-day hot observation window and sufficient version/source-effect metadata to serve every supported cursor. Retain the predecessor observation needed at the beginning of a comparison window. The first backfill should cover the requested recent story window, with a 30-day maximum per bounded backfill run. Record exact dates and coverage before launch.

An older history request can use an explicit resumable rebuild into the existing index storage. Bound source objects, bytes, elapsed time, and output size; save durable partial outputs and verified progress after each chunk. A request handler must never perform this historical rebuild implicitly.

Current index retention keeps an active generation and three predecessors. That count alone cannot guarantee a 48-hour page lease or 30-day cursor support. Retention must preserve all versions/derived references required by the declared API window, or the API must advertise a smaller verified window. Do not promise a cursor lifetime that pruning can silently break.

Cursors must survive ordinary index replacement and Space restart within that window. A full index rebuild from the same raw snapshot must reproduce observation IDs, content identities, source effects, and the same logical query results. Missing/corrupt raw objects or a mismatched contract fail closed with explicit repair evidence. A reset is an operator-visible exceptional path, not a hidden hourly bootstrap.

Before any historical build or remote canary, measure a bounded local/CPU sample, estimate the complete runtime, disk use, low/high USD cost, and worst-case retry exposure. Reuse available canonical artifacts. Verify an applicable authorization and ceiling for changed work; the unchanged enrichment contract does not automatically authorize a different backfill Job, model, hardware, or schedule. Test a real interruption and resume before substantial work.

## Implementation sequence

### Source audit and fixed tests

- Complete the production-history/capture audit and the count-semantics baseline.
- Freeze representative private fixtures and their public aggregate report.
- Include exact repeats, unchanged counts, delayed observations, same-time conflicts, content edits, reply additions, restricted posts, label changes, and a source revision containing only receipts.
- Fix acceptance limits before comparing implementations. Use practical significance and raw counts when measured differences determine architecture, scaling, or spending.

### Observation delivery and storage

- Establish the compliant passive capture path before changing extension delivery.
- Separate unique-post export dedup from sampled pool observations.
- Add durable identity/outbox behavior and replace latest-only ingest admission.
- Add normalized observation/content-version schemas and deterministic historical normalization.
- Preserve semantic hashes and prove metric-only input causes zero xTap enrichment calls.
- Add extension and server failure tests; record vendored changes in `extension/VENDORED.md` and follow the repository's vendor-maintenance process.

### Source effects and consistent reads

- Add source-effect and dependency indexes to verified tail application.
- Prove before/after membership for affected IDs without a full old-view rebuild.
- Implement stable raw-snapshot cursors and one pinned pagination mechanism.
- Handle unit removals/regrouping, metadata changes, completed-content gates, and observations that become visible with newly eligible content.
- Update index checks, count/digest verification, bootstrap, retention, restore, setup doctor, and worker restore compatibility together.

### API and bounded history recovery

- Implement shared validators first, domain operations in `space/src/`, and thin routes in `space/src/app.ts`.
- Add explicit bootstrap, changes, and history access with authorization and byte/time limits.
- Backfill the approved recent history in bounded chunks; save receipts and run interruption/resume tests.
- Complete local performance and crash tests before deploying the reader.

### Consumer replacement and production proof

- Prepare the Our Models reader and cursor checkpoints against fixed source fixtures.
- Finish the remaining incremental publication work, including metric-only output publication.
- Stage both repositories without exposing incompatible live readers. Use the exact predecessor and verified source boundary for transition.
- During required maintenance, prevent overlap between the canonical worker and maintenance/index publication. Restore the validated canonical schedule immediately afterward.
- Run the approved bounded production canary, including one source update and one zero-change poll after a restart.
- Resume story generation and landing-page implementation only after these prerequisites pass.

Do not merge or deploy a companion repository merely because this plan depends on it. Obtain the applicable authorization for each repository and changed operational contract.

## Acceptance matrix

| Case                                           | Required result                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harmless raw revision change                   | Empty bounded change response; zero historical post-body reads/downloads and zero LLM calls. Cursor can advance.                                      |
| Ten posts receive new counts                   | Exactly their new permitted observations, subject to documented sampling; no complete unit/post download and no semantic calls in either application. |
| Unchanged counts at a later visit              | A distinct timestamped observation and a valid zero increase when both endpoints are usable.                                                          |
| Content edit plus count change                 | One content-version update plus the observation; recompute only affected semantic dependencies.                                                       |
| New reply in an old conversation               | Relevant unit membership update and current reply timestamp preserved; no unrelated units reread.                                                     |
| Unit split or merge                            | Remove replaced IDs and upsert replacement membership coherently. No duplicate or stranded consumer entries.                                          |
| A label loses approval                         | Affected labels/selections change, including removals where needed. No broad post scan merely to discover affected IDs.                               |
| Newly completed content                        | Publish eligible content and its permitted earlier observations even when the observation arrival predates the old cursor.                            |
| Restricted or withdrawn source                 | No forbidden body or counters leak through historical/cached pages; process a safe removal.                                                           |
| New unrelated source write during pagination   | Remaining pages stay at the pinned target; the next cycle receives the later write.                                                                   |
| Restart between pages                          | The same cursor resumes the same logical read within its advertised lifetime.                                                                         |
| Late raw segment or delayed observation        | Arrives in a later snapshot difference and is delivered once; time-based ordering does not lose it.                                                   |
| Duplicate delivery or worker replay            | Same observation IDs and same logical result; no duplicate growth contribution.                                                                       |
| Failure after raw upload, before SQLite apply  | Verified tail replay restores observations and source effects together.                                                                               |
| Consumer crash after page receipt              | Page replay is idempotent; its cursor was not acknowledged ahead of durable state.                                                                    |
| Consumer upload succeeds, pointer update fails | Old website remains valid; retry reuses the prepared output and source cursor.                                                                        |
| Expired cursor                                 | Explicit reset/recovery response. No silent complete scan.                                                                                            |
| Counter missing/decreasing/conflicting         | Raw evidence retained; affected growth unavailable or marked anomalous, never invented or clamped.                                                    |
| Six-hour versus twelve-hour interval           | Rates use actual elapsed time. No unsupported minute-level or daily-total claim.                                                                      |
| Rebuild and shuffled replay                    | Matching logical digests, observation IDs, selection results, and source boundaries.                                                                  |
| Queue pressure or interrupted browser          | Durable queued work survives; any sampling/backpressure is explicit and countable.                                                                    |

## Performance and freshness proof

Use a fixed production-sized fixture plus small controlled deltas. Record CPU/hardware, source size, individual-post and unit counts, observation count, cache state, and software revisions. Separate cold bootstrap/restore from warm steady-state reads. Do not include startup in one candidate and omit it from another.

Proposed acceptance targets on the current supported CPU configuration:

- Twenty warm no-change polls: no post-body reads, no inference, and p95 response time at most two seconds.
- Twenty warm ten-observation updates: bounded observation payloads, zero content upserts, zero inference, and p95 source response time at most five seconds.
- Small content updates: work and transferred bytes scale with changed units and required context, not the full 42,550-entry fixture.
- Existing completed content's new metrics: visible through xTap within one successful ingest/index advance or external refresh, without waiting for the six-hour enrichment Job.
- Our Models: an already eligible observation/content change reaches the public feed within ten minutes of source availability under the tested workload. This is an end-to-end target, not a result established by faster source reads alone.

If a target is missed, report the stage and measured distribution. Do not rename a partial success as completion. Separate browser observation time, pool receipt, source availability, content complete-through, consumer apply time, and live publication time. The website's Today label cannot conceal missing content or old coverage.

Track actual changed IDs, normalized observation count, source segment bodies read, source bytes transferred, SQL rows examined/query plans, output bytes, provider calls, build/verify/upload durations, and applied/published cursor identities. These are ordinary operational facts. No monitoring-specific API or separate telemetry service is required.

Report absolute savings and uncertainty. A speed result alone cannot justify new infrastructure or paid scaling. Prefer the simpler implementation when measurements do not establish a worthwhile improvement.

## Verification commands and production checks

Repository checks for the implementation:

```sh
npm run test:extension
npm run test:extension:native
npm run check
npm run build
npm run mutate
npx -y @simpledoc/simpledoc check
```

`npm run check` includes format, lint, type checks, tests, extension tests, coverage, and duplicate-code checks. Add named regression tests for each acceptance case; do not replace failures with broad exclusions. Keep changes to installed capture components separate from fixture-only tests.

The documentation task runs `npm run check`, SimpleDoc, and `git diff --check`; implementation, mutation, live API, and production canary results must be recorded when they are actually run.

The live report must identify the tested deployed builds, source snapshot, declared selection, observation coverage, canonical index generation, and exact consumer publication. It must include an interrupted/resumed source read, an interrupted/resumed consumer update, a repeated no-op, and a metric-only update with zero measured semantic calls. Validate the actual website response after publication, not only a successful Job exit.

Never print credentials in the command line, logs, examples, or report. Use the installed CLI's configured authentication in place. New permissions, secret copies, runtime changes, and paid work require their own applicable authorization.

## Remaining decisions and completion

Settle these decisions with evidence during implementation:

- Installed capture path, available historical counter coverage, and whether passive capture needs additional approved browser permissions.
- Exact normalized identity vectors and raw-field precision handling.
- Indexed historical-version reads versus one bounded frozen-page mechanism; prove correctness before choosing the simpler viable implementation.
- Measured response, retention, backfill, and outbox limits, including maximum real unit size.
- Existing service-account grants and the required observation-history permission.
- The Our Models artifact layout that permits a small metric/story update without a complete commentary rebuild.
- Approved history window, remote canary cost ceiling, and transition timing with current Jobs.

The task is complete only when real repeat observations are preserved, historical coverage is honestly reported, content and metric changes can be consumed without normal full reads, recovery passes, and the website's measured update path meets the agreed freshness target. Story generation can then use this source boundary without rebuilding the missing foundation inside Our Models.
