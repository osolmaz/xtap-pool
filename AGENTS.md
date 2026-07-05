# Agents

Monorepo: `shared/` (tweet schema), `space/` (HF Docker Space backend, Hono),
`explorer/` (Vite + React + shadcn UI), `extension/` (vendored xTap fork,
vanilla JS — keep upstream style, record changes in `extension/VENDORED.md`).

- Run `npm run check` before finishing.
- Do not introduce `any` in TypeScript source files.
- Keep domain logic out of HTTP route handlers; put it in `space/src/` modules.
- The HF dataset repo is the system of record; the Space must never hold
  unpersisted data after an ingest request returns success.
- Contributor identity comes from verified auth only; never trust
  client-supplied attribution fields.
- Add a regression test for every bug fix.
- Use Conventional Commits.
