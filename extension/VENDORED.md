# Vendored xTap

This directory vendors the xTap Chrome extension.

- Upstream: https://github.com/osolmaz/xTap
- Vendored at commit: `61c1cb483fff90a9aa48588621a9f8ee03bddf1f`
- License: MIT (see `LICENSE`, unchanged)

Keep upstream code style (vanilla JS, MV3, no bundler) so future re-syncs
stay cheap diffs. Re-syncing is a deliberate manual step: diff upstream against
this directory, excluding the modifications below.

## Local modifications

- `manifest.json` — renamed to `xtap-pool`, version bump; added `alarms` and
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
- `background.js` flush — rebuffers batches on explicit host rejection or
  when no transport accepted the message (native fire-and-forget posts still
  count as delivered), and persists the local buffer across MV3 service-worker
  suspensions.
- `lib/tweet-parser.js` — accepts object-shaped Draft.js `entityMap`s in
  addition to X's array-of-pairs shape (+ regression test).
- `native-host/xtap_core.py` — all text file handles opened with
  `encoding="utf-8"` so emoji/CJK tweets save on non-UTF-8 locales.
- Removed upstream `AGENTS.md` / `CLAUDE.md` (superseded by the repo root's).
