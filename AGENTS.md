# Agents

Monorepo: `shared/` (tweet schema), `space/` (HF Docker Space backend, Hono),
`explorer/` (Vite + React + shadcn UI), `extension/` (vendored xTap fork,
vanilla JS — keep upstream style, record changes in `extension/VENDORED.md`).

- Run `npm run check` before finishing.
- Do not introduce `any` in TypeScript source files.
- Keep domain logic out of HTTP route handlers; put it in `space/src/` modules.
- The HF dataset repo is the system of record; the Space must never hold
  unpersisted data after an ingest request returns success.
- Keep production deployments on Hugging Face: use Spaces for web services and
  Jobs for batch, scheduled, background, or resumable workers. GitHub Actions is
  for CI only; do not use it to host production workloads or deployment schedules.
- The setup doctor and repair flow owns Hugging Face scheduled Job reconciliation.
  It must validate purpose-scoped credentials, create replacement schedules in a
  suspended state, run a bounded canary, and enable scheduling only after success.
- Provision Job secrets through Hugging Face when creating or replacing a schedule.
  Space secrets are scoped to the Space; never export credentials through GitHub.
- Contributor identity comes from verified auth only; never trust
  client-supplied attribution fields.
- Add a regression test for every bug fix.
- Use Conventional Commits.
