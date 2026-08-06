---
date: 2026-08-06
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
title: Add durable receipts for browser scrape jobs
tags: [extension, scraping, receipts, chrome]
---

# Durable scrape-job receipts

This plan adds a browser-local record of which posts xTap observed during an Infinite Feed Scroller job. The result should let one command open an X list, capture posts through xTap, stop when coverage is complete, recover after an extension restart, and explain why the run stopped.

xTap remains passive outside an explicitly opened scrape run. Infinite Feed Scroller remains responsible for movement and retry handling. It also owns job state. Tweet contents continue to live in xTap's local output and the pool dataset.

## Requirements

- Support steady catch-up runs and explicit historical date ranges.
- Use xTap observations as the source of truth for coverage.
- Preserve enough browser-local state to replay observations after an MV3 worker or page restart.
- Record the list, post ID, post time, first-seen time, and capture sequence without copying tweet contents into the scroller.
- Leave a durable run report with start and finish times, counts, final confidence, and stop reason.
- Stop with a clear blocked or failed state when xTap is unavailable. Scrape jobs must not silently use DOM timestamps as replacement evidence.
- Keep normal recording, playback, loop, and live-generator behavior independent of xTap.

## Boundaries

This change does not add a scheduler or system service. It does not change pool credentials, send new requests to X, or copy credentials between extensions. It does not move tweet contents into a second store.

The first steady run for a list has no earlier list coverage. That run uses xTap post timestamps to cover the current UTC day. Later steady runs stop at posts that xTap observed for the same list before the run began.

## Ownership

xTap owns capture receipts and the external protocol. Infinite Feed Scroller owns scrape jobs and reports. The launcher starts a dedicated Chrome profile, loads both extensions, opens the xTap run, and then opens the list.

The scroller has a stable unpacked-extension ID. xTap accepts the external port only from that ID. The xTap extension keeps its existing ID and storage, so its pool connection is not migrated.

## xTap data

xTap stores the following records in IndexedDB:

- A receipt for each unique post with its post time, first-seen time, source endpoint, and global capture sequence.
- A list receipt for each `(listId, postId)` pair. This prevents a post seen elsewhere on X from counting as prior coverage of the target list.
- A run record with its list, baseline capture sequence, known-list count at start, last observation cursor, state, and timestamps.
- Ordered run observations. Each observation records the post ID, post time, observation time, capture sequence, and whether that list-post pair was known before the run.

Run observations contain no post text, author data, or pool token.

## External protocol

The protocol uses a named `chrome.runtime.connect()` port. Every message carries protocol version `1` and a run ID.

The scroller opens a run before opening the X tab. xTap returns the durable run record and replays observations after the requested cursor. The list tab then reconnects with its last applied cursor and receives new observation batches. Duplicate batches are safe because observation cursors are monotonic.

The scroller closes the xTap run with a terminal state. The state records successful completion, a failure, or a user abort. xTap retains the run and its observations for later inspection.

## Completion rules

A backfill job keeps the last 50 unique list observations. It gains confidence only while new observations arrive and the whole window is older than the requested start day. Three clean updates complete the job.

A steady job uses the same window. After a list has earlier coverage, a clean window contains only list-post pairs known before the run. The first steady run for a list instead uses the current UTC day as its bootstrap range. Hard limits still stop a job after two hours or 3,600 update cycles.

The exact window and streak remain visible in the job trace so later tuning can use observed runs.

## Recovery

The job page opens the xTap run before list navigation, which prevents the first timeline response from racing the receipt setup. A reconnect asks xTap to replay observations after the last applied cursor. The estimator can also rebuild from cursor zero after a full page restart.

Only one xTap scrape run may be active at a time. Reopening the same run is idempotent. A second run receives a conflict instead of replacing the active run.

## Acceptance criteria

- xTap records list observations before applying its normal capture deduplication.
- A post seen on another timeline does not count as prior coverage of the target list.
- Reopening a run returns the same baseline and ordered observations.
- A sender other than the stable scroller extension ID cannot open the protocol.
- The scroller opens the xTap run before creating the list tab.
- Steady jobs stop on established list coverage and bootstrap from xTap timestamps when the list has no coverage.
- Backfill jobs stop only after passing the requested range.
- A missing bridge blocks the job and stops movement.
- Completion and abort append one durable run report.
- Both repositories pass their local quality gates and browser-independent protocol tests.

## Verification

In `xtap-pool`:

```sh
npm run test:extension
npm run check
```

In `infinite-feed-scroller`:

```sh
npm run check
npm run mutate
npm run slophammer
```

A manual browser pass still needs a logged-in X profile. Run one bootstrap steady job, a second steady job against the same list, and a historical backfill. The second steady job should stop when its fresh window reaches posts recorded before that run.
