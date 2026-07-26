# Labels and Concepts Implementation Plan

## Purpose

The pool becomes the enrichment layer for its own capture stream. Every
pooled post gets classified once — preset labels from a curated
taxonomy, free labels the model adds, and blog-style concepts with
aliases — and everything is queryable through the pool API. The
explorer gains a concept graph (`/graph`, `/graph/<slug>`) and inline
concept links inside post text. Consumers such as local-frontier stop
scanning raw files and instead query, e.g., new `ai`-labeled posts
since a watermark; raw unlabeled data never needs to be copied out of
the pool again.

## Enrichment model

- **Preset labels**: `config/labels.json` in the pool dataset — an
  array of `{name, description}`; the description steers the model.
  Initial taxonomy: `ai`, `local-models`, `inference-performance`,
  `quantization`, `ai-hardware`, `agents`, `ai-research`, `ai-tooling`.
  A `taxonomy_version` integer marks rows for re-classification when
  the taxonomy changes materially.
- **Free labels**: up to 5 model-chosen lowercase-dash slugs per unit
  (`dgx-spark`, `kimi-k3`). Recurring free labels are promotion
  candidates into the preset taxonomy.
- **Concepts**: solmaz.io-style — `{name, aliases[]}` per concept,
  3–8 per unit, names as short Wikipedia-title noun phrases, aliases
  restricted to surface forms present in the text. One global
  vocabulary, merged by slugified name, aliases unioned.
- **Unit of classification**: the conversation-author unit — a root
  post plus the same author's captured self-replies in that
  conversation. When a new post arrives in an already-classified unit,
  the unit is re-enqueued and its enrichment replaced.

## Architecture

```text
extension ── POST /api/ingest ──▶ Space (Hono)
                                    ├─ raw JSONL ──▶ dataset (system of record)
                                    ├─ enqueue unit ─▶ enrich_queue (SQLite)
                                    └─ serves /api/tweets, /api/labels,
                                       /api/concepts, /api/graph
              in-Space enrich worker (interval loop + post-ingest kick)
                    │ drains queue in batches
                    │ GLM 5.2 via Inference Providers router (HF_TOKEN)
                    ├─ enrichment JSONL shards ──▶ dataset
                    └─ labels/concepts/edges rows ─▶ SQLite index
```

- **Dataset is truth, SQLite is cache.** Enrichment rows append to
  `enrichment/YYYY/MM/enrichment-YYYY-MM-DD.jsonl` in the pool dataset
  (`{unit_id, tweet_ids, labels, free_labels, concepts, model,
taxonomy_version, enriched_at}`), and the concept vocabulary lives at
  `enrichment/vocabulary.json`. The Space rebuilds all enrichment
  tables from those files on boot, exactly like it does for tweets.
- **Worker placement**: inside the Space as a background loop (the
  Space is already always-on and the code lives with it), with a
  token-gated `POST /api/enrich/run` for manual drains. Batches are
  small (~20 units per model call, bounded per tick) so API latency is
  unaffected; if load ever changes, a scheduled Job can drive the same
  endpoint without redesign.
- **LLM**: one call per unit batch to the router
  (`https://router.huggingface.co/v1/chat/completions`), model from
  `LLM_MODEL` (default `zai-org/GLM-5.2`), JSON response contract:
  `{units: {<unit_id>: {labels[], free_labels[], concepts[{name,
aliases[]}]}}}`. Units with no matching preset labels still get
  their row (empty labels) so they are never re-enqueued.
- **Vocabulary retrieval, not full-vocabulary prompts**: each prompt
  carries only vocabulary entries lexically overlapping the batch text
  (token match on names and aliases, capped ~150), keeping prompts
  bounded as the vocabulary grows. A later gardener pass (out of scope
  here) merges near-duplicate concepts.
- **Idempotency**: work is keyed `(unit_id, taxonomy_version)`; the
  queue is a table with status, attempts, and last_error; replays are
  upserts. Run receipts (`units, calls, tokens, failures`) go to
  `enrichment/receipts/` in the dataset.

## Query API (v1 additions)

- `GET /api/tweets` gains `labels=<csv>` (`label_mode=any|all`),
  `free_label=<slug>`, `concept=<slug>`, and `unlabeled=true`;
  composes with all existing filters and pagination.
- `GET /api/labels` — preset taxonomy with counts, top free labels,
  queue depth and enrichment coverage.
- `GET /api/concepts` — vocabulary with doc counts;
  `GET /api/concepts/<slug>` — one concept with aliases, related
  concepts (shared-unit counts), and post count.
- `GET /api/graph?label=<preset>&top=<n>` — bounded co-occurrence
  subgraph (nodes + weighted edges) from the materialized edges table.
- Performance groundwork in the same change: `q` moves from `LIKE` to
  FTS5; concept edges are materialized incrementally on write, never
  computed per request.

## Explorer

- Filter bar gains preset-label chips and a concept picker, wired to
  the new query params.
- `/graph`: canvas force-graph of the concept vocabulary (ported from
  the local-frontier/solmaz.io implementation), colored by community,
  bounded to the top concepts; plus a text index list.
- `/graph/<slug>`: concept page — name, aliases, related-concept
  chips, and the posts referencing it.
- Post text rendering runs the first-mention concept linker (ported;
  skips anchors/code, alias word boundaries, case-sensitive short
  acronyms) so detected concepts link to their `/graph/<slug>` page.

## Rollout

1. Schema + queue + enrichment worker + API, behind
   `ENRICH_ENABLED` (default off until validated).
2. Explorer graph pages and inline links (render only when enrichment
   data exists).
3. Bounded live validation against the real pool (~small batch cap,
   under $5 of router inference), then enable the worker and run the
   full backfill after its measured cost is approved
   (~26k units ≈ 1.3k GLM calls).
4. Later, separately: local-frontier's pipeline becomes a consumer of
   `/api/tweets?labels=ai,local-models`, and its own gate/extractor
   are deleted.

## Non-goals here

- No changes to local-frontier (follow-up).
- No gardener/merge pass yet; vocabulary hygiene is manual until the
  vocabulary size warrants it.
- No public exposure: enrichment stays behind the existing pool auth.
