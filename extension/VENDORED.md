# Vendored xTap

This directory vendors the xTap Chrome extension.

- Upstream: https://github.com/mkubicek/xTap
- Vendored at commit: `9eba39a3c972649f07df98c3874cac6de38b383f` (`v0.24.0`)
- Local extension version: `0.25.0`
- License: MIT (see `LICENSE`, unchanged)

Keep upstream code style (vanilla JS, MV3, no bundler) so future re-syncs
stay cheap diffs. Re-syncing is a deliberate manual step: diff upstream against
this directory, excluding the modifications below.

## Local modifications

- `manifest.json` — renamed to `xtap-pool`; added `debugger` and
  `unlimitedStorage` permissions, the `https://*.hf.space/*` host permission,
  and the `pool-connect.js` content script.
- Firefox manifests, build scripts, page-interception tests, and browser E2E
  harness are omitted. Firefox does not implement Chrome's extension debugger
  API, and this fork does not fall back to page-owned fetch/XHR interception.
- `lib/pool-sync.js` — **new**: persistent sync queue + batched flush to the
  pool Space's `/api/ingest` with backoff.
- `pool-connect.js` — **new**: content script for the Space's `/connect` page;
  hands the pool token to the service worker (no copy-paste).
- `background.js` — imports `lib/pool-sync.js`; new captures also feed the pool
  queue; new `POOL_*` message handlers; a `chrome.alarms` periodic pool flush;
  `initPoolSync()` during startup. Upstream's durable staging, coupled
  dedup/buffer persistence, image backfill, bounded splitting, startup flush,
  and HTTP-only transport remain in place around the pool path.
- `popup.html` / `popup.js` — added the "Pool sync" section (status, connect,
  sync-now, pause) and an Options link.
- `options.html` / `options.js` — **new**: configure the pool Space URL and
  paste a token manually (fallback for the automatic handoff).
- `tests/pool-sync.test.mjs` — **new**: node --test coverage for the queue,
  flush, backoff and connect flows.
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
  addition to X's array-of-pairs shape (+ regression test).
- `.github/workflows/release.yml` — packages the pool settings, connection,
  reload, and cutover pages; omits unsupported Firefox artifacts.
- Removed upstream `AGENTS.md` / `CLAUDE.md` (superseded by the repo root's).
