import { join } from "node:path";

import { loadConfig } from "./config.js";
import { createHubClient, DatasetMirror } from "./dataset.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import { EnrichStore } from "./enrich-store.js";
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
import { TweetStore } from "./store.js";

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
  const store = new TweetStore();
  const hub = createHubClient(config.datasetRepo, config.hfToken);
  const mirror = new DatasetMirror(hub, join(config.dataDir, "mirror"));
  const enrichStore = new EnrichStore(store.database, config.taxonomyVersion, () => new Date());
  const taxonomy = await loadEnrichTaxonomy(mirror, config.taxonomyVersion);
  if (taxonomy.error !== undefined) {
    console.error(`[xtap-pool worker] taxonomy unavailable: ${taxonomy.error}`);
    process.exitCode = 3;
    return;
  }
  const contractHash = contractHashFor({ taxonomy, model: config.llmModel });
  enrichStore.setContractHash(contractHash);

  console.log(
    `[xtap-pool worker] rebuilding index from ${config.datasetRepo}, contract ${contractHash.slice(0, 12)} ...`,
  );
  mirror.clearForRebuild();
  const tweetStats = await mirror.rebuild(store, enrichStore);
  const enrichStats = await mirror.rebuildEnrichment(enrichStore);
  enrichStore.releaseClaims();
  console.log(
    `[xtap-pool worker] indexed ${String(tweetStats.tweets)} tweets, ` +
      `${String(enrichStats.rows)} enrichment rows, ${String(enrichStats.attempts)} attempt events`,
  );

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
    maxDiscardedAssignments: config.enrichMaxDiscardedAssignments,
  };
  const receipt = await runEnrichTick({
    enrichStore,
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
  console.log(
    `[xtap-pool worker] finished: units=${String(receipt.units)} retries=${String(receipt.retries)} ` +
      `blocked=${String(receipt.blocked)} calls=${String(receipt.calls)} ` +
      `concurrency=${String(receipt.peak_concurrency ?? 0)}/${String(receipt.configured_concurrency ?? 1)} ` +
      `backoffs=${String(receipt.provider_backoffs ?? 0)} ` +
      `tokens=${String(receipt.prompt_tokens + receipt.completion_tokens)} ` +
      `stopped_by=${receipt.stopped_by ?? "batch-complete"}`,
  );
  store.close();
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
