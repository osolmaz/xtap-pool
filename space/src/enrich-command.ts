import { rm } from "node:fs/promises";
import { join } from "node:path";

import { BucketLog, createRawBucketClient } from "./bucket-log.js";
import { loadConfig } from "./config.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import { DurableIndex } from "./durable-index.js";
import {
  contractHashFor,
  createExactHubVerifier,
  createFreeLabelJudge,
  createRouterLlmClient,
  DEFAULT_LEASE_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  runEnrichTick,
} from "./enrich-worker.js";
import type { WorkerCeilings } from "./enrich-worker.js";

/** Standalone production worker backed only by raw and index Buckets. */
export async function runEnrichCommand(env: Record<string, string | undefined>): Promise<void> {
  const config = loadConfig(env);
  if (!config.enrichEnabled) {
    console.error("[xtap-pool worker] ENRICH_ENABLED must be true to run the worker.");
    process.exitCode = 2;
    return;
  }
  if (config.inferenceToken === undefined) {
    console.error("[xtap-pool worker] INFERENCE_TOKEN is required.");
    process.exitCode = 2;
    return;
  }
  const log = new BucketLog(
    config.rawBucket,
    createRawBucketClient(config.rawBucket, config.hfToken),
    join(config.dataDir, "raw-cache"),
  );
  const taxonomy = await loadEnrichTaxonomy(log, config.taxonomyVersion);
  if (taxonomy.error !== undefined) {
    console.error(`[xtap-pool worker] taxonomy unavailable: ${taxonomy.error}`);
    process.exitCode = 3;
    return;
  }
  const contractHash = contractHashFor({ taxonomy, model: config.llmModel });
  const indexOptions = {
    rawBucket: config.rawBucket,
    indexBucket: config.indexBucket,
    accessToken: config.hfToken,
    databasePath: join(config.dataDir, "index", "worker.sqlite"),
    log,
    taxonomyVersion: config.taxonomyVersion,
    contractHash,
  };
  console.log(`[xtap-pool worker] restoring durable index from ${config.indexBucket}`);
  const index = await DurableIndex.restore(indexOptions);
  const advanced = await index.advanceToLatest();
  index.enrichStore.releaseClaims();
  console.log(
    `[xtap-pool worker] source ${advanced.revision.slice(0, 12)}; rows=${String(advanced.rowsApplied)}`,
  );

  const publicationBase = join(config.dataDir, "index", "publication.sqlite");
  await index.createWorkingCopy(publicationBase);
  const predecessorKeys = index.retainedDatabaseKeys();
  const llm = createRouterLlmClient({
    hfToken: config.inferenceToken,
    model: config.llmModel,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    ...(config.enrichInputTokenUsd === undefined || config.enrichOutputTokenUsd === undefined
      ? {}
      : {
          pricing: {
            inputTokenUsd: config.enrichInputTokenUsd,
            outputTokenUsd: config.enrichOutputTokenUsd,
          },
        }),
  });
  const ceilings: WorkerCeilings = {
    maxElapsedMs: config.enrichMaxElapsedMs,
    maxErrorRate: config.enrichMaxErrorRate,
    maxCostUsd: config.enrichMaxCostUsd,
    maxCostPerCallUsd: config.enrichMaxCostPerCallUsd,
    maxDiscardedAssignmentsPerUnit: config.enrichMaxDiscardedAssignmentsPerUnit,
    discardedAssignmentRateMinUnits: config.enrichDiscardedAssignmentRateMinUnits,
  };
  const receipt = await runEnrichTick({
    enrichStore: index.enrichStore,
    log,
    taxonomy,
    llm,
    model: config.llmModel,
    verifyHubLabel: createExactHubVerifier(),
    judgeFreeLabel: createFreeLabelJudge(llm),
    maxConcurrentCalls: config.enrichMaxConcurrentCalls,
    ...(env["JOB_ID"] === undefined ? {} : { workerId: env["JOB_ID"], writeEmptyReceipt: true }),
    leaseMs: DEFAULT_LEASE_MS,
    now: () => new Date(),
    ceilings,
  });
  index.close();
  const publication = DurableIndex.openLocal({
    ...indexOptions,
    databasePath: publicationBase,
    predecessorKeys,
  });
  try {
    const { advance: finalAdvance, manifest } = await publication.publishLatest();
    console.log(
      `[xtap-pool worker] published ${manifest.database.sha256.slice(0, 12)} at ${finalAdvance.revision.slice(0, 12)}`,
    );
  } finally {
    publication.close();
    await rm(publicationBase, { force: true });
  }
  console.log(
    `[xtap-pool worker] finished: units=${String(receipt.units)} calls=${String(receipt.calls)}`,
  );
}

export async function main(): Promise<void> {
  try {
    await runEnrichCommand(process.env);
  } catch (error) {
    console.error(
      `[xtap-pool worker] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}
