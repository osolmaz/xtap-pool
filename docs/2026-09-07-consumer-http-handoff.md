---
title: Incremental consumer HTTP contract
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-07
tags: [consumer-api, implementation]
---

# Incremental consumer HTTP contract

This is the HTTP handoff for the [incremental consumer plan](2026-09-07-incremental-consumer-and-engagement-history-plan.md). The source schemas are `space/src/consumer-http-contract.ts`, `consumer-page.ts`, `consumer-observations.ts`, and `consumer-query.ts`. Runtime and route code are `consumer-runtime.ts` and `consumer-routes.ts`. This replaces the version-1 machine contract in place. Deployment and the Our Models cutover remain operator gates.

## Requests and grants

| Operation                 | Request                                                                                 | Service-account scopes                             |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Start bootstrap           | `/api/units?author_ids=123,456&labels=ai&label_mode=any&publication=public-original`    | `units:read`, `taxonomy:read`                      |
| Continue bootstrap        | `/api/units?cursor=<cursor>`                                                            | Same                                               |
| Start or continue changes | `/api/changes?after=<cursor>`                                                           | `units:read`, `taxonomy:read`, `observations:read` |
| Start history             | `/api/observations?at=<fully-consumed-cursor>&post_ids=123,456&since=<UTC>&until=<UTC>` | `units:read`, `observations:read`                  |
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

**Privacy removal procedure:** `409 privacy_changed` carries `recovery.action=discard_selection`, the exact normalized `selection`, `discard=["units","observations"]`, and `next=explicit_bootstrap`. Remove that selection's saved units and observations from staged and published consumer state before starting a new bootstrap. Remove dependent published bodies as part of the same recovery. Do not retain the earlier unfinished cursor or wait for a replacement body. This is a body-free removal of the entire accepted selection, including items accepted on earlier pages. It is an explicit privacy reset, not an automatic full-read fallback for ordinary errors. Current privacy also gates all old-source upserts and observations.

## Remaining live gates

Local checks passed: `npm run check` ran 712 Vitest tests in 75 files, 189 extension tests, and 180 native extension tests. Coverage was 87.01% lines/statements, 85.73% branches, and 91.40% functions. The duplicate-code check reported zero candidates. The parent must implement and test the Our Models transaction, removal, history, and cursor rules against these schemas. An operator must verify purpose-scoped grants, deployed projection readiness, raw-base retention, current source containment after restore, production unit sizes and deadlines, and the approved history window. The coordinated deployment, live restart/privacy canary, performance measurements, and website publication proof remain pending. No production completion is claimed.

## Parent integration

This branch changes no classifier model, prompt, or semantic contract. It does not change `index-bootstrap.ts`, `index-command.ts`, command entry points, or the setup wizard. In `durable-index.ts`, it adds only the optional fetch adapter to `createDurableIndexBucketClient`; in `bucket-log.ts`, it adds that adapter to the existing raw Bucket clients. Keep those options and their read/write/list propagation when merging the parent's resumable CPU bootstrap and tail verification work. Preserve the parent's `compareSegmentKeys` export. No HTTP path publishes `index/current.json`.

The requested documentation command is `npx --no-install @simpledoc/simpledoc check`. In this local npm installation, that form returned exit 127 (`@simpledoc/simpledoc: not found`). The same scoped checker, version 0.1.6, passed with `npx --no-install --package=@simpledoc/simpledoc simpledoc check`. No untracked generated `index.html` was present. The unscoped npm package is unrelated.
