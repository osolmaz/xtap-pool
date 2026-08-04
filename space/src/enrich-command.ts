import { rm } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { createHubClient, DatasetMirror } from "./dataset.js";
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

/**
 * Standalone worker: rebuilds the local mirror from the dataset (system of
 * record), drains eligible work until a safety ceiling is reached, and exits.
 * This is the production scheduling entrypoint — the API Space no longer runs
 * an interval loop.
 */
// eslint-disable-next-line complexity -- Production entrypoint validates config, rebuilds durable state, and reports its safety-bounded run.
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
  const hub = createHubClient(config.datasetRepo, config.hfToken);
  const mirror = new DatasetMirror(hub, join(config.dataDir, "mirror"));
  const taxonomy = await loadEnrichTaxonomy(mirror, config.taxonomyVersion);
  if (taxonomy.error !== undefined) {
    console.error(`[xtap-pool worker] taxonomy unavailable: ${taxonomy.error}`);
    process.exitCode = 3;
    return;
  }
  const contractHash = contractHashFor({ taxonomy, model: config.llmModel });

  console.log(
    `[xtap-pool worker] restoring durable index from ${config.indexBucket}, contract ${contractHash.slice(0, 12)} ...`,
  );
  const indexOptions = {
    datasetRepo: config.datasetRepo,
    indexBucket: config.indexBucket,
    accessToken: config.hfToken,
    databasePath: join(config.dataDir, "index", "worker.sqlite"),
    mirror,
    taxonomyVersion: config.taxonomyVersion,
    contractHash,
  };
  const index = await DurableIndex.restore(indexOptions);
  const advanced = await index.advanceToLatest();
  index.enrichStore.releaseClaims();
  console.log(
    `[xtap-pool worker] index revision ${advanced.revision.slice(0, 12)}; ` +
      `changed_files=${String(advanced.filesChanged)} rows=${String(advanced.rowsApplied)} ` +
      `tweets=${String(advanced.counts.tweets)} units=${String(advanced.counts.units)}`,
  );
  const publicationBase = join(config.dataDir, "index", "publication-base.sqlite");
  await index.createWorkingCopy(publicationBase);

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
    mirror,
    taxonomy,
    llm,
    model: config.llmModel,
    verifyHubLabel: createExactHubVerifier(),
    judgeFreeLabel: createFreeLabelJudge(llm),
    maxConcurrentCalls: config.enrichMaxConcurrentCalls,
    ...(env["JOB_ID"] === undefined ? {} : { workerId: env["JOB_ID"], writeEmptyReceipt: true }),
    leaseMs: DEFAULT_LEASE_MS,
    now: (): Date => new Date(),
    ceilings,
  });
  index.close();
  const publicationMirror = new DatasetMirror(hub, join(config.dataDir, "publication-mirror"));
  const manifestBaselineSha256 = index.currentManifestBaselineSha256();
  const publication = DurableIndex.openLocal({
    ...indexOptions,
    databasePath: publicationBase,
    mirror: publicationMirror,
    ...(manifestBaselineSha256 === undefined ? {} : { manifestBaselineSha256 }),
  });
  try {
    const finalAdvance = await publication.advanceToLatest();
    const manifest = await publication.publish();
    console.log(
      `[xtap-pool worker] published index ${manifest.database.sha256.slice(0, 12)} at ` +
        `${finalAdvance.revision.slice(0, 12)}; changed_files=${String(finalAdvance.filesChanged)} ` +
        `rows=${String(finalAdvance.rowsApplied)}`,
    );
  } finally {
    publication.close();
    await rm(publicationBase, { force: true });
  }
  console.log(
    `[xtap-pool worker] finished: units=${String(receipt.units)} retries=${String(receipt.retries)} ` +
      `blocked=${String(receipt.blocked)} calls=${String(receipt.calls)} ` +
      `concurrency=${String(receipt.peak_concurrency ?? 0)}/${String(receipt.configured_concurrency ?? 1)} ` +
      `backoffs=${String(receipt.provider_backoffs ?? 0)} ` +
      `tokens=${String(receipt.prompt_tokens + receipt.completion_tokens)} ` +
      `stopped_by=${receipt.stopped_by ?? "batch-complete"}`,
  );
}

/**
 * Entrypoint used by `npm run enrich` / `node dist/src/enrich-command-main.js`.
 * Exposed here so tests can drive `runEnrichCommand` directly with a fake env.
 */
export async function main(): Promise<void> {
  try {
    await runEnrichCommand(process.env);
  } catch (error) {
    console.error(`[xtap-pool worker] fatal: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
