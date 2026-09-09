---
title: Consumer deployment and coverage deadline
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-08
tags: [consumer, deployment, verification]
---

# Consumer deployment and coverage deadline

The reviewed consumer source at `a56d5b0` was deployed to the existing Space as `ce0aad213f8bcd7fe48a4a9302046e147044adec` on September 8. Index `8cb6974753cd765c288e6fa2c551e3b9db028c346f8045c21d7038557fa5129f` was uploaded, downloaded, checksum-checked, and verified before replacing the pointer. Its 4,891,852,800-byte database preserves the prior index references and all raw records. The source revision is `5dc867c4665bf2360a95a24bca320dadba03fae68b11a528e878a29a152898b1`.

The existing Our Models account now has `observations:read` in addition to its previous scopes. Keys and credential stores are unchanged. Space-side enrichment remains disabled. The canonical enrichment schedule was restored and Job `6a9fd0bd259f8e97255ee9e2` was triggered under its unchanged $10 inference and 2,700-second limits.

## Live checks

Readiness passed after the index and metadata restored. A bounded single-author selection returned 135 posts in three pages. Its history request returned 71 observations for 17 posts with repeated observations; eight of the 25 requested posts had no history in that window. A subsequent unchanged-source request returned zero changes and 598 bytes. The history request took 1.559 seconds and the unchanged request took 3.656 seconds. This is observed source history, not proof that the browser has loaded extension 0.26.0.

The first full-selection Our Models recovery Job, `6a9fcfede686246ca69aa5bf`, then failed after three `503 deadline_exceeded` responses. No full-selection context was published. The failure occurred before source-page completion or model calls. Our Models scheduling remains suspended for repair; the website keeps its verified published database. The independent xTap enrichment Job is not affected by the consumer request deadline.

## Completion boundary query

The completion query repeated the same selected queue twice: once to find the earliest unfinished work, then again to find completed work before it. The replacement materializes that selection once in a single SQL statement. It retains the strict time boundary and handles every unfinished state, empty selections, and all-completed selections. It does not increase HTTP timeouts, change the classifier contract, or require another index migration.

On the same verified local database, the old completion calculation took 7.322 seconds and the replacement took 3.669 seconds, 3.653 seconds less. The returned boundary was identical: September 7 at 22:52:28.518 UTC. Observation coverage remained identical and took 3.264 and 3.212 seconds respectively. These are single local measurements, not statistical or cloud performance claims. The release gate remains successful full-selection requests and real worker recovery on the deployed CPU hardware, with the existing 30-second request deadline unchanged.

Local tests assert one prepared selection statement and check pending, running, retrying, and blocked work, including completed work at the same time as the unfinished boundary. Full validation and live recovery results must be recorded before claiming the consumer is ready for full catch-up.

## Follow-up query and recovery checks

The first completion optimization was not sufficient on the live CPU. A full-selection metadata page took 22.861 seconds, and a later attempt exceeded the unchanged 30-second deadline. The follow-up materializes distinct unit IDs before correlated eligibility checks, then reads each selected post's newest permitted observation through the existing post/time index. It still searches older observations when newer samples are outside the pinned source. No database migration or timeout change is required.

On the same local database, completion took 1.766 seconds and observation coverage took 2.684 seconds. Both clocks matched the previous implementation exactly. These remain local single-run measurements; deployed first-page and content-page checks are required. Tests cover a pinned source with nine later observations, restricted post IDs, an empty selection, and indexed source membership checks.

Activation history reads now use the existing bounded batch helper with concurrency eight. Every immutable plan and activation is still validated, and predecessor checks remain in generation order. Tests require every plan read, a maximum of eight simultaneous reads, unchanged read-only behavior, and rejection of a missing historical plan.

The first enrichment Job failed because the initial deployment did not include the required revision handoff. Canonical stage preparation corrected that deployment error. The subsequent read-only Job `6a9fdb2b8e5f7b7fd14cb6d7` found that the active bootstrap plan still referenced the index from before the consumer deployment. It stopped before inference or output writes. Recovery must preserve the prior plan and checkpoint, verify whether any outputs exist, and prepare a successor from the verified current index. Both schedules remain suspended only for this active recovery.

## Classifier work copy size

Preparing a successor exposed another migration defect before activation: the compact classifier database still contained all consumer observation and change-history tables. Its 2,953,281,536-byte file exceeded Node's 2 GiB `readFile` limit. No successor was activated and no inference call was made.

The worker compaction now excludes those eight consumer-only tables from its disposable copy. Publication still restores the verified full base index and applies worker outputs there; the public history and raw source are not removed. A regression test requires the public source file to remain byte-identical and preserves queue and registry work.

On the verified prepared source, the work file falls to 60,850,176 bytes. The source database SHA-256 remains `5cf69cd60e424d83da3ac2e4b6d4161ca154a1873b392abdd56d361e15859eb8`; all 308,130 queue positions, 306,936 completed positions, and 29,629 registry positions remain represented. Full local checks pass with 771 tests, 88.12% configured coverage, and zero Slophammer DRY candidates. The corrected candidate still requires activation and cloud recovery verification.

## Prepare source metadata before consumer requests

The corrected worker copy was activated as generation 87, run `xtap-b0e01d0c7828c30def3948bcb4251e68`. Its read-only cloud restore passed. The following production retry failed with `fetch failed` after 243 seconds, before any provider calls or output changes. Its checkpoint remains at sequence one. The same run can resume; its plan and prior source files remain intact.

Full-selection HTTP reads still exceeded the 30-second deadline after the SQL changes. A read-only cloud check on cpu-basic measured coverage at 8.220 seconds and privacy at 0.287 seconds against the published index. A separate local check of immutable source preparation uploaded and verified 16,260,675 bytes in 17.187 seconds. These are different executions, not an end-to-end latency measurement. They identify full snapshot preparation as additional work in the first HTTP request.

Source bases are now prepared during verified index startup and the existing background refresh, before storage readiness is restored. Consumer requests only describe an already prepared base and its bounded additions. A missing or oversized base returns `503 source_not_ready` without uploading a snapshot. The existing background refresh prepares the next base; it does not require another API, store, schema version, or longer HTTP deadline. Ingest requests do not perform this preparation.

Regression tests require no snapshot writes from cold, bounded, or oversized descriptions; explicit preparation and rollover; restart recovery; and unchanged immutable-file and checksum validation. Deployment must still prove full-selection metadata and content pages within the existing deadline before Our Models recovery Jobs resume.

## Verified source-read deployment

Source `35f8318026a3ad56868fd0fc57a42142a50bef3b` from PR 52 is deployed as Space revision `1b4196c0439563b00647610af118bb4d5a245513`. Local checks passed with 771 tests, 88.14% configured coverage, and zero DRY candidates. Pi Reviewer reported no findings and CI passed.

The canonical revision handoff preserved active generation 87 and its sequence-one checkpoint. Read-only cloud Job `6a9ffc91b012ba1d5b8f2bc6` verified the handoff in 157.010 seconds. Restore Job `6a9ffdf48e5f7b7fd14cbca7` completed in 149.624 seconds with zero provider calls, zero orphan segments, and unchanged run objects and public index pointer.

At 12:28 UTC, three full-selection metadata requests returned HTTP 200 in 13.899, 20.001, and 13.689 seconds. Their first content pages returned 112 changes each in 4.051, 5.215, and 5.049 seconds. All six requests stayed below the existing 30-second deadline. These tests used source `4b090d0a65daa4806ba97a5af15e97a00c716f8d5471503cd01602b6e7596711`; they prove bounded initial reads, not full backlog publication.

Canonical schedule `6a9ffde3b012ba1d5b8f2bea` is active on the unchanged six-hour schedule and $10 inference/2,700-second bounds. Catch-up Job `6a9ffef6b012ba1d5b8f2c08` started at 12:26:40 UTC. Our Models cloud recovery Job `6a9fff9eb012ba1d5b8f2c1b` then completed in 82.331 seconds. A separate-directory restore recovered its two committed source pages, 112 pending source records, and all 1,117,337 cache entries without a provider call. The second physical recovery Job, `6aa000b9b012ba1d5b8f2c3e`, failed after two `503` responses and a `429 consumer_busy`; the first Job's saved pages remain intact.

The live Space logs explain this failure: new mixed enrichment segments started full `configuration-refresh` scans at 12:34 UTC. Those scans held the same lock used by consumer reads. They continued while xTap made valid progress: its checkpoint reached sequence 41 and queue completion rose from 306,936 to 307,164. The reader must inspect only new segments for actual configuration writes, rather than treating every mixed segment as a configuration change, before retrying the Our Models recovery check.

## Limit configuration refresh to real writes

The configuration-change check now loads only newly verified config or mixed segments and examines their operations. Append-only enrichment, attempt, and registry batches do not start a full configuration refresh. Real configuration writes still take the existing validated reload path. Missing or corrupt new segments fail the check instead of being treated as unchanged.

At 12:46 UTC, the raw log had 138 new mixed segments since 12:30. The first three and last three were checksum-verified and inspected; all six contained append operations only. This matches the failure in the live refresh logs. Regression tests cover append-only mixed batches, genuine dedicated and mixed configuration writes, late-arriving files, unchanged old files, irrelevant tweet files, and failed segment verification.

## Final recovery and resumed schedules

The configuration-tail fix passed 776 tests, 88.15% configured coverage, zero DRY candidates, review with no findings, and CI. Source `cfd46b156aeec2c30225e63f9873c295fb247731` is deployed as Space revision `2b422fa8b081389ab28f930053b3257e8564eee2`.

The earlier catch-up completed all 1,194 pending entries in 202 provider calls, at a receipt cost of $2.0000476. All 308,130 queue positions and 29,629 registry positions were complete. Public index `8ec8e961756db809db65897a1129a7af00e7442ba626c8c699a47b25837ddc6e` was published, and checkpoint sequence 237 retained the outputs. The physical Job exceeded its configured 2,700-second timeout and was canceled. Hugging Face omitted its terminal timestamp; the observed cancellation bounds CPU cost conservatively at $0.025. This is not an invoice. The unused inference reservation was released.

Canonical cloud handoff Job `6aa00b2c32d5d0c22c5ad683` passed. Its result was reused after checking the current activation, immutable plan, and exact checkpoint pointer hashes; replaying all checkpoint history again locally was unnecessary. The new image's read-only restore Job `6aa00e0b32d5d0c22c5ad6c9` recovered sequence 237, all completed work, and 232 claimed segments with zero orphan segments and zero provider calls.

Three full-selection metadata requests then passed in 17.192, 17.950, and 14.115 seconds. Their content pages took 10.278, 4.472, and 11.999 seconds. All stayed below 30 seconds. The verified source was complete through September 8 at 10:14:55 UTC. This source boundary is distinct from the live Our Models publication boundary.

Our Models recovery Job `6aa00f6632d5d0c22c5ad716` completed in 78.315 seconds. A separate-directory restore proved progression from source sequence 2 to 4 and from 112 to 302 source records, preserving the first page and all 1,117,337 cache entries with zero provider calls. The failed intermediate attempt remains recorded.

Both schedules are active again. xTap schedule `6aa00dfa900620b5c77e22ed` started continuation Job `6aa00f2432d5d0c22c5ad70d`; Our Models schedule `6a9fcc6ae686246ca69aa578` started catch-up Job `6aa01065900620b5c77e2385`. The latter retains the approved $180 cumulative inference limit under the $200 task approval. Counted settled cost before these active attempts is $3.7983566, including provider receipts and conservative CPU estimates. Their active reservations are not money spent. Our Models backlog completion has not yet been established.

The first continuation attempt, `6aa00f2432d5d0c22c5ad70d`, ended with `fatal: terminated` after 547.208 seconds. The active generation and checkpoint 237 were unchanged, with all work still complete and no successor activated. No AI work was repeated. Its $0.005 conservative CPU estimate was settled and its unused inference reservation released. The same validated schedule started retry `6aa0124d900620b5c77e23da`. Settled counted cost is now $3.8033566, excluding the active attempts. Our Models catch-up remains active and its observed source requests return HTTP 200 on their first attempt.

## Saved continuation and browser delivery

Job `6aa0124d900620b5c77e23da` reached its physical timeout at September 8 14:38:53 UTC. It had processed 84 additional entries through 14 provider calls for $0.1255376. Its conservative CPU estimate is $0.025 for 2,984.928 seconds. The unused inference and CPU reservations were released. Counted settled cost is $3.9538942, excluding the active Our Models receipt.

The Job advanced to generation 89 and saved the initial checkpoint for `xtap-27c86045f33978c91c9279a0c193b425`. Outer and inner checkpoint hashes verified. All 308,214 queue entries were already complete; 11 registry entries and publication remained. The new run had no output segments or initial progress record. Worker code must publish that record before provider calls, so the preceding Job's final receipt accounts for its inference work. Resume Job `6aa02f9932d5d0c22c5adc0a` uses the existing schedule and checkpoint, with a $10 inference maximum and $0.03 CPU reservation. Those limits are not money spent.

Chrome's registered service worker now reports xTap 0.26.0. After an unsuccessful logged-out test, the operator restored the login and a normal scraper retry recorded 242 observations across 237 posts, including 138 observations of previously known posts. This proves browser collection, not yet delivery of those particular observations through the history API to Our Models.

## Changed-source request deadline

A read-only production request from the Our Models saved idle cursor failed after the client deadline. A second diagnostic request, limited to one change, returned `503 deadline_exceeded` after 31.323 seconds. The Space health check remained successful. The initial full download had completed; this failure concerns the subsequent change-read path.

Source pinning computes coverage before page construction. When taxonomy and approvals were unchanged, the first request also read changed bodies under that same 30-second deadline. The fix returns a privacy-checked boundary-only page after pinning a changed source, using the existing `metadata_sent` cursor marker. Unchanged metadata is not resent. The next request reads bodies against the saved source. An unchanged source still completes in one empty response. No response schema, deadline, compatibility reader, or new state store is added.

Coverage candidate selection now collects distinct changed post IDs before checking selected unit membership. On the existing local September 8 database, a 1,000-segment window returned the same first 100 post IDs in all three comparisons. Baseline times were 2,778, 2,788, and 2,778 ms; candidate times were 980, 981, and 981 ms. The absolute reduction was 1,798–1,807 ms. These are local ARM64 query measurements, not cloud endpoint latency or proof of production recovery. Live change reads must still complete within the existing deadline after deployment.

Regression tests cover boundary-only responses, restart and fixed-source behavior, unchanged-source completion, privacy changes between pages, and deduplicated candidate selection through the existing indexes.

## September 9 verification

At 02:17 UTC, the Space health check passed with storage ready. A change request from the actual Our Models saved cursor still returned `503 deadline_exceeded` after 31.568 seconds, before returning any page. PR #54 is therefore insufficient to establish bounded live change reads. Do not treat its deployment or recovery checks as end-to-end success. Further diagnosis must measure source preparation and coverage separately on the current source before another repair is accepted.

Both earlier catch-up Jobs completed: xTap `6aa03fdb900620b5c77e2ee1` at September 8 17:46 UTC, and Our Models `6aa01065900620b5c77e2385` at 18:38 UTC. Our Models continued automatically under the same logical run. Checkpoint 8949, written September 9 at 02:16 UTC, reports 4,582 calls and $19.5950914 in cumulative inference cost, with one $0.051519 call reservation. Story output remains unset. Physical Job completion did not mean backlog publication.

The live Our Models digest still reports artifact `4e0c744c880378c27391eb2d2bda65c32b9338e7e1a6454beb3439dc5930db9f`, generated September 8 at 06:46 UTC and complete through September 7 at 23:05:38.154 UTC. No current pending count or defensible completion ETA was established. No new paid Job or source reset was launched during this verification.

## September 9 request repair

Two read-only cpu-basic Jobs checked verified published database `2cae942abe77a575584fbdb709093324269b878c1bbca6a96e70e9b5e6b6444c`. Direct coverage took 8.611 seconds; the actual forked reader took 9.022 seconds. Saved-context loading took about 1.65 seconds. A separate local context-pin check took 6.555 seconds, including a 4.369-second metadata write and its read-back. A live history request completed, but full-selection and one-author bootstrap requests still hit the 30-second deadline. These checks do not identify a single proven cause on the live Space.

Deadline errors now name the current request stage, without adding a metrics API or exposing request data, so a remaining production failure identifies the operation rather than inviting another speculative query rewrite. An attempted unchanged-context reuse was rejected because it prevented the rolling history window from advancing. Existing context and history behavior remains unchanged.

Selection predicates now check author membership before public-content eligibility. Three local comparisons returned identical clocks and took 7.490, 7.421, and 7.488 seconds before the change, versus 6.546, 6.577, and 6.687 seconds after it. The absolute reduction was 0.801–0.944 seconds on 307,594 current units. A separate indexed-candidate approach needed 115,472 IDs but gave only a small additional benefit; it was dropped in favor of the simpler predicate order. A 64 MiB SQLite cache was also slower in all three comparisons and was not adopted. None of these local measurements establishes live request success; the saved-cursor production check remains mandatory.

## Changed-source deployment

PR [#54](https://github.com/osolmaz/xtap-pool/pull/54) passed `npm run check`, SimpleDoc, Pi Reviewer with no findings, and CI run `34251140734`. It merged as `853d3da38cef549f506a65453e452597bb36e763`. The existing Space received that source as `92c4e167b482e979a21ad30aba4938625301e664` at 16:57 UTC. Live change-read verification remains pending while the Space restores its index; the first probe received a database-not-restored response, not a change-read deadline result.

The preceding Job `6aa02f9932d5d0c22c5adc0a` completed generation 89 and published verified index `31760d111d4790d90a3390c71d44467bda469b5efa630a1fa2dc6554525c037a`. It then processed 378 entries in generation 90 through 64 provider calls. Its final receipts report $0.698001 in inference; estimated CPU cost is $0.021. Unused reservations were released. Counted settled cost reached $4.6728952, excluding the active Our Models run.

Read-only handoff Job `6aa03b0b32d5d0c22c5adde5` and new-image restore Job `6aa03ee732d5d0c22c5ade3f` both completed. Each added an estimated $0.0015 in CPU cost and zero provider calls. The restore verified checkpoint 73, 308,510 of 308,861 completed queue entries, all 29,717 registry entries, 72 claimed output segments, and zero orphan segments. It preserved run `xtap-8ad4b8908b14c51d353a14f08b4a9c8d`; no plan was reset.

Canonical schedule `6aa03eb132d5d0c22c5ade37` is active after maintenance. Catch-up Job `6aa03fdb900620b5c77e2ee1` resumed that saved work with the unchanged $10 inference cap and 2,700-second physical limit. Settled cost before that Job is $4.6758952. Its maximum exposure is $10.0225, separate from the active Our Models cumulative $180 inference cap. All remain within the approved $200 task limit. Our Models Job `6aa01065900620b5c77e2385` remains active; these xTap results do not establish that its backlog is published.

## September 9 live recovery

PR [#55](https://github.com/osolmaz/xtap-pool/pull/55) passed the full check, final review with no findings, and CI run `34309536404`. Source `8ea1007bc4f562addb9a8c176d123aa8af58160a` was deployed as Space revision `158529d2eabfa6a746e9801bded6334646f00e22`. The change reports the stage of a request deadline and preserves selection semantics while reducing SQL work. It does not raise the deadline or change history-window behavior.

Handoff Job `6aa0dcd4900620b5c77e516c` and new-image restore Job `6aa0de5332d5d0c22c5af3d0` passed without provider calls. The restore retained generation 94, checkpoint 131, 309,369 of 309,749 queue entries, all 29,788 registry entries, and 130 claimed segments with zero orphans. Canonical schedule `6aa0de4632d5d0c22c5af3ce` is active again. No extra manual enrichment Job was launched during this deployment.

After the Space restored its index, the actual saved Our Models cursor returned three successful change pages in 17.414, 12.411, and 4.979 seconds. Another 60 consecutive pages passed in 2.709–11.076 seconds each, returning 29 changed entries and 1,110 observations. The response source was complete through September 8 at 22:06:11.884 UTC. More pages remained at the bounded test limit; this does not establish that the whole backlog was read or published. These results establish live success after deployment, not that predicate ordering alone caused the recovery.

The responses contain repeat observations for 271 posts. For example, post `2097336073663684798` had 16 views and no replies at September 8 15:42:47.316 UTC, then 29 views and one reply at 22:33:35.137 UTC. This verifies delivery of real counter history, rather than only a history endpoint returning an empty response. The read-only checks made no provider calls and changed no remote source or consumer state.

The restore Job used 169.656 seconds. Its conservative CPU estimate is $0.0015; the unused $0.021 hold was released. The earlier timed-out Job's unresolved provider exposure remains counted in the task budget. Our Models publication is a separate gate and is not claimed complete here.
