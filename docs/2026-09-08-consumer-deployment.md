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

## Browser delivery

The server can now return the saved history. Repeat-observation delivery also requires the updated unpacked extension, version 0.26.0, to be loaded in the browsing Chrome instance. That browser installation has not been verified from this machine. The source folder is `extension/`; reload it through Chrome's extension page if it still runs the earlier version.
