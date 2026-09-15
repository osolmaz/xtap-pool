---
title: Keep published units stable during enrichment
subtitle: Preserve the last valid unit while a newer thread version is being checked
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-15
tags: [consumer-api, enrichment, publication, reliability]
---

# Keep published units stable during enrichment

## Goal

A new reply must not make an already published post disappear while xTap checks
the expanded thread.

The YuE2 Story exposed this problem. xTap had published Adina Yakup's first
YuE2 post. At `2026-09-15T11:04:50.801Z`, xTap captured her second post in the
same thread. The second post linked to the Hugging Face repository. xTap grouped
the two posts into one conversation-author unit, changed the unit input hash,
and marked the unit as pending. The next Our Models source update removed the
whole unit. Its published post count fell from 89,653 to 89,652 even though the
first post and its accepted enrichment result were still valid.

xTap currently treats a new thread member and an edit to published content as
the same event. The code and tests deliberately hide every unit whose current
membership does not have an exact completed enrichment result. That rule keeps
partial units out of a fresh result, but it also turns harmless pending work
into a public removal.

## Requirements

- Keep the last valid published version of a unit visible while a newer version
  is pending, running, retrying, or blocked.
- Treat the queue's current input as working state. Treat the last accepted
  enrichment result and its exact member set as published state.
- A new same-author reply may extend working membership without changing the
  published member set.
- Publish the expanded unit only after one accepted enrichment result covers
  its exact current semantic input.
- Replace the published member set, labels, and evidence together in one
  transaction.
- Continue to hide a new unit that has never completed enrichment.
- Withdraw a published version immediately when one of its published posts is
  deleted, becomes restricted, moves to another unit, or changes semantic
  content.
- Emit a normal removal after a completed current enrichment result no longer
  matches the consumer's label selection.
- Do not emit a removal only because enrichment is unfinished or a worker,
  transfer, progress update, or Job failed.
- Apply the same rules to bootstrap and incremental reads. A fresh consumer
  must see the same last valid version as an existing consumer.
- Preserve exact source boundaries, post hashes, evidence quotes, author
  selection, privacy checks, observation history, and bounded reads.
- Keep the existing version-1 HTTP shapes. Change their behavior in place:
  `unit_remove` means that a previously published unit is no longer safe or no
  longer matches a completed selection result.
- Advance the consumer projection identity because the meaning of a visible
  unit changes.

## Scope

This work changes xTap's derived SQLite projection, current unit and labeled
post readers, historical unit reader, and incremental change engine. It also
updates their tests and the consumer contract documentation.

The production change includes a rebuilt, checksum-verified index and a
coordinated source handoff. Our Models then bootstraps or resumes against the
new projection and republishes through its existing source transaction.

## Non-goals

- Change the enrichment model, taxonomy, prompt, or label meanings.
- Classify each post independently from its thread.
- Add a second public API version or a compatibility mode.
- Change raw Bucket retention, observation identity, or privacy reconciliation.
- Replace SQLite or resume the deferred Lance work.
- Add an Our Models workaround that ignores real source removals.

## Published unit model

The current tables already contain most of the required split:

- `enrich_queue` describes the newest unit input that workers must process.
- `enrichment`, `label_assignments`, and `label_evidence` hold the last accepted
  result for a unit.

Add a rebuildable `published_unit_members` table to record the exact post set
covered by that accepted result:

```sql
CREATE TABLE published_unit_members (
  unit_id TEXT NOT NULL,
  tweet_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (unit_id, tweet_id)
) STRICT;

CREATE INDEX idx_published_unit_members_post
  ON published_unit_members (tweet_id, unit_id);
```

The table is a local projection of immutable source posts and enrichment
results. It is not a new remote store. It can be rebuilt from the raw log.

A valid published version must meet all of these conditions:

- Its enrichment result uses the active taxonomy and contract.
- Every recorded post still belongs to the same unit.
- Every recorded post has the same semantic content that produced the result.
- Every evidence quote still matches its recorded post.
- Current access checks still permit every published post.

Current working membership may contain additional posts. Those posts remain
absent from the published version until enrichment accepts the complete new
input.

## Write behavior

When enrichment accepts the current unit, one transaction replaces the
published enrichment row, labels, evidence, and `published_unit_members` rows.
It then marks the working queue row done.

When a new post joins a unit, xTap recomputes the working input hash and queues
it. Existing published rows remain unchanged.

When a published post changes content, access, or unit identity, xTap clears
that unit's published rows before it queues the new input. The existing privacy
reconciliation path remains authoritative for restricted content.

A contract change continues to use the existing index-generation handoff. The
old index remains public while the replacement is built. The new consumer
projection becomes active only with a complete verified index pointer.

## Read behavior

Current reads hydrate posts from `published_unit_members`, not from all current
members. Label, author, publication, cutoff, and sort checks use the published
member set. Current access checks still read the latest access state for those
post IDs.

Historical reads first look for an exact result for the target membership. If
none exists, they select the newest accepted result when its member set is an
unchanged subset of the target unit. If that newest accepted member set
contains a changed or moved post, the read fails closed instead of reviving an
older subset. An invalid evidence row can still be skipped in favor of the next
valid result. Candidate lookup remains bounded and uses only results present in
the pinned source boundary.

The incremental change engine compares published versions:

- unchanged published version: emit no content change;
- newly accepted version: emit `unit_upsert`;
- published version that became unsafe or failed a completed selection:
  emit `unit_remove`.

A pending queue state alone cannot make the historical target version absent.

## Migration and deployment

Bump `CONSUMER_PROJECTION_HASH` and rebuild the consumer index from the immutable
raw source. The rebuild populates published members from accepted results and
must reproduce the existing visible units before adding the new stability
behavior.

Do not activate code that expects the new projection against an old index.
Build and verify the replacement index first, deploy the matching Space
revision, and then atomically replace the index pointer. Keep the previous index
as the rollback target until the live canary passes.

After xTap is healthy, let Our Models move to the new source projection through
its normal bootstrap or recovery path. Its publication transaction must retain
existing Stories while applying unchanged published units. The YuE2 unit must
be present before the Our Models manifest changes.

## Acceptance criteria

- A completed one-post unit remains visible after a second same-author reply is
  captured and before the two-post enrichment result exists.
- The pending thread update emits no `unit_remove` and does not change the
  published unit hash.
- Bootstrap during that pending interval returns the one-post published unit.
- A successful two-post result emits one `unit_upsert` with both posts and its
  new exact hashes.
- A completed two-post result without the selected label emits one removal.
- A semantic edit to the published first post withdraws the old version until
  the edited version completes enrichment.
- A restricted or moved published post cannot be served from the saved version.
- A failed, retrying, blocked, or interrupted enrichment attempt leaves the
  published version unchanged.
- Rebuild and restart produce the same published versions and hashes.
- Existing privacy reconciliation, observation history, author filtering,
  source containment, cursor recovery, and bounded-candidate tests pass.
- The production xTap API returns Adina's YuE2 post while her second post is
  still pending, or returns the completed two-post replacement if enrichment
  has finished.
- The next Our Models publication restores the YuE2 Story with Adina's post as
  accepted evidence.

## Verification

Run focused tests while implementing:

```sh
npm run build --workspace shared
npm run build --workspace space
npx --no-install vitest run \
  space/tests/enrich-store.test.ts \
  space/tests/unit-store.test.ts \
  space/tests/consumer-changes.test.ts \
  space/tests/consumer-http.test.ts \
  space/tests/consumer-reconciliation.test.ts \
  space/tests/consumer-retention.test.ts
```

Then run the repository checks:

```sh
npx -y @simpledoc/simpledoc check
npm run check
git diff --check
```

Build a production-size candidate index from the current immutable source and
compare its counts and visible unit hashes with the current index. The expected
difference is limited to safe last-valid versions for units with additive
pending work. Inspect every other added or removed unit.

Run Pi Reviewer against `main` and fix every P0 and P1 finding. Require green CI
before merging.

For the live canary:

1. Verify the replacement index checksum, SQLite checks, source containment,
   projection identity, contract hash, and counts.
2. Activate the matching Space revision and index pointer without overlapping
   writers.
3. Bootstrap the production Our Models selection and continue one incremental
   page.
4. Confirm that pending additive updates do not emit removals.
5. Confirm that a completed update emits one exact upsert.
6. Confirm that privacy reconciliation still removes restricted content.
7. Publish Our Models and verify the YuE2 Story, source link, model link, Space
   health, and current manifest.

Keep the previous index and deployment revision until these checks pass.
