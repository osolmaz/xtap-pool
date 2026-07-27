# Unit consumer API

xtap-pool is the semantic source of truth for downstream applications. Consumers read enriched conversation-author units instead of scanning the private dataset or rebuilding labels, threads, concepts, and graph edges.

## Service accounts

Admins issue service accounts from the explorer's **Admin** tab. A service account has a stable name, explicit read scopes, and one or more rotatable keys:

- `units:read` authorizes `GET /api/units`.
- `taxonomy:read` authorizes `GET /api/labels`, `GET /api/concepts`, `GET /api/concepts/:slug`, and `GET /api/graph`.

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

The endpoint accepts the tweet query's contributor, author, author-ID, text, date, media, article, preset-label, free-label, concept, unlabeled, and limit filters. `author_ids` is a comma-separated exact allowlist of immutable X user IDs. It does not fuzzy-match handles. `label_mode` is `any` or `all`; consumers should set it explicitly.

`publication=public-original` excludes an entire unit if any member post is subscriber-only and excludes units containing only retweets. Use this filter for public projections. Apply the same parameter to concept and graph reads so taxonomy names, counts, and edge weights come from exactly the publishable unit set.

Each item is one complete conversation-author unit:

```json
{
  "revision": "boot-epoch:revision",
  "units": [
    {
      "id": "conversation-id:author",
      "posts": [],
      "contributors": ["osolmaz"],
      "preset_labels": ["ai", "local-models"],
      "free_labels": ["gguf"],
      "concepts": [
        {
          "slug": "qwen3-8b",
          "name": "Qwen3 8B",
          "aliases": ["Qwen/Qwen3-8B"]
        }
      ]
    }
  ],
  "next_cursor": "opaque"
}
```

Posts are ordered oldest first. Units are ordered by their latest post, newest first. Only units enriched under the active taxonomy are returned.

## Consistent pagination

The first page returns a result `revision`. Every cursor embeds that revision. A write that changes served tweets, labels, concepts, or graph data advances it. Continuing an older cursor returns HTTP `409`:

```json
{
  "error": "the unit result changed during pagination; restart from the first page",
  "current_revision": "..."
}
```

Discard the partial result and restart from page one. Invalid cursors return `400`.

The labels, concepts, concept detail, and graph responses also return `revision`. Pass the unit revision as their `revision` query parameter. Concept and graph reads accept the same `author_ids=<csv>`, `labels=<csv>`, `label_mode=any|all`, and `publication=public-original` selection. They return only concepts and graph data from matching publishable units. A revision mismatch returns `409`, preventing one publication from mixing source states or counting authors outside the selected boundary.

## Static publication

A static downstream application should:

1. Require `GET /readyz` to be ready.
2. Load and validate the consumer's exact author-ID allowlist.
3. Download every unit page with that `author_ids` selection into a temporary local result.
4. Fetch taxonomy and graph data at the same revision and with the same author IDs.
5. Validate the complete response and reject any unit outside the allowlist.
6. Upload an immutable snapshot.
7. Replace a small current-manifest object only after the snapshot is uploaded and verified.

On any error, leave the previous manifest unchanged. Never expose the service credential to browser code and do not silently fall back to raw dataset scanning.
