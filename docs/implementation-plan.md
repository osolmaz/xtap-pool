# xtap-pool — Implementation Plan

## Problem

A group of friends each run [xTap](https://github.com/mkubicek/xTap) (a Chrome
MV3 extension that passively captures X/Twitter tweets from GraphQL responses
into daily JSONL files). We want to pool everyone's captures in one private,
centralized place where:

- uploading happens through each person's own Hugging Face account,
- every tweet is attributed to whoever captured it,
- the pool is browsable and filterable (by contributor, author, date, text),
- nobody can damage anyone else's data (no shared write access, no force
  pushes),
- and nobody runs or maintains a server.

## Architecture

Three components in this monorepo, one durable store on the HF Hub:

```
┌─────────────────────┐
│ extension/          │  vendored xTap fork ("xtap-pool")
│ captures tweets     │  keeps local JSONL saving (optional daemon),
│ on x.com            │  adds a sync queue → POST /api/ingest
└─────────┬───────────┘
          │ HTTPS, Bearer pool token (per user, signed)
          ▼
┌─────────────────────┐      ┌──────────────────────────────┐
│ space/              │      │ HF dataset repo (private)     │
│ private HF Docker   │─────▶│ data/<user>/YYYY/MM/          │
│ Space (Hono, TS)    │commit│   tweets-YYYY-MM-DD.jsonl     │
│ the ONLY writer     │      │ system of record, git-backed  │
└─────────┬───────────┘      └──────────────────────────────┘
          │ serves
          ▼
┌─────────────────────┐
│ explorer/           │  Vite + React + shadcn/ui
│ browse & filter UI  │  tweet cards styled after solmaz.io
└─────────────────────┘
```

Design invariants:

1. **The dataset repo is the system of record.** The Space is stateless glue:
   everything it holds locally (SQLite index) is a cache rebuilt from the
   dataset snapshot on boot. The Space can be deleted and recreated without
   data loss.
2. **The Space is the only writer.** Friends never get write access to the
   dataset repo; a fine-grained HF token scoped to the one dataset repo lives
   as a Space secret. Force pushes by contributors are structurally
   impossible.
3. **Attribution is enforced server-side.** The contributor identity comes
   from the verified HF OAuth login / signed pool token, never from
   client-supplied fields.
4. **Local capture behavior is unchanged.** The vendored extension saves
   tweets exactly like upstream xTap when the local daemon/native host is
   installed. Pool sync is additive. Friends who don't want local copies can
   skip the daemon entirely and run pool-only.

### Why no Gradio

The explorer is a real TypeScript/shadcn UI, and the ingest API is a plain
HTTP endpoint. Wrapping either in Gradio would add a Python layer whose only
job is to host things we build elsewhere. A **Docker Space** running a single
Node process (Hono) serves the API and the built explorer with less moving
machinery, one language across the repo, and full control over auth/session
behavior. HF OAuth (`hf_oauth: true`) works identically for Docker Spaces.

## Data model

### Dataset repo layout

```
data/<hf-username>/YYYY/MM/tweets-YYYY-MM-DD.jsonl
```

- One JSONL line per captured tweet, in the **exact xTap output format**
  (see upstream README "Output Format"), plus two stamped fields:
  - `contributed_by`: HF username (verified server-side)
  - `pooled_at`: ISO timestamp of ingestion
- Daily file selected by tweet `captured_at` (UTC), matching xtap-sync
  conventions.
- Per-user dedup at ingest: a `(contributed_by, id)` pair is stored at most
  once; re-submissions with newer `captured_at` update the row (fresher
  metrics) — implemented as append + latest-wins on read, with periodic
  compaction as a later optimization (not in MVP).
- Cross-user dedup happens at query time (same tweet captured by several
  friends collapses into one card with contributor chips).

Attribution therefore exists at three levels: file path, `contributed_by`
field, and Space commit messages (`pool: <user> +N tweets (YYYY-MM-DD)`).

### Shared schema

`shared/` package: TypeScript types + [zod] validation for the xTap tweet
object (superset-tolerant: unknown fields pass through untouched so upstream
xTap format evolution doesn't break ingestion; only structurally required
fields are enforced: `id`, `url`, `author.username`, `captured_at`, `text`).
Used by the extension (pre-send sanity check), Space (ingest validation), and
explorer (rendering types).

## Auth & UX — the click budget

Target friend onboarding: **install extension, one OAuth authorize, done.**

1. Friend loads the extension (unpacked from a GitHub release zip).
2. Extension popup shows **"Connect to pool"** → opens the Space's
   `/connect` page.
3. The Space app itself is public (a private Space would gate friends who
   are not repo collaborators before the app even runs) → the app shows
   **"Sign in with Hugging Face"** (one click if already logged into HF).
   Everything beyond the sign-in page is enforced in-app by the allowlist;
   the dataset repo stays private.
4. `/connect` verifies the HF identity against the pool membership config
   (individual users plus allowed HF organizations), mints a **pool token**,
   and renders it in the page DOM.
5. A content script (matching the Space origin only) picks the token up
   automatically and stores it in `chrome.storage.local`. Popup flips to
   "Connected as @user". **No copy-paste, no manual HF token creation.**

Pool token design: stateless signed token (HMAC-SHA256 with a Space secret;
payload = username + expiry + optional OAuth-proven organization IDs). The
Space verifies signatures against current pool membership. Explicit user tokens
last ~180 days; organization-derived tokens are shorter-lived so org removals
take effect without keeping HF access tokens. Revocation = remove the user/org
grant or rotate the signing secret (re-connect is one click). A "paste token
manually" field in extension options is the fallback for browsers where the
content-script handoff fails.

Explorer access: same HF login; session cookie (signed, httpOnly) issued after
OAuth. Friends need **zero** repo permissions — the app-level pool membership
config is the entire access system. Optionally friends can also be given read
access on the dataset repo for `load_dataset`/DuckDB power use; not required for
any flow.

## Components

### `extension/` — vendored xTap fork

- Vendor `mkubicek/xTap` at a pinned commit; record SHA + local modifications
  in `extension/VENDORED.md`. Keep upstream MIT `LICENSE` in place. Diet:
  keep everything (incl. native host + daemon for local saving); rename
  extension to "xtap-pool", new icons deferred.
- Keep upstream code style (vanilla JS, MV3, no bundler) to minimize the
  vendor diff and keep future re-syncs cheap.
- New module `lib/pool-sync.js` wired into `background.js` after the
  existing parse/dedup step:
  - append captured tweets to a persistent **sync queue**
    (`chrome.storage.local`, `unlimitedStorage` permission);
  - flush in batches (≤500 tweets or 20s debounce) via
    `fetch(POOL_URL + '/api/ingest', {Authorization: Bearer <pool token>})`;
  - at-least-once delivery: batch removed from queue only on 2xx; server
    dedup makes retries safe; exponential backoff on failure; queue survives
    service-worker restarts and offline periods.
- Popup additions: connect button, sync status (queued / synced counts,
  last error), pause pool sync independently of capture.
- Options: Space URL (default baked in), manual token fallback.
- Manifest additions: `unlimitedStorage`; host permission + content script
  for the Space origin (token handoff).

### `space/` — HF Docker Space (TypeScript, Hono, Node 22)

Endpoints:

| Route                                  | Auth       | Purpose                                                                                                                   |
| -------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /` + static                       | session    | serves built explorer                                                                                                     |
| `GET /oauth/login` → `/oauth/callback` | —          | HF OIDC code flow, sets session cookie, enforces pool membership                                                          |
| `GET /connect`                         | session    | mints + renders pool token for extension pickup                                                                           |
| `POST /api/ingest`                     | pool token | validate (zod), stamp, dedup, persist                                                                                     |
| `GET /api/tweets`                      | session    | filters: `contributors`, `author`, `q` (FTS), `since`/`until`, `has_media`, `is_article`, `dedup=true`, cursor pagination |
| `GET /api/contributors`                | session    | per-user counts, last sync                                                                                                |
| `GET /healthz`                         | —          | liveness                                                                                                                  |

Storage engine inside the Space: **SQLite** (`better-sqlite3`) on ephemeral
disk + FTS5 for text search. Boot: download dataset snapshot (`@huggingface/hub`)
→ rebuild index (idempotent). Ingest: insert new rows → append to the day's
JSONL → **commit to the dataset repo in the same request** (no local-only
buffering; ephemeral disk must never hold unpersisted data). Commits use
`@huggingface/hub` `commit()` with retry; concurrent ingests serialized
through a single writer queue.

Config via Space secrets/variables: `HF_TOKEN` (fine-grained, read/write on
the one dataset repo), `POOL_SIGNING_SECRET`, `SESSION_SECRET`,
`ALLOWED_USERS` (initial comma-separated HF usernames), `POOL_ADMINS`
(bootstrap admins), `DATASET_REPO`. After bootstrap, durable pool membership
lives in `config/pool.json` in the private dataset repo and is managed from the
Space Admin tab.

README metadata: `sdk: docker`, `hf_oauth: true`, scopes `openid profile`.

### `explorer/` — Vite + React + TS + Tailwind + shadcn/ui

Views:

- **Feed** — infinite scroll over `/api/tweets`; left filter rail:
  contributor checkboxes, author filter, date range, media/article toggles,
  search box; dedup toggle (default on) collapsing cross-user duplicates
  into one card with contributor chips.
- **Tweet detail** — full card incl. quoted tweet, article rendering, link
  out to x.com.
- **Stats** — per-contributor counts, capture timeline (simple bars).

Tweet rendering ported from the solmaz.io blog's X display (author's own
prior art, visually faithful to X):
`~/repos/solmazio/_sass/minima/_x_cards.scss`, `_x_shell.scss`,
`_x_responsive.scss`, and `_includes/tweet.html` / `x_quoted_tweet.html` /
`x_tweet_media.html` — avatar/content grid, identity row, media grid,
quoted-tweet nesting, metrics row; translated to Tailwind + CSS variables,
light/dark via `prefers-color-scheme` + toggle.

### Quality gates — Slophammer

- Root `slophammer.yml` with `typescript` targets (`shared`, `space`,
  `explorer`) per the slophammer TS template: strict `tsconfig`, ESLint,
  Vitest with coverage thresholds, duplication (dry) budget.
- The vendored `extension/` is excluded from slophammer structural rules
  (upstream style preserved) but its parser/sync tests run in CI.
- CI (GitHub Actions): typecheck, lint, tests + coverage for all workspaces,
  explorer + space build, pinned `slophammer` GitHub Action.
- Conventional Commits throughout.

## Delivery phases

Each phase lands as commits on this PR's branch; the PR stays green.

1. **Scaffolding** — pnpm workspaces (`shared`, `space`, `explorer`),
   slophammer config + CI, strict TS/ESLint/Vitest baselines.
2. **Shared schema** — tweet types + zod validators + fixtures drawn from
   real xTap output data (sanitized); unit tests.
3. **Space backend** — OAuth + sessions + allowlist, pool tokens, ingest
   pipeline (validate → stamp → dedup → JSONL append → hub commit), SQLite
   index + query API, boot-time rebuild. Hub layer mocked in tests; real
   round-trip in phase 6.
4. **Explorer** — components, feed/filters/detail/stats, API client; built
   output served by the Space.
5. **Extension vendoring** — vendor xTap at pinned SHA, rename, `pool-sync`
   queue + flush + backoff, connect flow (content-script token handoff),
   popup/options additions; Vitest/node tests for queue and flush logic.
6. **Deploy + E2E** — create private dataset repo + private Docker Space
   under the `dutifuldev` HF org (exists already; friends never need org
   membership — the allowlist governs access), set secrets, import existing
   xTap output under `data/osolmaz/`, live round-trip:
   connect → ingest fixture batch → verify dataset commit → explore in UI.

## Testing

- Unit: schema validation, token sign/verify, dedup, JSONL day-bucketing,
  queue flush/backoff, ingest handler (hub mocked), query filters (SQLite
  in-memory), React component tests for tweet card edge cases (RT, quote,
  article, media grid).
- Integration (local): full Space against a temp dir + mocked hub remote;
  curl ingest with a real signed token; explorer `vite build` served by the
  Space; manual browser pass.
- Live (after deploy): real OAuth + ingest + commit verified on the Hub;
  documented in the PR. Chrome extension manual test on x.com (capture →
  queue → sync → visible in explorer).

**Known non-automatable pieces:** the HF OAuth browser dance and the Chrome
extension's on-x.com capture path need manual verification; everything below
them is covered by tests.

## Risks / notes

- **Space sleep**: free CPU Spaces sleep when idle; first hit wakes in
  ~30–60 s. Extension backoff absorbs this transparently (retry until 2xx).
  Upgrade to always-on hardware later if it annoys anyone.
- **Commit contention**: single-writer queue in the Space serializes hub
  commits; friend-scale volume is far below HF rate limits.
- **Upstream xTap drift**: vendored at a SHA with `VENDORED.md`; re-sync is
  a deliberate manual step. Long-term option: upstream the sync feature into
  xTap and shrink this vendor copy.
- **Token leak blast radius**: a pool token only allows _adding_ tweets as
  that user; dataset write token never leaves the Space; both rotate via
  Space secrets.
- **Ephemeral disk**: no unpersisted state by construction (commit per
  ingest request).
