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
  sync-now, pause).
- `tests/pool-sync.test.mjs` — **new**: node --test coverage for the queue,
  flush, backoff and connect flows.
- Removed upstream `AGENTS.md` / `CLAUDE.md` (superseded by the repo root's).
