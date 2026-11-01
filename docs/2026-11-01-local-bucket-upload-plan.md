---
title: Upload captures to the raw Bucket without the Space
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-11-01
tags: [ingest, bucket, extension, uploader]
---

# Upload captures to the raw Bucket without the Space

## Goal

Captured posts reach the raw Bucket `osolmaz/xtap-pool-data` while the Space is
paused. The Space stops being part of the write path. The pool has one writer: the
owner of a write token for the raw Bucket.

## Current state

- The extension queues observations in `extension/lib/pool-sync.js` and posts
  batches to the Space's `/api/ingest`.
- The Space runs `ingestBatch` (`space/src/ingest.ts`): `validateTweet`, then
  `stampTweet` with the verified username and `pooled_at`, then
  `store.classify`, then `BucketLog.appendTweets`. `appendTweets` writes one
  immutable `v1/segments/tweet/...` object and reads it back before it returns.
- The Space has been paused since 2026-10-02. Pool sync has no target, so
  observations stay in the extension queue.
- The native host (`extension/native-host/xtap_daemon.py`) writes local
  `tweets-YYYY-MM-DD.jsonl` files. These files keep one row per post per day and
  have no `observation_id`. They lose repeat sightings, so they cannot replace
  the pool queue as a source.

## Evidence from redtap

redtap tried an upload from the extension service worker on 2026-10-08
(`b3e6bab`) and replaced it on 2026-10-10 (`38e4fff`):

- the service-worker upload stopped responding on loopback fetches;
- MV3 suspension starved the upload retries;
- the vendored hub client needed an update after a Hugging Face Xet API change.

The working redtap design seals a batch in the extension, saves it to a downloads
folder with `chrome.downloads`, and lets a local Node process upload it with
`@huggingface/hub`. This plan uses the same split.

## Design

### 1. Extension: hand off sealed batches

- Keep the queue, admission, sampling, and `observation_id` logic in
  `pool-sync.js` unchanged.
- Replace the HTTP flush with a handoff. Seal up to `MAX_BATCH` queued
  observations into one JSONL file and save it with `chrome.downloads` to
  `xtap-outbox/<seal-time-ms>-<uuid>.jsonl`.
- Store the sealed path and UUID before the download starts. A retry writes the
  same path with the same bytes. Remove the batch from the queue only after the
  download completes.
- Seal on every service-worker wake and on a `chrome.alarms` timer, so a
  suspended worker cannot starve the handoff.
- Remove `poolUrl`, the pool token, `pool-connect.js`, and the
  `https://*.hf.space/*` host permission. Add the `downloads` permission.
  Record the change in `extension/VENDORED.md`.

### 2. Uploader: one command that empties the outbox

Add a one-shot command to `space/` that reuses the current ingest modules:

```bash
npm run push-outbox --workspace space -- --outbox ~/Downloads/xtap-outbox
```

For each outbox file, in name order:

1. Parse each line and run `validateTweet`. Move invalid lines to
   `xtap-outbox/rejected/` with the reason, so one bad record does not block
   the batch.
2. Get the contributor from the token through Hugging Face `whoami`. Never use a
   `contributed_by` value from the file.
3. Run `stampTweet` with `pooled_at` set to the seal time in the file name. A
   retry then produces the same segment bytes and the same content-addressed key,
   and `BucketLog` accepts the existing object.
4. Call `BucketLog.appendTweets`. It uploads the segment, reads it back, and
   checks it.
5. Delete the outbox file only after `appendTweets` returns.

The command has no SQLite store and no `classify` step. Readers already remove
repeats: `observation-store.ts` uses `observation_id` as the primary key and
updates on conflict.

Move the validate-and-stamp steps out of `ingest.ts` into one shared function
that the command calls. Do not keep a second copy.

### 3. Token

- The owner creates a fine-grained token with write access to
  `osolmaz/xtap-pool-data` only.
- First check whether a fine-grained token can target one Bucket. If it cannot,
  stop and report before building the uploader.
- The command reads the token from a file kept under the secrets policy. It never
  prints the token. Buckets keep no history, so a leaked write token can delete
  data.

### 4. Readers

- The scheduled enrichment Job lists `v1/segments/` through
  `createRawBucketReader`. Add a test that proves it reads a tweet segment that
  the Space did not write.
- Check that a Space restart rebuilds its index from both Buckets and includes
  these segments. The Space stays paused for this work.

### 5. Hard cutover

- Remove the `/api/ingest` route and the pool-token connect flow.
- Keep the Space for the explorer, administration, and the consumer API.
- Update `AGENTS.md`. The rule about verified contributor identity still holds,
  because the uploader takes it from the token. The rule about production
  deployments must name the uploader as a client-side part on the capture
  machine, like the extension and the native host.

## Running the uploader

The command is one-shot. How it runs on the capture machine is the owner's
decision:

- run it by hand after a capture session; or
- run it on a user timer next to the existing `dev.xtap-sync.timer`. Create the
  timer only after the owner asks for it.

## Tests and gates

1. Unit: a sealed batch keeps its path and UUID across a failed download and a
   retry; the queue drops the batch only after the download completes.
2. Unit: the uploader rejects an invalid line and uploads the rest; a forced
   failure after the upload and before the delete gives the same segment key on
   retry and no second object.
3. Unit: the uploader ignores a `contributed_by` value in the file.
4. Integration: the command writes one segment to a scratch Bucket, and the raw
   reader and the observation store read it back.
5. Live canary: one batch from the capture browser lands in
   `osolmaz/xtap-pool-data`, and the next enrichment Job run includes it.

## Out of scope

- Unpausing the Space.
- Changes to X capture, the Infinite Feed Scroller, or enrichment.
- Moving data out of the extension queue that is already stuck. The new handoff
  drains it after the cutover.
