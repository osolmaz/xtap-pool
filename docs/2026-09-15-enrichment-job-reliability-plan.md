---
title: Make scheduled enrichment Jobs reliable
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-15
tags: [enrichment, jobs, sqlite, checkpoints, hugging-face]
---

# Make scheduled enrichment Jobs reliable

## Goal

Run xTap enrichment every two hours without losing completed work or timing out
during the 5.4 GB SQLite publication step.

The 08:17 Singapore Job stopped while downloading 3.36 GB of the 5.38 GB
index. The 14:17 Job completed enrichment, uploaded and verified 5.40 GB, and
activated its successor, but Hugging Face marked it as timed out because only
three seconds remained before the 45-minute limit. Four earlier Jobs completed.
The current data and public index remain healthy.

Lance is deferred. This plan makes the current SQLite design reliable while
keeping the raw Bucket, compact logical-run checkpoints, immutable result
batches, and verified index pointer.

## Requirements

- Raise the Hugging Face Job timeout from 45 minutes to 120 minutes.
- Keep the paid enrichment work limit at 40 minutes.
- Start the large index publication step only when at least 70 minutes remain in
  the physical Job.
- When less than 70 minutes remain, keep the completed logical-run checkpoint
  and exit cleanly. The next scheduled Job must restore that checkpoint and
  publish it before starting new work.
- Retry each large download or upload at most three times.
- Retry transient checkpoint and control-object reads at most three times. Do
  not retry authorization errors or other permanent Hub responses.
- Keep a partial download between attempts in the same physical Job.
- Resume a partial download only after the remote path, byte size, and ETag
  still match the identity recorded before the first byte was written.
- Verify the final file size and existing SHA-256 manifest before using a
  resumed download.
- Keep only one physical writer active. The schedule remains non-concurrent.
- After the final application checkpoint is saved, a failed progress update
  must be reported but must not change successful data work into a failed Job.
- Change the canonical schedule from every six hours to every two hours after
  the canary and deployment checks pass.
- Quiesce the old schedule from its immutable live Job definition before the
  updater installs the new Space variables. Do not require the new contract to
  exist before the old contract can be suspended safely.
- Replace the stale schedule, timeout, and publication-reserve Space variables
  with their checked-in values during every update. Preserve the deployed
  model, taxonomy, and other unchanged operating values.
- Accept the change after six consecutive scheduled Jobs finish cleanly.

## Design

### Time budget

The checked-in contract sets the platform timeout to 7,200 seconds, the worker
limit to 2,400,000 milliseconds, and the minimum publication reserve to
4,200,000 milliseconds. The Job command receives both platform values through
its normal environment.

The command uses one monotonic start time for the full physical Job. It checks
remaining platform time immediately before changing a completed logical run to
`publication-building`. A run with less than 70 minutes remaining keeps its
latest verified checkpoint and returns success. A fresh Job with the complete
120-minute budget restores that state and enters publication.

Publication that already crossed the `publication-building` checkpoint resumes
from its recorded uploaded, verified, or published boundary. It does not repeat
provider work. It also does not abandon an immutable upload that can still be
verified and activated.

### Large transfers

Resolve the remote database object before downloading it. Record its path,
size, and ETag. Write to one stable staged file. After a transport failure,
check the staged byte count and resolve the remote object again. Append the
remaining byte range only when the identity is unchanged. Reject a changed or
missing object instead of joining bytes from two generations.

Retry downloads and uploads with a fixed maximum of three attempts. Downloads
resume from the staged byte count. Upload retries reopen the same verified local
file. The existing publication code still checks the complete database SHA-256,
SQLite integrity, provenance, row counts, and immutable manifest before moving
the public pointer.

### Final progress

The application checkpoint and publication receipts remain authoritative. Once
the final checkpoint is durable, the Job makes one best-effort progress update.
A progress-store error writes a bounded log message and does not throw. Errors
before that checkpoint continue to fail the Job and publish blocked progress on
a best-effort basis.

### Schedule ownership

Setup doctor remains the only schedule writer. It creates one replacement
schedule in a suspended state, runs the existing bounded canary, verifies the
exact merged Space revision, and then activates the replacement. The final
schedule is `17 */2 * * *`, non-concurrent, on `cpu-upgrade`, with the existing
`HF_TOKEN` and `INFERENCE_TOKEN` secret names.

## Cost

`cpu-upgrade` currently costs $0.0005 per minute. Raising the hard timeout from
45 to 120 minutes raises the maximum CPU cost from $0.0225 to $0.0600 per run,
an increase of $0.0375. Six full-timeout acceptance Jobs can cost at most $0.36
for CPU. The existing $10 per-run inference ceiling does not change, and the
40-minute enrichment limit prevents the longer platform timeout from buying
more provider work.

A 60-minute timeout cannot satisfy the required 70-minute publication reserve.
A separate database service or a new table format would add more code and
operational risk before the current failure is fixed. The timeout and resume
change is the smallest option that directly addresses both observed failures.

## Scope

In scope:

- Job timeout and two-hour schedule defaults.
- Publication admission based on remaining physical-Job time.
- Bounded large-transfer retry and verified partial-download resume.
- Best-effort progress completion after the final durable checkpoint.
- Tests, review, schedule replacement, deployment, and six scheduled checks.
- README updates that describe the shipped SQLite limits.

Out of scope:

- Lance, Iceberg, Postgres, or another index format.
- Concurrent writers.
- A change to the 40-minute worker limit, inference model, provider,
  concurrency, source data, or $10 inference ceiling.
- New Buckets, datasets, credentials, services, or secret destinations.
- Deleting current index generations, checkpoints, or raw data.

## Failure handling

Fail before provider calls or pointer writes when the source revision, logical
run, checkpoint, remote object identity, SHA-256, SQLite integrity, provenance,
row counts, or writer count differs from the registered state.

Do not discard a partial download after a retryable transport failure. Discard
it only when its size exceeds the remote object, its identity changed, or its
final checksum is invalid. A changed identity requires a fresh staged file and
a new physical attempt rather than an automatic mixed-generation retry.

Pause the schedule during deployment only long enough to prevent overlap.
Restore the old validated schedule if replacement or canary checks fail. Do not
start a second physical Job while one matching writer is active.

## Acceptance criteria

1. The desired Job contract uses a 7,200-second platform timeout, a 40-minute
   worker limit, and a 70-minute publication reserve.
2. A completed logical run with 69 minutes remaining saves its checkpoint,
   exits cleanly, and does not download or upload the public index.
3. A fresh Job restores that completed run and starts publication before new
   enrichment work.
4. A partial download resumes at its exact byte count after path, size, and ETag
   verification.
5. A remote identity change prevents partial-file reuse.
6. Downloads and uploads stop after three failed attempts.
7. A transient checkpoint read such as `ECONNRESET` is retried, while a
   permanent Hub response is not retried.
8. The existing SHA-256, SQLite, provenance, count, and pointer checks still
   protect publication.
9. A progress completion failure after the final checkpoint does not fail the
   command.
10. Failures before the final checkpoint still fail closed.
11. Local pause, resume, and publication recovery tests pass.
12. An update from the prior schedule succeeds when the new publication-reserve
    variable is not present yet, while any concurrent, foreign, or changed
    schedule still fails closed.
13. The updater replaces the prior six-hour schedule and 45-minute timeout
    before schedule reconciliation without changing the deployed model,
    taxonomy, or unchanged operating values.
14. The merged Space reaches `RUNNING` at the exact reviewed revision.
15. Setup doctor leaves exactly one active non-concurrent schedule at
    `17 */2 * * *` with no overlapping Job.
16. Six consecutive scheduled Jobs complete, retain valid receipts and
    checkpoints, and keep the public index healthy.
17. Observed CPU and inference costs stay within the existing approved limits.

## Verification

Run focused transfer, command, progress, and setup tests during implementation.
Then run:

```sh
npx -y @simpledoc/simpledoc check
npm run check
git diff --check
```

Run Pi Reviewer against `main` and fix every P0 and P1 finding. After merge,
wait for the Space to run the exact merged revision. Use setup doctor for the
suspended replacement and canary. Verify the schedule definition, active writer
count, Job receipts, checkpoint state, database manifest, public pointer, and
Space health after each scheduled Job. Record all six Job IDs, terminal states,
run IDs, costs, and published database identities in the final report.
