# Labels and Free Labels Implementation Plan

## Status

Planned. This replaces the current three-output enrichment contract. The classifier will produce only preset labels and free labels. The durable worker, retries, completion hashes, and freshness API are specified in [Durable Enrichment Implementation Plan](durable-enrichment-implementation-plan.md).

## Purpose

xtap-pool classifies each conversation-author unit with two kinds of labels:

- Preset labels come from the configured taxonomy.
- Free labels describe specific subjects that the preset taxonomy does not cover.

Both may be empty. Every assignment carries evidence from the source unit. The model does not generate concepts, entities, candidates, or any other classification output.

The system keeps discovering free labels without publishing one-off mistakes as navigation categories. New free labels accumulate evidence in a private registry before they can appear in public filters or the graph.

## Classification contract

The model returns exactly two arrays per unit:

```json
{
  "units": {
    "conversation-id:author": {
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
      ]
    }
  }
}
```

A label assignment contains a normalized name and one or more evidence records. Each evidence record identifies a member tweet and quotes text from it. Evidence is metadata on a label assignment; it is not another kind of label.

The response rules are:

- `preset_labels` may contain only exact names from `config/labels.json`.
- `free_labels` contains at most five lowercase-dash names.
- Either array may be empty. Thin replies, emoji-only posts, and units without a substantive subject should normally return no free labels.
- Every quote must be a verbatim substring of the named tweet. Code checks membership and the quote before accepting the assignment.
- A free label must name a specific subject supported by its evidence. Grammatical features, discourse forms, pronoun categories, generic nouns, and unsupported abstractions are invalid.
- Free labels that match a rejected registry entry are discarded.
- One invalid assignment does not invalidate valid assignments in the same unit. The worker records every discarded assignment and its reason.

The prompt, output schema, normalization rules, rejection registry, preset taxonomy, and configured model participate in `contract_hash`.

## Free-label lifecycle

Preset labels are approved by configuration. Free labels use three internal lifecycle states:

- `candidate` means the label has valid unit evidence but has not earned public use.
- `approved` means the label may appear in consumer responses and their filters, counts, or graph.
- `rejected` means the label cannot be assigned or rediscovered under the current registry revision.

Registry state stays outside the classifier response. The model still returns only preset labels and free labels.

A new valid free label enters the registry as `candidate`. Candidate assignments remain durable and visible to administrators, but consumer APIs omit them. The registry stores append-only discovery and lifecycle events. SQLite projects the current state and evidence counts from enrichment rows and registry events.

Rejected labels that overlap the current batch are included in the prompt as negative examples. This prevents mistakes from feeding themselves back into later calls. Normalization also rejects known generic abstractions and unsupported suffix patterns. A rejected label can return only through an explicit registry event under a new registry revision.

## Promotion and rejection

Promotion requires independent evidence from more than one model response.

A free label backed by a verified exact Hugging Face model or dataset repository may be approved from one unit. Other surface-grounded names must appear in at least five units from three authors on two days. Labels whose names are not directly present in their evidence require at least fifteen units from eight authors on two days and a constrained review call over the stored quotes.

The review call decides only whether the supplied candidate is a specific, useful AI or local-model subject. It cannot rename the label or introduce another label. Invalid output leaves the candidate unchanged.

A candidate is rejected when it matches a deterministic rejection rule, fails constrained review, or remains below the evidence threshold for 30 days. Every decision records the rule and counts plus representative quotes. It also records the timestamp and contract revision. Thresholds are configuration covered by tests and included in the registry revision.

Approved recurring free labels are reported as possible additions to the preset taxonomy. Changing the preset taxonomy remains a deliberate configuration change because it redefines broad relevance and triggers a new `contract_hash`.

## Derived graph

The old model-generated `concepts` output and global concept vocabulary are removed. Graph nodes come from approved free labels, and graph edges count their co-occurrence in current units. Candidate and rejected labels never contribute public nodes, counts, edges, filters, or inline links.

The API exposes approved free-label vocabulary and graph data through revision-consistent reads. Display names and aliases, when needed for presentation, belong to registry metadata and never create another classifier output.

## Durable data

An enrichment result stores the two evidence-bearing assignment arrays:

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

The dataset remains the system of record. SQLite is rebuilt from tweets, enrichment rows, attempt events, and free-label registry events. A result is durable before the queue marks its unit complete.

## API and explorer

`GET /api/units` returns evidence-bearing preset and approved free-label assignments. Label filters use assignment names. Candidate free labels are available only through authenticated administration endpoints.

`GET /api/labels` returns preset-label counts, approved free-label counts, queue depth, and enrichment coverage. `GET /api/free-labels/:name` returns one approved free label, its unit count, and related approved labels. `GET /api/graph` returns approved free-label nodes and co-occurrence edges.

The explorer shows preset labels and approved free labels on units. Its graph and detail pages use the approved free-label projection. The Admin UI shows candidate evidence, rejected labels, lifecycle events, and promotion progress.

## Observability

Each worker receipt records:

- emitted preset and free-label assignments;
- assignments discarded for missing evidence, invalid names, or rejection state;
- candidate labels first observed;
- candidates approved or rejected;
- provider calls, token use, elapsed time, and cost.

The worker stops when invalid or ungrounded output crosses its configured rate ceiling. Admin status reports the registry state counts, top candidates with representative quotes, recent decisions, and candidate creation per thousand units.

## Migration

This is a hard replacement of the current enrichment contract.

All earlier model-generated free labels and concepts are discarded during migration. None are grandfathered, promoted, copied into the new assignment arrays, or used to seed candidate records. Old enrichment rows remain in the append-only dataset as historical records, but the replacement reader ignores their label output. The new registry starts without approved or candidate entries inherited from model output. Curated preset labels remain because their source is `config/labels.json`.

Known bad names such as `deixis`, `quality-philosophy`, and unsupported `manufacturing` assignments become rejection rules and regression fixtures. This prevents rediscovery without treating the old assignments as evidence.

The changed schema and prompt plus the normalization rules and registry revision produce a new `contract_hash`. The durable worker reprocesses every source unit under the measured full-run ceiling. Labels enter the new registry only from evidence validated under this contract. Public consumers may publish the completed prefix under the new contract while the worker continues through later units. Each replacement snapshot uses one revision and cutoff.

## Tests

The contract tests cover empty arrays, exact preset-name validation, free-label limits, tweet membership, verbatim evidence, duplicate normalization, and rejected names. Regression fixtures require an emoji-only reply to produce no free labels, a DGX enclosure post to avoid unsupported `manufacturing`, and the word `frontier` to avoid `quality-philosophy`.

Lifecycle tests cover deterministic replay, each legal state transition, threshold boundaries, the verified Hub fast path, constrained-review abstention, stale-candidate rejection, and reopening under a changed registry revision. Migration tests prove that old free labels and concepts do not seed registry entries or assignments. Public API tests prove that legacy, candidate, and rejected labels cannot affect units, counts, filters, graph nodes, or edges.

Recovery tests prove that evidence-bearing rows and registry events survive interruption, replay to the same state, and become visible only after their dataset commits succeed.

## Delivery order

1. Replace the model response and enrichment-row schemas with the two evidence-bearing label arrays.
2. Add validation, empty-output fixtures, and the known-bad regression cases.
3. Add the append-only free-label registry and deterministic replay.
4. Restrict consumer reads and graph materialization to approved free labels.
5. Add promotion, rejection, negative-prompt retrieval, and Admin reporting.
6. Remove model-generated concepts and their vocabulary path.
7. Integrate the new contract with durable hashes and queue recovery, including receipts and freshness reads.
8. Run a no-inference migration report, then the bounded pause-resume canary.
9. Reprocess the backlog under the recorded cost ceiling, publish the current completed cutoff, and let scheduled runs advance it as more work finishes.

## Completion criteria

The work is complete when every current unit is either backed by a durable evidence-bearing result or remains visible in the durable queue, and consumers can read a complete prefix at one revision and cutoff. No legacy model-generated label or concept assignment may contribute to the new registry, consumer reads, counts, filters, or graph. The model must accept empty arrays, and candidate or rejected free labels cannot enter public reads. Registry replay must be deterministic. The old generated-concept path must be absent. All local and production checks, including recovery, must pass.
