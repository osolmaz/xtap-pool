import { rm } from "node:fs/promises";
import { join } from "node:path";

import { BucketLog, createRawBucketClient } from "./bucket-log.js";
import { loadConfig } from "./config.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import { DurableIndex } from "./durable-index.js";
import { XTapJobProgress } from "./job-progress.js";
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

export function remainingWorkerElapsedMs(
  configuredMs: number | undefined,
  commandStartedAtMs: number,
  nowMs: number,
): number | undefined {
  return configuredMs === undefined
    ? undefined
    : Math.max(0, configuredMs - Math.max(0, nowMs - commandStartedAtMs));
}

/** Standalone production worker backed only by raw and index Buckets. */
// eslint-disable-next-line complexity -- The command owns ordered setup, recovery, inference, publication, and progress finalization.
export async function runEnrichCommand(env: Record<string, string | undefined>): Promise<void> {
  const commandStartedAtMs = Date.now();
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
  const progress = await XTapJobProgress.create({
    bucket: config.indexBucket,
    accessToken: config.hfToken,
    sourceRevision: env["XTAP_SOURCE_REVISION"] ?? "local",
    contractHash,
    env,
  });
  try {
    const indexOptions = {
      rawBucket: config.rawBucket,
      indexBucket: config.indexBucket,
      accessToken: config.hfToken,
      databasePath: join(config.dataDir, "index", "worker.sqlite"),
      log,
      taxonomyVersion: config.taxonomyVersion,
      contractHash,
      progress,
    };
    console.log(`[xtap-pool worker] restoring durable index from ${config.indexBucket}`);
    const index = await DurableIndex.restore(indexOptions);
    const advanced = await index.advanceToLatest();
    index.enrichStore.releaseClaims();
    console.log(
      `[xtap-pool worker] source ${advanced.revision.slice(0, 12)}; rows=${String(advanced.rowsApplied)}`,
    );

    const publicationBase = join(config.dataDir, "index", "publication.sqlite");
    await progress.workingCopy(false);
    await index.createWorkingCopy(publicationBase);
    await progress.workingCopy(true);
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
      maxElapsedMs: remainingWorkerElapsedMs(
        config.enrichMaxElapsedMs,
        commandStartedAtMs,
        Date.now(),
      ),
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
      progress,
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
    await progress.complete();
  } catch (error) {
    try {
      await progress.blocked();
    } catch (progressError) {
      console.error(
        `[xtap-pool worker] progress failure: ${progressError instanceof Error ? progressError.message : "unknown error"}`,
      );
    }
    throw error;
  }
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
