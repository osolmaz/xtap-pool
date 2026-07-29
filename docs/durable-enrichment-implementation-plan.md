# Durable Enrichment Implementation Plan

## Status

Implemented. Production schedule activation remains gated on deployment, purpose-scoped Job credentials, the live two-Job recovery canary, and explicit approval for recurring paid work. The existing capture and membership contracts stay in place, along with service accounts and consumer authorization.

## Problem

The dataset contains durable tweets and enrichment results, but the work queue lives only in the Space's SQLite cache. A unit is currently considered complete when a result covers its member tweet IDs under the active taxonomy. The result does not bind the text, links, prompt, output schema, or processor version that produced it.

A failed unit stops after three attempts and stays failed until the Space restarts or its membership changes. The scheduler chooses the oldest queue update, so a large historical backlog can keep recent captures out of downstream feeds. Deployments also interrupt the worker because it runs inside the web process.

The system needs one stronger guarantee: every current unit is either backed by a matching durable result or appears as pending, retrying, or blocked work. No unit may disappear from the backlog.

## Boundaries

xtap-pool remains responsible for conversation-author units, preset labels, free labels, the approved free-label graph, privacy filtering, and revision-consistent consumer reads. The classifier produces only preset labels and free labels, as specified in [Labels and Free Labels Implementation Plan](labels-and-free-labels-implementation-plan.md).

This work does not:

- hardcode Local Frontier accounts or any other consumer selection;
- move model-to-canonical-Hugging-Face association into xtap-pool;
- change capture attribution, contributor authorization, or dataset ownership;
- expose private posts or credentials;
- make SQLite a durable source of truth.

## Completion contract

A boolean `processed` field is not sufficient because unit contents and processor behavior can change.

Every unit gets two deterministic digests:

- `input_hash` covers the ordered semantic input: unit ID, member tweet IDs, text, expanded URLs, reply and quote references, privacy flags, and other fields used by the prompt. Capture metrics that do not affect enrichment stay outside the hash.
- `contract_hash` covers the taxonomy, prompt template, output schema, normalization rules, configured model, and processor implementation version.

An enrichment result is current only when:

1. its `unit_id` matches the unit;
2. its `tweet_ids` cover the current membership;
3. its `input_hash` matches the current semantic input;
4. its `contract_hash` matches the active processor contract;
5. its taxonomy version matches the active taxonomy.

Any mismatch creates pending work automatically. Consumer endpoints continue returning only current completed units.

## Durable records

### Enrichment results

Append-only enrichment rows gain `input_hash` and `contract_hash`. They store exactly two classifier outputs. Both may be empty, and every assignment carries evidence from a member tweet:

```json
{
  "unit_id": "conversation-id:author",
  "tweet_ids": ["123"],
  "input_hash": "<sha256>",
  "contract_hash": "<sha256>",
  "preset_labels": [
    {
      "name": "ai",
      "evidence": [{ "tweet_id": "123", "quote": "frontier AI" }]
    }
  ],
  "free_labels": [
    {
      "name": "open-weight-model",
      "evidence": [{ "tweet_id": "123", "quote": "open-weight frontier model" }]
    }
  ],
  "model": "provider/model",
  "taxonomy_version": 2,
  "enriched_at": "2026-07-27T00:00:00.000Z"
}
```

The worker accepts a preset label only when its name is configured and its evidence is valid. A free label must have a normalized name, valid evidence, and a registry state that permits assignment. New free labels enter the registry as private candidates. Approved labels may appear in consumer reads, while rejected labels are discarded and fed back to the prompt as negative examples.

The dataset commit must succeed before SQLite marks the unit complete. Replaying the dataset reconstructs the same completed set after a crash or replacement deployment.

### Free-label registry events

The dataset also stores append-only discovery and lifecycle events for free labels. Each decision records its rule, supporting counts, representative quotes, timestamp, and registry revision. SQLite rebuilds all registry states from these events and current enrichment rows.

Registry state is operational metadata rather than another classifier output. The model still returns only preset labels and free labels. Candidate and rejected free labels cannot contribute to consumer units, counts, filters, or graph data.

### Attempt events

Batch commits also append compact attempt events containing the unit ID, both hashes, attempt number, outcome, timestamp, retry time, and a bounded error classification. These events preserve retry and blocked state across restarts without storing credentials or provider response bodies.

The SQLite queue remains a projection. It holds the current status, attempts, next retry time, lease owner and expiry, first queued time, latest unit activity time, and bounded last error. It is rebuilt from tweets and durable enrichment records on boot.

## Worker command

Enrichment moves behind a standalone bounded worker command. The API Space may invoke that command during development, but production scheduling must not depend on the web server's lifetime.

One run follows this order:

1. Rebuild or refresh the desired work set.
2. Recover expired leases.
3. Claim a bounded batch with an expiring lease.
4. Build prompts from the claimed input hashes.
5. Call the configured inference provider with a request timeout.
6. Validate and normalize the complete response.
7. Commit results and attempt events to the dataset.
8. Verify the commit, apply it to SQLite, and release the leases.
9. Stop at the configured unit, token, time, error-rate, or cost ceiling.

The first production version uses one worker. More workers require a durable shared lease implementation and a separate cost review.

## Hugging Face deployment and repair

Production execution stays on Hugging Face. The Docker Space serves capture, administration, and read APIs. A non-concurrent scheduled Hugging Face Job runs the standalone worker on `cpu-basic` with an explicit timeout. The private dataset remains the durable source of truth. GitHub Actions is limited to CI and cannot run, schedule, or hold credentials for production enrichment.

The setup doctor and repair command owns the scheduled Job as part of deployment reconciliation. It must:

1. inspect active and scheduled Jobs before changing state;
2. validate the exact Space revision, dataset repository, worker command, model, taxonomy, pricing, ceilings, timeout, and schedule;
3. accept dataset-writer and inference tokens only through hidden interactive input or explicitly named environment inputs;
4. verify dataset read/write access and inference-provider permission before creating a Job;
5. create or replace the schedule with concurrency disabled and the schedule suspended;
6. attach the two purpose-scoped values as encrypted Hugging Face Job secrets without printing or persisting them locally;
7. trigger the two-Job bounded recovery canary through that suspended schedule;
8. verify durable outputs, strict `JOB_ID`-bound receipts, source revision, contract continuity, cost accounting, continuation in a second physical Job, and absence of overlap; and
9. resume the schedule only after every canary check succeeds and recurring paid work is explicitly approved.

Space secrets are scoped to the Space and their values are write-only. Repair cannot recover them by name, silently copy them into a Job, or mint access tokens. When Job secrets are missing or need rotation, the operator supplies the original values or purpose-scoped replacements. If required input is unavailable, capability validation fails, a transient Hub error prevents a trustworthy read, required approval is absent, or an active worker cannot be safely stopped at a durable boundary, repair leaves scheduling suspended and reports the blocker.

Hugging Face Job configuration is immutable for a physical run. Repair suspends the existing schedule and verifies that no matching Job is active before replacing a mismatched schedule. It does not mutate unrelated Jobs. Manual canaries and automatic runs use the same schedule identity and non-concurrency policy.

`doctor --fix` creates or repairs the suspended schedule. `doctor --fix --canary` runs two physical Jobs without resuming cron. `doctor --fix --canary --enable-schedule` presents the schedule and per-run ceiling, then requires explicit approval before recurring execution. The default ceiling is $2 of inference and 400,000 total tokens per physical Job. Including worst-case `cpu-basic` time, the two-Job canary has a cumulative hard ceiling below $4.02.

## Scheduling and retries

Each claim reserves equal bounded capacity for recent and old work:

- newest pending units by latest unit activity;
- oldest pending units by first queued time.

Unused capacity from either side can be filled by the other. This keeps recent feeds moving while guaranteeing that continuous ingest cannot starve historical work.

Transient failures such as timeouts, rate limits, and provider 5xx responses use exponential backoff with jitter. Invalid model output gets a small bounded retry budget. A unit becomes `blocked` after the configured retry policy is exhausted. Blocked units remain visible, are not counted as complete, and receive infrequent bounded retries. A changed input or processor contract resets their retry state.

There is no silent terminal drop. The operational guarantee is that every unit is either current and complete or visible with a reason that prevents completion.

## Freshness and status API

Add a revision-consistent endpoint authorized by `taxonomy:read`:

```http
GET /api/enrichment/status?author_ids=123,456&publication=public-original
```

The response reports:

- total, pending, running, retrying, blocked, and completed units;
- oldest pending and newest completed activity times;
- a `complete_through` timestamp for which every selected unit at or before that time has a current result;
- the current result revision and processor contract hash.

`author_ids` uses the same exact immutable-ID semantics as unit and taxonomy reads. The endpoint cannot filter by enrichment labels because pending units do not have current labels yet.

Unit, label, free-label detail, and graph reads gain a shared activity cutoff so a consumer can request one complete window ending at `complete_through`. The cutoff participates in the revision and must be applied identically to every response. Consumers may publish that completed window while queue totals remain nonzero. Backlog size and cutoff age describe staleness; they do not invalidate the window.

## Existing-result migration

The migration is a hard replacement of the current completion rule.

An existing result can be adopted without another inference call only when all of the following are provable:

- its tweet IDs exactly cover current membership;
- no semantic capture is newer than the result;
- its taxonomy and model match the contract being adopted;
- it contains only preset and free-label assignments;
- every assignment carries evidence that passes the current schema and normalization rules.

All earlier model-generated free labels and concepts are discarded from the active projection. They are never adopted, copied into the new assignment arrays, promoted, or used to seed candidate records. Legacy rows remain only as append-only history and cannot contribute evidence, counts, filters, or graph edges. Curated preset taxonomy entries remain because their source is `config/labels.json`. Every source unit must receive a new evidence-bearing result under the active contract.

The migration appends a current row with both hashes. Every other result is queued for processing. After migration, runtime reads do not accept rows without the new hashes.

Before reprocessing any unverifiable rows, record their count, measured throughput, projected inference cost, the configured full-run ceiling, and the outputs that will be reused. Once the implementation checks and recovery canary pass, the worker continues through all queued units instead of stopping at a pilot-only spending boundary. Consumers can roll out against the current completed cutoff while this background convergence continues.

## Observability and controls

Run receipts record successful units, retries, blocked units, provider calls, tokens, elapsed time, and cost when the provider reports it. They also record emitted assignments, labels discarded for missing evidence or rejected names, new candidates, and registry decisions. The Admin UI shows queue counts, cutoff age, the active contract hash, recent error classes, whether a worker is active, and the candidate, approved, and rejected free-label counts. Queue counts and cutoff age are operational signals rather than publication gates.

The worker stops automatically when:

- the configured cost or runtime ceiling is reached;
- the batch error rate crosses its limit;
- invalid or ungrounded label output crosses its limit;
- the dataset commit or result verification fails;
- the model, method, credential state, contract, or observed cost differs from the recorded full-backlog run.

A deterministic shared defect pauses further claims until the worker code and affected outputs are checked.

## Tests

### State and hashing

- Stable semantic input produces a stable `input_hash`.
- Text, links, privacy flags, or membership changes invalidate completion.
- Metrics-only changes do not trigger semantic reprocessing.
- Taxonomy, prompt, schema, registry revision, model, or processor changes alter `contract_hash`.
- Rows with missing or mismatched hashes are never served as current.
- Empty preset and free-label arrays are valid completed output.
- Preset and free-label evidence must name a member tweet and quote its text.
- `deixis`, unsupported `manufacturing`, and `quality-philosophy` regression fixtures cannot reach public reads.

### Queue and recovery

- New and stale units enter the queue exactly once.
- A successful dataset commit happens before `done` is visible.
- A crash before commit retries the unit.
- A crash after commit but before SQLite apply converges on replay without another model call.
- Expired leases return to pending work.
- Retry timing survives restart.
- Blocked work stays visible and resets only under the stated rules.
- Newest and oldest work both progress under continuous ingest.
- Doctor reports missing, suspended, active, and mismatched Hugging Face Job schedules without exposing secrets.
- Repair creates replacement schedules suspended and enables them only after a successful bounded canary.
- Repair refuses missing credentials, invalid capabilities, transient Hub failures, overlapping workers, and changed paid-run assumptions.

### API and consumer consistency

- Status counts match the selected immutable author IDs.
- Mixed-author and missing-author-ID units fail the selection.
- `complete_through` never passes pending or blocked selected work.
- Unit, label, free-label detail, and graph reads apply the same cutoff and revision.
- A consumer can publish the completed cutoff while selected pending, retrying, or blocked work remains after it.
- Candidate and rejected free labels cannot affect consumer units, counts, filters, nodes, or edges.
- A stale cutoff or revision returns `409` instead of mixed data.

### Live canary

The production canary processes representative old, recent, changed, failing, and multilingual units. It must persist at least two batches, survive an interruption, resume without duplicates, and prove checksums and receipts. When it passes, the same worker resumes and processes the remaining backlog under the recorded full-run ceiling. Consumer publication may start from the current completed cutoff during that work.

## Delivery order

1. Add hash and state-machine tests around the current store.
2. Replace the enrichment schema with evidence-bearing preset and free-label assignments, including valid empty output.
3. Add attempt and free-label registry event schemas plus replay support.
4. Replace completion checks with the two-hash contract.
5. Add leases, retry timing, fair claims, and the bounded worker command.
6. Restrict consumer reads and graph materialization to approved free labels.
7. Add the status endpoint, shared cutoff, registry metrics, and Admin UI reporting.
8. Add doctor and repair reconciliation for a non-concurrent suspended Hugging Face scheduled Job; remove production scheduling and credentials from GitHub Actions.
9. Run the no-inference migration analysis, record the reuse and cost report, and configure the full-run ceiling.
10. Run the bounded recovery canary through the suspended schedule, including the known loose-label regression fixtures.
11. Deploy the new reader and worker together, remove the old queue and generated-concept paths, and resume the schedule only after the canary passes.
12. Publish and verify a consumer snapshot at the current completed cutoff without waiting for the backlog to drain.
13. Monitor queue convergence, cutoff advancement, registry replay, consumer revisions, dataset receipts, cost, Job receipts, and restart recovery in production.

## Completion criteria

The work is complete when every captured unit is either backed by a verified current result or remains visible as pending, retrying, or blocked work, and consumers can publish an internally complete revision and cutoff. No earlier model-generated label or concept assignment may enter the replacement registry or consumer projection. Candidate and rejected labels cannot enter public reads. Registry replay must be deterministic, and restarts or deployments cannot lose work. Recent and historical queues must both advance. The full repository checks and live recovery canary must pass.

If a durable lease, resumable output, defensible per-run ceiling, or consistent consumer cutoff cannot be established, the implementation is not complete. Report that blocker instead of claiming readiness. Once those safeguards pass, scheduled Jobs continue the historical backlog after rollout.
