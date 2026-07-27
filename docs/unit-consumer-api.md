# Unit consumer API

xtap-pool is the semantic source of truth for downstream applications. Consumers read enriched conversation-author units instead of scanning the private dataset or rebuilding labels, threads, free-label vocabulary, and graph edges.

This document describes the target consumer contract in [Labels and Free Labels Implementation Plan](labels-and-free-labels-implementation-plan.md) and [Durable Enrichment Implementation Plan](durable-enrichment-implementation-plan.md). Production keeps serving the previous contract until the replacement reader and worker are complete and the migration recovery canary passes.

## Service accounts

Admins issue service accounts from the explorer's **Admin** tab. A service account has a stable name, explicit read scopes, and one or more rotatable keys:

- `units:read` authorizes `GET /api/units`.
- `taxonomy:read` authorizes `GET /api/labels` and `GET /api/free-labels/:name`. It also authorizes `GET /api/graph`.

The raw credential is shown once. xtap-pool stores only its SHA-256 hash in `config/service-accounts.json` in the private dataset. Keys use 256 bits of random secret material, expire after 365 days, can overlap during rotation, and can be revoked individually. Revoking an account removes every active key. Service credentials never authorize ingest, enrichment runs, membership changes, or administration.

Store the raw credential only in the consumer's secret store and send it as:

```http
Authorization: Bearer xtap_sa_...
```

Creating or copying the credential into another secret store is an explicit operator action. Do not reuse `HF_TOKEN`, `INFERENCE_TOKEN`, or a contributor pool token.

## Enriched units

```http
GET /api/units?author_ids=123,456&labels=ai,local-models&label_mode=any&publication=public-original&limit=200
```

The endpoint accepts contributor and author filters. It also supports text and date filters, media and article filters, and both label kinds. It also accepts `unlabeled` and `limit`. `author_ids` is a comma-separated exact allowlist of immutable X user IDs. It does not fuzzy-match handles. `label_mode` is `any` or `all`; consumers should set it explicitly.

`publication=public-original` excludes an entire unit if any member post is subscriber-only and excludes units containing only retweets. Use this filter for public projections. Apply the same parameter to label and graph reads so label metadata and edge weights come from exactly the publishable unit set.

Each item is one complete conversation-author unit:

```json
{
  "revision": "boot-epoch:revision",
  "units": [
    {
      "id": "conversation-id:author",
      "posts": [],
      "contributors": ["osolmaz"],
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
  ],
  "next_cursor": "opaque"
}
```

Posts are ordered oldest first. Units are ordered by their latest post, newest first. Only units enriched under the active contract are returned. Consumer responses include approved free labels only; candidate and rejected labels remain private to administration reads.

## Consistent pagination

The first page returns a result `revision`. Every cursor embeds that revision. A write that changes served tweets, label assignments, free-label registry state, or graph data advances it. Continuing an older cursor returns HTTP `409`:

```json
{
  "error": "the unit result changed during pagination; restart from the first page",
  "current_revision": "..."
}
```

Discard the partial result and restart from page one. Invalid cursors return `400`.

The label, free-label detail, and graph responses also return `revision`, `contract_hash`, and numeric `free_label_registry_revision`. When supplied, they echo the shared `cutoff`. Pass the unit revision as their `revision` query parameter. Free-label and graph reads accept the same `author_ids=<csv>`, `labels=<csv>`, `label_mode=any|all`, and `publication=public-original` selection. They return only approved free-label data from matching publishable units. A revision mismatch returns `409`, preventing one publication from mixing source states or counting authors outside the selected boundary.

`GET /api/enrichment/status` returns the same revision and contract metadata, the normalized exact `author_ids` selection, queue totals, and `complete_through` when a complete selected window exists. Consumers must use that exact cutoff and revision for every subsequent unit, label, free-label, and graph read.

## Static publication

A static downstream application should:

1. Require `GET /readyz` to be ready.
2. Load and validate the consumer's exact author-ID allowlist.
3. Download every unit page with that `author_ids` selection into a temporary local result.
4. Fetch approved free-label and graph data at the same revision and with the same author IDs.
5. Validate the complete response and reject any unit outside the allowlist.
6. Upload an immutable snapshot.
7. Replace a small current-manifest object only after the snapshot is uploaded and verified.

On any error, leave the previous manifest unchanged. Never expose the service credential to browser code and do not silently fall back to raw dataset scanning.
