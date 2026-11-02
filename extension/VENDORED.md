# Vendored xTap

This directory vendors the xTap Chrome extension.

- Upstream: https://github.com/mkubicek/xTap
- Vendored at commit: `9eba39a3c972649f07df98c3874cac6de38b383f` (`v0.24.0`)
- Local extension version: `0.27.0`. Bump it whenever the worker code changes: Chrome keeps the registered service worker of an unpacked extension across browser restarts until the version changes.
- License: MIT (see `LICENSE`, unchanged)

Keep upstream code style (vanilla JS, MV3, no bundler) so future re-syncs
stay cheap diffs. Re-syncing is a deliberate manual step: diff upstream against
this directory, excluding the modifications below.

## Local modifications

- `manifest.json` — renamed to `xtap-pool`; added `debugger` and
  `unlimitedStorage` permissions.
- Firefox manifests, build scripts, page-interception tests, and browser E2E
  harness are omitted. Firefox does not implement Chrome's extension debugger
  API, and this fork does not fall back to page-owned fetch/XHR interception.
- `lib/pool-sync.js` — **new**: persistent observation queue, sealed into JSONL
  batches and handed to the local daemon's `/pool-outbox` with backoff. Queue
  admission and sampling state are saved together. Storage errors and queue
  overflow leave staged work pending. A sealed batch keeps its name and size until
  the daemon acknowledges it, so a retry sends the same bytes under the same name.
  `npm run push-outbox` uploads the outbox to the raw Bucket.
- `lib/observations.js` — **new**: stable local observation identities, exact
  nullable counters, and five-minute sampling for unchanged content. Later visits
  and immediate content or visibility edits are independent of unique-post export
  deduplication.
- `background.js` — imports `lib/pool-sync.js`; new captures also feed the pool
  queue before unique-post deduplication; new `POOL_*` message handlers; a
  `chrome.alarms` periodic pool flush and staged-response retry;
  `initPoolSync()` during startup. Staging uses local storage and preserves the
  original observation time through a browser restart. Upstream's coupled
  dedup/buffer persistence, image backfill, bounded splitting, startup flush,
  and HTTP-only transport remain in place around the pool path.
- `popup.html` / `popup.js` — added the "Pool sync" section (status, sync-now,
  pause).
- `native-host/xtap_daemon.py` — added `POST /pool-outbox`, which stores one sealed
  pool batch durably in `~/.xtap/pool-outbox` (`XTAP_POOL_OUTBOX_DIR`). A retry
  with the same bytes is a no-op; different bytes under an existing name fail.
- `tests/pool-sync.test.mjs` — **new**: node --test coverage for the queue,
  sealed handoff, retry identity, batch size and pause flows.
- `lib/scrape-receipts.js` and `lib/scrape-bridge.js` — **new**: durable
  IndexedDB receipts for X list observations plus a cursor-based external port
  used by the allowlisted Infinite Feed Scroller extension.
- `reload.html` and `reload.js` — **new**: extension-owned deployment page that
  reloads the unpacked extension through `chrome.runtime.reload()`. The explicit
  `?fail-active=1` cutover option gates new runs, fails active receipt runs,
  and reloads; the new service worker clears the gate before accepting clients.
- `cutover.html` and `cutover.js` — **new**: one-shot fresh-state page with a
  distinct URL so a cached older reload page cannot bypass active-run cleanup.
- `tests/graphql-capture.test.mjs` — **new**: debugger attachment, response-body
  capture, operation extraction, and failed-request coverage. Receipt startup
  retries passive debugger attachment for bounded transient failures.
- `tests/scrape-receipts.test.mjs` — **new**: receipt persistence, per-list
  coverage, search and live-list normalization, replay, typed errors, active-run,
  and sender-allowlist coverage.
- `lib/graphql-capture.js` — **new**: passively reads completed X GraphQL
  responses through Chrome's Debugger Network domain without changing page-owned
  JavaScript or the DOM. The old MAIN-world fetch/XHR patch and isolated bridge
  were removed.
- `background.js` sends debugger-captured list and search responses through one
  parser and receipt path before normal capture deduplication. It stages the
  exact request URL and Chrome tab ID so recovery replays tab-bound receipts
  before clearing the write-ahead record. Observations go only to the matching
  run. Up to four leased receipt runs may be active. Heartbeats, source-tab
  closure, and lease expiry reclaim runs that no longer have a live client.
- `lib/tweet-parser.js` — accepts object-shaped Draft.js `entityMap`s in
  addition to X's array-of-pairs shape (+ regression test). New counter objects
  carry `format: "exact-v1"`; absent, rounded, invalid, and unsafe counters are
  null, while actual zero counts remain zero. Recovery passes the original response
  time to `extractTweets`.
- `.github/workflows/release.yml` — packages the pool settings, connection,
  reload, and cutover pages; omits unsupported Firefox artifacts.
- Removed upstream `AGENTS.md` / `CLAUDE.md` (superseded by the repo root's).
