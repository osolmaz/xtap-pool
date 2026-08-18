# Agents

Monorepo: `shared/` (tweet schema), `space/` (HF Docker Space backend, Hono),
`explorer/` (Vite + React + shadcn UI), `extension/` (vendored xTap fork,
vanilla JS — keep upstream style, record changes in `extension/VENDORED.md`).

- Run `npm run check` before finishing.
- Do not introduce `any` in TypeScript source files.
- Keep domain logic out of HTTP route handlers; put it in `space/src/` modules.
- The private raw HF Bucket is the system of record; the Space must never hold
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

## Background enrichment Jobs

- The repository's checked-in scheduled enrichment contract is standing production work. Keep the canonical Hugging Face schedule active and let it run in the background.
- Launch, resume, or retry Jobs from that unchanged contract without asking for per-run cost approval. Its checked-in schedule and hard limits are the approved bounds.
- Keep Space-side enrichment disabled and keep only one physical enrichment Job active at a time. Preserve durable checkpoints, receipts, manifests, segments, and referenced indexes across retries.
- Suspend the schedule only as long as needed to prevent overlap during maintenance, recovery, or the required sequential canary. Restore the validated canonical schedule immediately afterward.
- Routine operation must not wait for approval. Ask only when safe continuation requires a change to the contract, source, credentials, hardware, schedule, or hard limits, or when a deterministic shared defect makes another retry unsafe.
- Never inject or execute code in a website's main world, replace or wrap website APIs, or modify page-owned code. Capture website signals through passive browser-level listeners from extension-owned contexts. The current vendored `content-main.js` fetch/XHR interception violates this boundary and must be replaced rather than extended or treated as precedent.
