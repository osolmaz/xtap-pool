import { activateEnrichmentRun } from "./enrich-active-run.js";
import { bootstrapEnrichmentRun } from "./bootstrap-enrichment-run.js";
import type { DurableIndexBucketReader } from "./durable-index.js";
import type { PreparedEnrichmentBootstrap } from "./prepare-enrichment-bootstrap.js";
import type { CheckpointObjectStore } from "@osolmaz/hf-job-control";

const CURRENT_MANIFEST_KEY = "index/current.json";

export async function commitEnrichmentBootstrap(options: {
  prepared: PreparedEnrichmentBootstrap;
  bucket: DurableIndexBucketReader;
  store: CheckpointObjectStore;
  attemptId: string;
  jobId?: string;
}): Promise<{ runId: string; planSha256: string }> {
  const before = await options.bucket.readText(CURRENT_MANIFEST_KEY);
  if (before !== options.prepared.pointerBytes) {
    throw new Error("durable index changed after bootstrap preparation");
  }
  const result = await bootstrapEnrichmentRun({
    sourceDatabasePath: options.prepared.sourceDatabasePath,
    compactDatabasePath: options.prepared.compactDatabasePath,
    registryBaselineScanned: options.prepared.candidate.registry.baseline_scanned,
    ...(options.prepared.registryCursor === undefined
      ? {}
      : { registryCursor: options.prepared.registryCursor }),
    store: options.store,
    attemptId: options.attemptId,
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    planInput: options.prepared.planInput,
  });
  const after = await options.bucket.readText(CURRENT_MANIFEST_KEY);
  if (after !== options.prepared.pointerBytes) {
    throw new Error("durable index changed during bootstrap commit");
  }
  await activateEnrichmentRun({
    store: options.store,
    runId: result.runId,
    planSha256: result.planSha256,
    activatedAt: new Date().toISOString(),
  });
  return result;
}
