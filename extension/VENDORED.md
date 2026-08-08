# Vendored xTap

This directory vendors the xTap Chrome extension.

- Upstream: https://github.com/mkubicek/xTap
- Vendored at commit: `61c1cb483fff90a9aa48588621a9f8ee03bddf1f`
- License: MIT (see `LICENSE`, unchanged)

Keep upstream code style (vanilla JS, MV3, no bundler) so future re-syncs
stay cheap diffs. Re-syncing is a deliberate manual step: diff upstream against
this directory, excluding the modifications below.

## Local modifications

- `manifest.json` — renamed to `xtap-pool`, version bumped to `0.20.1`; added `alarms` and
  `unlimitedStorage` permissions, `https://*.hf.space/*` host permission and
  the `pool-connect.js` content script.
- `lib/pool-sync.js` — **new**: persistent sync queue + batched flush to the
  pool Space's `/api/ingest` with backoff.
- `pool-connect.js` — **new**: content script for the Space's `/connect` page;
  hands the pool token to the service worker (no copy-paste).
- `background.js` — imports `lib/pool-sync.js`; `enqueueTweets()` also feeds
  the pool queue; new `POOL_*` message handlers; `chrome.alarms` periodic
  flush; `initPoolSync()` during startup.
- `popup.html` / `popup.js` — added the "Pool sync" section (status, connect,
  sync-now, pause) and an Options link.
- `options.html` / `options.js` — **new**: configure the pool Space URL and
  paste a token manually (fallback for the automatic handoff).
- `native-host/xtap_daemon.py` — `/status` validates a supplied bearer token
  (401 on mismatch) so the extension detects rotated daemon secrets;
  `background.js` `probeHttp()` sends the cached token accordingly.
- `tests/pool-sync.test.mjs` — **new**: node --test coverage for the queue,
  flush, backoff and connect flows.
- `lib/scrape-receipts.js` and `lib/scrape-bridge.js` — **new**: durable
  IndexedDB receipts for X list observations plus a cursor-based external port
  used by the allowlisted Infinite Feed Scroller extension.
- `reload.html` and `reload.js` — **new**: extension-owned deployment page that
  reloads the unpacked extension through `chrome.runtime.reload()`.
- `tests/scrape-receipts.test.mjs` — **new**: receipt persistence, per-list
  coverage, replay, active-run and sender-allowlist coverage.
- `background.js` records list-timeline receipts before capture deduplication,
  passes the sender tab ID to the receipt bridge, and forwards observations only
  to the matching tab-bound run. Up to two receipt runs may be active.
- `background.js` flush — rebuffers batches on explicit host rejection or
  when no transport accepted the message (native fire-and-forget posts still
  count as delivered), and persists the local buffer across MV3 service-worker
  suspensions.
- `lib/tweet-parser.js` — accepts object-shaped Draft.js `entityMap`s in
  addition to X's array-of-pairs shape (+ regression test).
- `native-host/xtap_core.py` — all text file handles opened with
  `encoding="utf-8"` so emoji/CJK tweets save on non-UTF-8 locales.
- Removed upstream `AGENTS.md` / `CLAUDE.md` (superseded by the repo root's).
