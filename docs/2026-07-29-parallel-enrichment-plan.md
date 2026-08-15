---
title: Parallel enrichment plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-07-29
---

# Parallel enrichment plan

## Status

Implemented. The worker supports up to 32 provider calls in one physical Job, and production has completed 32-way runs with durable receipts. This update makes 32 the persistent setup default. The Hugging Face schedule remains physically non-concurrent so one coordinator owns queue selection, cost limits, registry order, Bucket commits, and receipts.

The normal six-hour schedule uses a $10 run limit. That limit covers the $8 reservation bound for one full 32-call wave. A backlog repair may temporarily use a $100 run limit and a 5.5-hour worker limit under an explicit cumulative budget. The normal limits return after the backlog clears, while concurrency stays at 32.

## Current performance

The worker groups six conversation-author units into each call to `zai-org/GLM-5.2:fireworks-ai`. Forty-five production receipts with concurrency 32 completed 111,079 units in 52.42 worker-hours for $179.171605. The aggregate rate was 2,119 durable units per hour at $1.61 per thousand units.

The August 15 backlog contains 48,495 pending units. The aggregate history projects about 23 worker-hours and $78 of inference. The observed rate varies widely with provider errors and input mix, so the operating range is 15 to 40 worker-hours with a $100 expected repair ceiling. Each useful result and attempt event is durable before a worker exits.

## Decision

The implementation will support a configurable maximum from 1 through 32 concurrent inference calls. Production will target 32 immediately, as approved, unless provider errors require a reduction.

Each request keeps the existing six-unit prompt contract. Sixteen requests place at most 96 units in inference at once. Thirty-two requests place at most 192 units in inference at once.

The primary metric is durable completed units per wall-clock hour. Moving from sequential execution must produce at least twice the baseline goodput to justify the additional coordinator logic. Cost per durable completed unit may rise by no more than 5 percent. Provider failures, invalid output, evidence rejection, and dataset commit failures remain veto gates.

Under ideal provider behavior, 16 concurrent calls would process the current queue in under two hours. A practical estimate is one to three hours after Hub commit delays and provider backoff. This estimate is provisional until the production-parity canary measures it.

## Process boundary

Parallel Hugging Face Jobs are outside this design. Every Job currently rebuilds a private SQLite projection and obtains leases from that local database. Separate Jobs cannot see one another's leases. They can select the same units, pay for duplicate calls, and race while replacing shared JSONL shards.

One physical Job will retain the following responsibilities:

- rebuild the dataset snapshot and claim one fair bounded queue.
- admit inference calls under every shared run ceiling.
- serialize durable writes and registry revisions.
- release unprocessed leases before exit.
- publish one strict receipt tied to its Hugging Face `JOB_ID`.

The scheduled Job keeps `concurrency: false`, `attempts: 1`, and its revision-pinned image. GitHub Actions remains CI-only.

## Request coordinator

`runEnrichTick` will replace the sequential call loop with a coordinator that has separate inference and commit lanes.

The inference lane may have several HTTP requests in flight. Each dispatch gets a monotonically increasing sequence number and an immutable reservation containing:

- the exact unit IDs and input hashes.
- the serialized prompt digest and prompt byte count.
- the completion-token limit.
- the maximum charge permitted for the call.
- the dispatch time and current processor contract hash.

The coordinator records the reservation before sending the request. Missing usage, missing pricing, a timeout after dispatch, or an orphaned request is charged conservatively against the reservation. There are no hidden HTTP retries. A later unit retry is another durable attempt and needs a new reservation.

The commit lane receives completed calls through a bounded queue. It commits them in dispatch order so free-label registry revisions and attempt events remain stable. One call can finish while an earlier call is still running, but its result cannot update SQLite or release its reservation until every earlier sequence has reached a durable terminal event.

Dataset writes remain serialized through `DatasetMirror.commitBatch`. The dataset commit must succeed before the local queue marks any unit complete. A failed commit writes the existing durable failure form and leaves the affected units eligible for replay under the current policy.

## Admission control

A concurrency maximum caps active calls. The worker repeatedly claims one bounded wave and starts it immediately, subject to the shared cost and runtime ceilings. It does not stop after an arbitrary unit count or aggregate token count.

Provider pressure reduces later waves quickly:

- a rate limit, timeout, or provider 5xx response halves the active limit, rounded down to at least one.
- a reduced limit remains in force for the rest of that Job.
- reaching the run error ceiling closes admissions immediately.
- admitted calls finish and produce durable success or failure events before the worker exits.

A full 32-call wave can reserve at most $8 under the current $0.25 per-call bound. Provider errors reduce the next wave before further requests are admitted.

The coordinator checks capacity before every dispatch. It includes all active reservations when evaluating the run ceilings. With the current `$0.25` per-call bound, 16 active calls reserve $4 and 32 active calls reserve $8. The worker cannot admit a call that would exceed the remaining cost capacity.

Elapsed time stops new admissions. It does not abandon in-flight calls or skip their durable accounting. A platform timeout remains an emergency limit and must leave enough time for the request timeout, ordered commit queue, receipt write, and lease release.

## Configuration

Add `ENRICH_MAX_CONCURRENT_CALLS` as a strict positive integer in the following locations:

- `space/src/config.ts` for worker configuration.
- `space/src/enrich-command.ts` when constructing worker dependencies.
- `setup/src/enrichment-job.ts` for defaults, validation, desired schedule state, and exact schedule matching.
- deployment and doctor output so the effective value is visible before activation.

The setup schedule template defaults to `32`. Setup stores this value as a Space variable, and doctor includes it in the exact schedule contract. Deployments and schedule repair therefore keep 32 unless an operator deliberately chooses a lower safe value. The generic worker parser keeps its fail-safe default of 1 when no deployment setting exists.

The normal run limit is $10 because a full wave reserves at most $8. Backlog repair uses temporary $100 and 5.5-hour limits. The replacement schedule is always created suspended, checked with the bounded recovery canary, and enabled only after the canary passes. Canary commands whose hard ceiling is $5 or more must include `--approved-cost-ceiling-usd` with the operator's approved cumulative limit.

Values above 32 fail configuration validation. A 32-call run also requires at least $8 of available reservation capacity under the current per-call bound. The configured run ceiling must cover in-flight reservations plus final commit and receipt work.

Extend the strict enrichment receipt in `shared/src/enrichment.ts` with:

```json
{
  "configured_concurrency": 16,
  "peak_concurrency": 16,
  "provider_backoffs": 2,
  "reservation_peak_usd": 4,
  "commit_queue_peak": 11
}
```

These fields are required for the new processor revision. Earlier receipts remain historical and do not satisfy current worker-heartbeat checks after the contract change.

## Correctness rules

Parallel execution must preserve every current contract:

1. The classifier still returns exactly `preset_labels` and `free_labels`.
2. Every accepted assignment still cites an exact retained member-tweet quote.
3. The semantic input hash and reservation bind the prompt content. They also bind its candidates and serialized bytes.
4. Dataset rows, attempt events, registry events, and receipts become visible only after verified Hub commits.
5. Queue status and leases remain a rebuildable projection of durable records.
6. Every registry state stays outside model output, including candidate and approved or rejected states.
7. Every current run ceiling includes all in-flight work.
8. A changed contract invalidates stale projections and requeues affected units.
9. Unprocessed claims are released at every normal or exceptional exit.
10. Replay produces the same completed set without duplicate current rows or missing attempts.

A deterministic defect in prompt construction, parsing, evidence validation, registry sequencing, or dataset commits closes admissions for the whole Job. Provider-specific transient errors use the bounded reduction and retry policy described above.

## Tests

Unit tests will use deferred fake inference promises so completion order can differ from dispatch order. They must prove that durable order, registry revisions, and receipt totals remain deterministic.

Coverage must include:

- concurrency values from 1 through 32 plus invalid zero and over-cap values.
- peak in-flight requests never exceeding the configured or dynamically reduced limit.
- exact prompt and cost reservations before dispatch.
- conservative charging when usage or pricing is absent.
- token and cost ceilings counting every active reservation.
- out-of-order model responses committed in dispatch order.
- one slow request applying bounded backpressure to the commit queue.
- timeout, 429, provider 5xx, malformed output, and missing-unit responses.
- no further admission after the error, elapsed-time, cost, token, or discard ceiling.
- all admitted calls producing durable terminal events before exit.
- commit failure leaving SQLite incomplete and replay recovering correctly.
- registry events keeping unique consecutive revisions.
- receipt replay rejecting malformed or wrong-contract concurrency fields.
- schedule repair treating a concurrency-setting mismatch as a replacement.
- production schedules remaining non-concurrent with zero platform retries.

The repository quality gate remains `npm run check`. Coverage, mutation testing, setup tests, Space tests, and the two-Job recovery canary must pass for the new processor revision.

## Throughput canary

The canary uses the production model with six units per call. It keeps the current taxonomy and prompt contract while sampling representative old and recent units. It records every request because aggregate Job duration alone is insufficient.

Run a bounded production-parity validation at concurrency 32. The worker records peak concurrency, reservations, ordered commits, and provider backoffs in its receipt. Any timeout, rate limit, or provider 5xx halves subsequent waves.

The autonomous canary keeps its cumulative hard ceiling below $5. It publishes durable results and attempt events after each completed call, then proves replay from the Hub snapshot. The production run does not start from an unverified local checkpoint.

Continuing at 32 requires all of the following evidence:

- at least 2 times the baseline durable units per hour.
- cost per durable completed unit within 5 percent of baseline.
- no duplicate current rows, registry revision gaps, missing attempt events, or receipt disagreement.
- provider error rate below the configured ceiling and no meaningful increase over baseline.
- successful crash recovery with in-flight calls and an occupied commit queue.
- exact read-back of every cache object and each shard, receipt or registry object used by the verifier.

If the bounded run has provider failures or violates a ceiling, the replacement schedule is reduced to the highest stable setting before another paid run.

## Deployment

Implementation and deployment follow this order:

1. Add coordinator tests and the new strict receipt fields.
2. Implement bounded inference admission and ordered commits with the persistent default set to 32.
3. Run the full repository checks and review the change against `main`.
4. Deploy the exact Space revision without changing the active schedule.
5. Replace the schedule in suspended state at concurrency 32 and run the bounded recovery canary.
6. Inspect every measured cost and error. Check request latency, commit latency, replay behavior and current API projections.
7. Trigger the approved production run and verify its receipt before enabling cron.
8. Resume the single exact schedule and continue publishing completed cutoffs while backfill drains.

Rollback creates a suspended replacement schedule at the highest measured stable concurrency under the same source revision, or deploys the previous reviewed revision. It never overlaps physical Jobs, deletes durable enrichment records, or rewrites historical receipts.

## External limits

Hugging Face does not publish one fixed concurrency limit for routed Fireworks requests. Fireworks documents a 600 requests-per-minute serverless account rate together with adaptive token limits and overload responses. At the measured 19 to 42 second latency, 16 active calls imply roughly 23 to 51 requests per minute. That leaves substantial request-rate headroom, while token limits and model capacity still require measurement.

References:

- [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/en/index)
- [Hugging Face Fireworks provider](https://huggingface.co/docs/inference-providers/en/providers/fireworks-ai)
- [Fireworks serverless rate limits](https://docs.fireworks.ai/serverless/rate-limits)
- [Fireworks inference error codes](https://docs.fireworks.ai/guides/inference-error-codes)
