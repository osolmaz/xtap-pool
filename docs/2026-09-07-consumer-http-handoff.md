---
title: Incremental consumer HTTP contract
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-07
tags: [consumer-api, implementation]
---

# Incremental consumer HTTP contract

This is the HTTP handoff for the [incremental consumer plan](2026-09-07-incremental-consumer-and-engagement-history-plan.md). The source schemas are `space/src/consumer-http-contract.ts`, `consumer-page.ts`, `consumer-observations.ts`, `consumer-privacy.ts`, and `consumer-query.ts`. Runtime and route code are `consumer-runtime.ts` and `consumer-routes.ts`. This replaces the version-1 machine contract in place. Deployment and the Our Models cutover remain operator gates.

## Requests and grants

| Operation                 | Request                                                                                 | Service-account scopes                             |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Start bootstrap           | `/api/units?author_ids=123,456&labels=ai&label_mode=any&publication=public-original`    | `units:read`, `taxonomy:read`                      |
| Continue bootstrap        | `/api/units?cursor=<cursor>`                                                            | Same                                               |
| Start or continue changes | `/api/changes?after=<cursor>`                                                           | `units:read`, `taxonomy:read`, `observations:read` |
| Start history             | `/api/observations?at=<fully-consumed-cursor>&post_ids=123,456&since=<UTC>&until=<UTC>` | `units:read`, `observations:read`                  |
| Reconcile privacy         | `/api/reconcile?cursor=<recovery-cursor>`                                               | `units:read`                                       |
| Continue history          | `/api/observations?cursor=<next_cursor>`                                                | Same                                               |

Every request checks current authorization. An authorized member session also permits these reads. Existing credentials gain no scopes. An operator must issue an explicit grant for `observations:read`. Default grants stay unchanged. Explorer whole-unit browsing uses `/api/explorer/units` and requires a member session; it is not a machine recovery route. The explorer's separate `/api/tweets` route is unchanged.

The selection is fixed: sorted, unique exact `author_ids`, sorted unique `labels` (default empty), `label_mode` (`any` by default, or `all`), optional `free_label`, and required `publication=public-original`. Repeated or unsupported query options fail. Continuations may repeat matching selection fields; conflicting fields fail. Names are case-sensitive. History continuation binds source, IDs, range, and selection; optional repeated fields must agree. History IDs are distinct and sorted. Times must be UTC with `Z`; they normalize to millisecond precision.

## Change envelope

All bootstrap and change responses have exactly these fields:

```json
{
  "schema_version": 1,
  "source": "<full raw snapshot SHA-256>",
  "complete_through": null,
  "observations_through": null,
  "history_since": "<inclusive UTC>",
  "history_until": "<exclusive UTC>",
  "cursor": "<signed next cursor>",
  "has_more": true,
  "changes": []
}
```

The two coverage timestamps are null or UTC. Observation freshness does not promise complete observation coverage. The source identifies the exact raw object set, including late arrivals.

Changes are the existing `metadata`, `unit_upsert`, `unit_remove`, and `observation` variants in `consumer-page.ts`. Bootstrap starts with a metadata-only page, even for an empty selection. Continue that page to receive upserts or the empty final page. The signed `metadata_sent` field prevents repeats at `limit=1`. Changes emit metadata only when the frozen taxonomy or approved registry state differs. Registry counters and coverage movement alone do not cause metadata changes.

Empty pages can have `has_more=true`. Continue until false. The final cursor is an idle cursor for the fully consumed target. Commit each page and cursor together. Do not poll changes or start history with an unfinished bootstrap cursor. Bootstrap does not deliver observations; use the final cursor for initial bounded history. Activation and fresh change phases can deliver the same logical observation. Deduplicate by observation `id`.

## History envelope

History has `schema_version: 1`, `source`, `history_since`, `history_until`, `observations`, `coverage`, `has_more`, and nullable `next_cursor`. Its bounds are the requested inclusive/exclusive range, checked against the source's advertised range. Each coverage item has `post_id`, `state` (`available`, `no_history`, or `unavailable`), `count`, `earliest`, and `latest`. Unavailable counts and times are null. Coverage describes the complete requested range, not only the current page. Pages sort by `(post_id, observed_at, id)`.

A final history page has `has_more=false` and `next_cursor=null`. A history cursor cannot become a global or idle cursor. Keep the original fully consumed source cursor separately.

## Limits and recovery

Default page limit is 200; maximum is 500. History permits at most 100 IDs and 30 days. The target response size is 2 MiB; the hard serialized limit is 8 MiB. A complete oversized item fails without an acknowledgment cursor. Page sequences last at most 48 hours; sources last at most 30 days from context creation. The earlier deadline applies when a history or change sequence uses an older source. Context cleanup waits 32 days. Raw snapshot bases and raw segments are retained; old full databases are not needed.

The entire read has a 30-second wall deadline, including source/context I/O and mutex wait. SQLite runs in at most two persistent read-only child processes. Deadline cancellation kills a running child, including native SQLite. Requests do not copy or rebuild the database. The database must contain every exact pinned source descriptor and the current verified source boundary.

Errors use `{"error":{"code":"...","message":"...","recovery":{}}}`. The recovery field is present only when needed. No error includes an acknowledgment cursor.

| HTTP status | Meaning and action                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| 400         | Invalid, conflicting, unsupported, or wrong-kind query/cursor. Correct the request.                                       |
| 401         | Missing, invalid, expired, or revoked authentication.                                                                     |
| 403         | Valid service credential lacks an explicit required scope.                                                                |
| 409         | `privacy_changed`: apply the removal procedure below. `contract_changed`: use an explicit bootstrap for the new contract. |
| 410         | Cursor/context expired or history outside its retained range. Use explicit bootstrap or operator history recovery.        |
| 413         | A complete source item or final serialized response exceeds its bound. Do not advance.                                    |
| 429         | Consumer capacity is full. Retry the same cursor after five seconds.                                                      |
| 502         | Source/context read or verification failed. Retry the same cursor; persistent failures need operator repair.              |
| 503         | Source projection unavailable, database replaced, worker failed, or deadline exceeded. Retry the same cursor.             |

## Privacy reconciliation

A withdrawal after an earlier accepted page stops that sequence with HTTP 409:

```json
{
  "error": {
    "code": "privacy_changed",
    "message": "Apply the affected removals before resuming this page.",
    "recovery": {
      "action": "reconcile",
      "path": "/api/reconcile",
      "cursor": "<signed removal cursor; no acknowledgment>"
    }
  }
}
```

Call `/api/reconcile?cursor=<recovery.cursor>&limit=200`. Every successful page has exactly:

```json
{
  "schema_version": 1,
  "source": "<full raw snapshot SHA-256 for this removal range>",
  "removals": [
    { "type": "post_remove", "post_id": "123", "reason": "not_available" },
    { "type": "unit_remove", "unit_id": "123:author", "post_id": "123", "reason": "not_available" }
  ],
  "has_more": true,
  "next_cursor": "<signed next removal cursor>",
  "resume_cursor": null,
  "resume_path": null
}
```

The final page has `has_more=false`, `next_cursor=null`, a signed `resume_cursor`, and `resume_path` equal to `/api/units`, `/api/changes`, or `/api/observations`. Use `cursor=<resume_cursor>` for units/history, or `after=<resume_cursor>` for changes. The resume cursor retains the original source comparison, selection, history bounds, and page position. It also records the applied privacy checkpoint. It does not restart bootstrap. A history resume cursor remains a history cursor.

Apply these rules in the Our Models client:

1. Keep the unfinished content/history cursor and unrelated accepted and published content. Stop that sequence and follow the removal cursor. Do not treat the 409 cursor or the response `source` as applied progress.
2. For `post_remove`, remove that post's saved body, observations, and dependent published stories. Use the maintained post-to-unit index to remove accepted units that contain the post. For `unit_remove`, remove the named saved unit **only if it still contains `post_id`**. That condition protects a later version which reuses an old unit ID without the withdrawn post. Remove orphaned bodies and observations when their last permitted unit reference is removed. Keep public content which still has a separate unaffected unit reference.
3. Save each complete removal page and its next cursor in one transaction. Publish affected removals through the existing publication writer before marking that privacy checkpoint published. A failed transaction retries the same cursor. Both removal variants are idempotent. Never clear the entire selection.
4. Follow `next_cursor` while `has_more=true`, including empty pages. Only after the final page's removals are applied may the client save and use `resume_cursor`. Do not feed a pending removal cursor to a content/history route or use it as a history `at` cursor.
5. Keep the last completed `resume_cursor` as the selection's privacy receipt, in addition to the normal global source cursor. When starting a separate changes poll, send `/api/changes?after=<fully-consumed-global-cursor>&reconciled=<privacy-receipt>`. A separate initial history read can also send `reconciled=<privacy-receipt>`. This transfers only the applied privacy checkpoint; it never turns a history cursor into a global cursor. The receipt must be signed, completed, unexpired, and for the same selection. `reconciled` is rejected on continuations. A resumed sequence already carries its checkpoint.
6. Continue the original sequence, then poll changes normally. The engine re-emits affected restored units even when their content hash equals the old public hash. It also recovers their permitted retained observations. The next fully consumed source which contains the privacy checkpoint clears that pending repair state. Once all active streams carry that checkpoint or a later source, the client can stop sending the separate receipt.

Removal records sort by `(post_id, unit_id)`, with the direct post removal first. They come from restricted source events after the last applied privacy checkpoint (or the pinned target), and exact historical post/unit dependencies in the original base and target. A restriction event remains in its fixed range even if the post becomes public again during recovery. Historical dependencies are qualified by `post_id`; they are not unconditional deletion of every past unit ID. The query returns IDs only and does not reconstruct historical bodies. Repeated restriction events can produce idempotent removals in later ranges.

If new source writes arrive during removal paging, the server finishes the fixed range and returns a next cursor for another pinned range. New withdrawals which sort before a previous page position are included in that new range. No cursor acknowledges a range before all its removal records have been returned. Replay and restart preserve the range and position. New withdrawals after the final recovery page cause another 409 on resume. Current privacy checks continue to suppress all forbidden old-source bodies and observations.

The normal page limits and wall deadline apply. Signed cursors are limited to 8 KiB, including 100 long history IDs and the removal position. Recovery keeps the original 48-hour page lease and uses immutable metadata in the existing context store. Expiry is explicit; it does not silently clear content or start a full read.

## Remaining live gates

Local checks passed: `npm run check` ran 723 Vitest tests in 76 files, 189 extension tests, and 180 native extension tests. This includes 13 paged privacy recovery tests. Coverage was 87.13% lines/statements, 85.79% branches, and 91.39% functions. The duplicate-code check reported zero candidates. The parent must implement and test the Our Models transaction, removal, history, and cursor rules against these schemas. An operator must verify purpose-scoped grants, deployed projection readiness, raw-base retention, current source containment after restore, production unit sizes and deadlines, and the approved history window. The coordinated deployment, live restart/privacy canary, performance measurements, and website publication proof remain pending. No production completion is claimed.

## Parent integration

This branch changes no classifier model, prompt, or semantic contract. It does not change `index-bootstrap.ts`, `index-command.ts`, command entry points, or the setup wizard. In `durable-index.ts`, it adds only the optional fetch adapter to `createDurableIndexBucketClient`; in `bucket-log.ts`, it adds that adapter to the existing raw Bucket clients. Keep those options and their read/write/list propagation when merging the parent's resumable CPU bootstrap and tail verification work. Preserve the parent's `compareSegmentKeys` export. No HTTP path publishes `index/current.json`. The bounded engine in `space/src/consumer-changes.ts` now accepts an optional applied privacy context to repair same-hash restoration. Preserve that argument, the cursor privacy fields in `consumer-cursor.ts`, and worker source-containment checks when combining later core changes. No source-effect table or classifier contract changed.

The requested documentation command is `npx --no-install @simpledoc/simpledoc check`. In this local npm installation, that form returned exit 127 (`@simpledoc/simpledoc: not found`). The same scoped checker, version 0.1.6, passed with `npx --no-install --package=@simpledoc/simpledoc simpledoc check`. No untracked generated `index.html` was present. The unscoped npm package is unrelated.
