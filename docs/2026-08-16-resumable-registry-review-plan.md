---
title: Make registry review resumable
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-16
---

# Make registry review resumable

The enrichment worker must save useful work before a Hugging Face Job reaches its timeout. The current worker saves post enrichment as it goes, then reviews free-label candidates in one long pass. It keeps that pass in memory until the full scan ends. A timeout can therefore discard hours of registry review.

This plan makes registry review resume from a durable cursor and makes the worker's elapsed-time limit include index restoration. It also removes the full mixed-segment scan from normal index restoration so the steady 45-minute Job can start useful work quickly.

## Requirements

- Keep the current raw Bucket, index Bucket, model, provider, taxonomy, hardware class, and concurrency.
- Preserve existing receipts and immutable segments.
- Save registry decisions before a bounded stop.
- Write a durable cursor in each receipt when a registry scan is incomplete.
- Resume an incomplete scan only when no new enrichment work changed its inputs.
- Start the worker elapsed-time budget before index restoration.
- Restore the latest receipt without downloading every mixed segment.
- Keep old receipts valid.
- Keep one physical enrichment Job at a time.

## Scope

The change covers receipt metadata, receipt replay, registry settlement, worker timing, and regression tests. It also covers deployment, catch-up recovery, two steady canaries, and steady schedule activation.

## Non-goals

- No model, prompt, taxonomy, provider, storage, concurrency, or hardware change.
- No new remote store.
- No public API contract change beyond optional receipt fields used for operations.
- No concurrent registry writes or unordered decisions. Pure Hub verification may run in bounded parallel, but registry decisions and commits must remain in candidate-name order.

## Design

1. Add optional registry-scan progress to the receipt schema. The progress records the last fully reviewed candidate, the number scanned, the candidate count, and whether the scan completed.
2. Persist and apply collected registry decisions before any bounded stop. A continuation resumes after the last durable candidate only when the current run processed no new enrichment units.
3. Restore the latest valid receipt from receipt-category segments, then inspect only mixed segments that are not older than the selected receipt segment. This preserves newer historical mixed receipts without downloading thousands of older mixed segments.
4. Run pure Hub verification in bounded parallel. Settle decisions and write registry events in deterministic candidate-name order.
5. Start the elapsed-time clock before index restoration. Pass only the remaining budget to enrichment processing. This preserves the configured gap between the worker limit and the platform timeout for receipt and index publication.
6. Keep old receipt rows readable by making the new progress field optional.

## Acceptance criteria

- A registry scan that reaches its elapsed ceiling writes a valid receipt with an incomplete cursor.
- The next no-unit run resumes after that cursor and does not repeat prior external checks.
- Decisions found before a ceiling are durable and replay correctly.
- A run that processes new units starts a fresh registry scan.
- A complete registry scan marks the receipt complete.
- Index restoration reads the latest receipt without scanning mixed segments older than the selected receipt segment.
- Restore time reduces the remaining worker processing budget.
- Existing receipt fixtures and historical rows remain valid.
- Repository checks, targeted tests, Pi Reviewer, and CI pass.
- Catch-up completes within the approved $500 total budget.
- Two steady canaries prove bounded continuation before schedule activation.

## Verification

Run:

```bash
npm run check
npm test --workspace @xtap-pool/shared
npm test --workspace @xtap-pool/space -- enrich-worker enrich-job durable-index bucket-log
npx -y @simpledoc/simpledoc check
pi-reviewer --base main
```

After merge and deployment:

1. Verify the deployed source revision.
2. Run one suspended catch-up continuation with only the approved Job secrets.
3. Validate the receipt hash, cursor, settled cost, zero reservations, registry events, and index pointer.
4. Replace the catch-up schedule with the exact suspended steady profile.
5. Run two non-overlapping steady canaries and validate continuation.
6. Activate the steady schedule and verify production health, queue state, schedule count, and cleanup.
