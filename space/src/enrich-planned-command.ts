import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";
import { CheckpointCoordinator, type CheckpointObjectStore } from "@osolmaz/hf-job-control";
import {
  attemptEventSchema,
  freeLabelEventSchema,
  parseEnrichReceipt,
  parseEnrichmentRow,
} from "@xtap-pool/shared";
import type {
  AttemptEvent,
  DeploymentManifest,
  EnrichReceipt,
  FreeLabelEvent,
} from "@xtap-pool/shared";

import { activateEnrichmentRun } from "./enrich-active-run.js";
import { mapBatchesInOrder } from "./bounded-concurrency.js";
import { bootstrapEnrichmentRun } from "./bootstrap-enrichment-run.js";
import {
  bucketSnapshotSchema,
  BucketLog,
  canonicalBytes,
  createRawBucketClient,
  createRawBucketReader,
  sha256,
} from "./bucket-log.js";
import type { BucketSegment, BucketSnapshotFile } from "./bucket-log.js";
import { loadConfig } from "./config.js";
import { durableIndexManifestSchema, DurableIndex } from "./durable-index.js";
import type { DurableIndexManifest } from "./durable-index.js";
import { resolveEnrichmentTaxonomyForContract } from "./enrich-taxonomy-contract.js";
import {
  createEnrichmentCheckpointStore,
  createReadOnlyEnrichmentCheckpointStore,
  EnrichmentCheckpointAdapter,
  withCheckpointClaimPrefetch,
} from "./enrich-checkpoint.js";
import { enrichmentBatchResultSchema, publishEnrichmentBatchResult } from "./enrich-batch.js";
import { canonicalPlanBytes, parseEnrichmentRunPlan } from "./enrich-run-plan.js";
import type { EnrichmentRunPlan } from "./enrich-run-plan.js";
import {
  prepareEnrichmentRevision,
  verifyPreparedEnrichmentRevision,
  type PreparedEnrichmentRevision,
} from "./enrich-revision-handoff.js";
import type { EnrichmentCheckpointState, OutputKind } from "./enrich-state.js";
import {
  advanceOutputFrontier,
  advanceRegistryCursor,
  createEmptyEnrichmentState,
  markQueueCompleted,
  recordQueueAttempt,
  setPublicationState,
  withCheckpointSequence,
} from "./enrich-state.js";
import { EnrichStore } from "./enrich-store.js";
import {
  createExactHubVerifier,
  createFreeLabelJudge,
  createRouterLlmClient,
  DEFAULT_LEASE_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  runEnrichTick,
} from "./enrich-worker.js";
import type { DurableWorkerOutput, WorkerCeilings } from "./enrich-worker.js";
import { remainingWorkerElapsedMs } from "./enrich-command.js";
import { XTapJobProgress } from "./job-progress.js";
import { TweetStore } from "./store.js";

const RUN_PREFIX = "operations/enrichment/runs";
const SEGMENT_SHA256 = /-([0-9a-f]{64})\.json\.gz$/u;
const SEGMENT_TIME = /\/(\d{13})-[0-9a-f-]{36}-[0-9a-f]{64}\.json\.gz$/u;
const successorReferenceSchema = z
  .object({
    schema_version: z.literal(1),
    predecessor_run_id: z.string().min(1),
    predecessor_plan_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    run_id: z.string().min(1),
    plan_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();
const sourceSegmentSchema = z
  .object({
    key: z.string().min(1),
    oid: z.string().min(1),
    listed_oid: z.string().min(1).nullable(),
    byte_length: z.number().int().nonnegative(),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    tweet_rows: z.number().int().nonnegative(),
    enrichment_rows: z.number().int().nonnegative(),
    attempt_rows: z.number().int().nonnegative(),
    registry_rows: z.number().int().nonnegative(),
    receipt_rows: z.number().int().nonnegative(),
  })
  .strict();

export type PlannedEnrichmentBudget = {
  commandStartedAtMs: number;
  maxElapsedMs?: number;
  maxCostUsd?: number;
};

export type PlannedEnrichmentRunResult = {
  providerCostUsd: number;
  successorHasWork: boolean;
};

// eslint-disable-next-line complexity -- The loop must gate optional time, cost, reservation, and reported-cost bounds together.
export async function runBoundedSuccessorDrain(options: {
  maxElapsedMs?: number;
  maxCostUsd?: number;
  maxCostPerCallUsd?: number;
  now?: () => number;
  run: (budget: PlannedEnrichmentBudget) => Promise<PlannedEnrichmentRunResult>;
}): Promise<{ logicalRuns: number; providerCostUsd: number }> {
  const now = options.now ?? Date.now;
  const commandStartedAtMs = now();
  let logicalRuns = 0;
  let providerCostUsd = 0;
  let successorHasWork = true;
  while (successorHasWork) {
    const remainingElapsedMs = remainingWorkerElapsedMs(
      options.maxElapsedMs,
      commandStartedAtMs,
      now(),
    );
    const maxCostUsd = remainingWorkerCostUsd(options.maxCostUsd, providerCostUsd);
    if (
      logicalRuns > 0 &&
      !successorBudgetAdmitsWork(remainingElapsedMs, maxCostUsd, options.maxCostPerCallUsd)
    ) {
      break;
    }
    const result = await options.run({
      commandStartedAtMs,
      ...(options.maxElapsedMs === undefined ? {} : { maxElapsedMs: options.maxElapsedMs }),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    });
    if (!Number.isFinite(result.providerCostUsd) || result.providerCostUsd < 0) {
      throw new Error("planned enrichment reported invalid provider cost");
    }
    if (maxCostUsd !== undefined && result.providerCostUsd > maxCostUsd) {
      throw new Error("planned enrichment exceeded the remaining physical-attempt cost");
    }
    providerCostUsd += result.providerCostUsd;
    logicalRuns += 1;
    successorHasWork = result.successorHasWork;
  }
  return { logicalRuns, providerCostUsd };
}

export function remainingWorkerCostUsd(
  configuredUsd: number | undefined,
  consumedUsd: number,
): number | undefined {
  return configuredUsd === undefined ? undefined : Math.max(0, configuredUsd - consumedUsd);
}

function successorBudgetAdmitsWork(
  remainingElapsedMs: number | undefined,
  remainingCostUsd: number | undefined,
  maxCostPerCallUsd: number | undefined,
): boolean {
  if (remainingElapsedMs !== undefined && remainingElapsedMs <= 0) return false;
  if (remainingCostUsd === undefined) return true;
  if (remainingCostUsd <= 0) return false;
  return maxCostPerCallUsd === undefined || remainingCostUsd >= maxCostPerCallUsd;
}

export async function runPlannedEnrichmentCommand(
  env: Record<string, string | undefined>,
  options: { deploymentManifest: DeploymentManifest },
): Promise<void> {
  const restoreOnly = env["XTAP_RESTORE_ONLY"] === "true";
  const config = loadConfig(
    restoreOnly ? { ...env, ENRICH_ENABLED: "false", INFERENCE_TOKEN: undefined } : env,
  );
  await runBoundedSuccessorDrain({
    ...(config.enrichMaxElapsedMs === undefined ? {} : { maxElapsedMs: config.enrichMaxElapsedMs }),
    ...(config.enrichMaxCostUsd === undefined ? {} : { maxCostUsd: config.enrichMaxCostUsd }),
    ...(config.enrichMaxCostPerCallUsd === undefined
      ? {}
      : { maxCostPerCallUsd: config.enrichMaxCostPerCallUsd }),
    run: (budget) => runSinglePlannedEnrichmentRun(env, budget, options.deploymentManifest),
  });
}

// eslint-disable-next-line complexity -- Deployment preflight verifies each frozen input and output boundary independently.
export async function validatePreparedEnrichmentWorkerOutputs(options: {
  preparedRevision: PreparedEnrichmentRevision;
  checkpointStore: CheckpointObjectStore;
  rawBucket: string;
  accessToken: string;
  dataDir: string;
}): Promise<{ claimedSegments: number; orphanSegments: 0 }> {
  const plan = options.preparedRevision.plan;
  if (plan.source.bucket !== options.rawBucket) {
    throw new Error("active enrichment plan raw Bucket mismatch");
  }
  const workPath = join(options.dataDir, "handoff-work.sqlite");
  await mkdir(dirname(workPath), { recursive: true });
  await rm(workPath, { force: true });
  const workBytes = await requiredObject(options.checkpointStore, plan.work.key);
  verifyObject(workBytes, plan.work.bytes, plan.work.sha256, "enrichment work plan");
  await writeFile(workPath, workBytes);

  const sourceSegmentsBytes = await requiredObject(
    options.checkpointStore,
    plan.source.ordered_segments.key,
  );
  verifyObject(
    sourceSegmentsBytes,
    plan.source.ordered_segments.bytes,
    plan.source.ordered_segments.sha256,
    "ordered source segments",
  );
  const sourceSegments = parseSourceSegments(sourceSegmentsBytes);
  const sourceSnapshot = bucketSnapshotSchema.parse({
    schema_version: 1,
    bucket: plan.source.bucket,
    files: sourceSegments,
  });
  if (sha256(canonicalBytes(sourceSnapshot)) !== plan.source.snapshot_revision) {
    throw new Error("ordered source segments do not match the plan snapshot");
  }

  const log = new BucketLog(
    options.rawBucket,
    createRawBucketReader(options.rawBucket, options.accessToken),
    join(options.dataDir, "handoff-raw-cache"),
  );
  const { taxonomy, contractHash } = await resolveEnrichmentTaxonomyForContract({
    log,
    snapshot: sourceSnapshot,
    taxonomyVersion: plan.contract.taxonomy_version,
    llmModel: plan.contract.model,
    expectedContractHash: plan.contract.contract_sha256,
    concurrency: 16,
  });
  const tweetStore = new TweetStore(workPath);
  const enrichStore = new EnrichStore(
    tweetStore.database,
    taxonomy.version,
    () => new Date(),
    contractHash,
  );
  try {
    const quickCheck = tweetStore.database.pragma("quick_check") as { quick_check: string }[];
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
      throw new Error("planned work database SQLite quick_check failed");
    }
    const ordinals = readQueueOrdinals(tweetStore.database);
    const queueBaselineOrdinals = readQueueBaselineOrdinals(tweetStore.database);
    const queueIdentities = readQueueIdentities(tweetStore.database, contractHash);
    const registryNames = readRegistryNames(tweetStore.database);
    if (ordinals.size !== plan.work.queue_total || queueIdentities.size !== plan.work.queue_total) {
      throw new Error("planned work queue count does not match the plan");
    }
    if (queueBaselineOrdinals.size !== plan.work.queue_baseline_done) {
      throw new Error("planned work queue baseline does not match the plan");
    }
    if (registryNames.length + plan.work.registry_baseline_scanned !== plan.work.registry_total) {
      throw new Error("planned work registry count does not match the plan");
    }

    const state = options.preparedRevision.adapter.state;
    const replayEvidence = await restoreAndReconcileWorkerOutputs({
      log,
      sourceSegments,
      checkpointStore: options.checkpointStore,
      rejectUncheckpointedResults: true,
      runId: plan.run_id,
      state: () => state,
      registryNames,
      registryBaselineOrdinal: plan.work.registry_baseline_scanned,
      queueBaselineOrdinals,
      queueIdentities,
      contractHash,
      tweetStore,
      enrichStore,
      outputClaimsProgress: () => Promise.resolve(),
      replayProgress: () => Promise.resolve(),
    });
    applyCheckpointToWorkerDatabase(tweetStore.database, state);
    const restoredQuickCheck = tweetStore.database.pragma("quick_check") as {
      quick_check: string;
    }[];
    if (restoredQuickCheck.length !== 1 || restoredQuickCheck[0]?.quick_check !== "ok") {
      throw new Error("restored work database SQLite quick_check failed");
    }
    if (replayEvidence.orphanSegments !== 0) {
      throw new Error("enrichment handoff preparation found orphan worker output segments");
    }
    return { claimedSegments: replayEvidence.claimedSegments, orphanSegments: 0 };
  } finally {
    tweetStore.close();
  }
}

// eslint-disable-next-line complexity -- One logical run owns ordered restore, work, checkpoint, and publication stages.
async function runSinglePlannedEnrichmentRun(
  env: Record<string, string | undefined>,
  budget: PlannedEnrichmentBudget,
  deploymentManifest: DeploymentManifest,
): Promise<PlannedEnrichmentRunResult> {
  const commandStartedAtMs = budget.commandStartedAtMs;
  const restoreOnly = env["XTAP_RESTORE_ONLY"] === "true";
  const config = loadConfig(
    restoreOnly ? { ...env, ENRICH_ENABLED: "false", INFERENCE_TOKEN: undefined } : env,
  );
  if (restoreOnly) {
    if (config.inferenceToken !== undefined) {
      throw new Error("restore-only validation must not receive INFERENCE_TOKEN");
    }
  } else if (!config.enrichEnabled || config.inferenceToken === undefined) {
    throw new Error("planned enrichment requires ENRICH_ENABLED and INFERENCE_TOKEN");
  }
  const emitRestoreProgress = (
    stage: string,
    completed: number,
    total: number,
    unit: "items" | "bytes" = "items",
  ): void => {
    if (!restoreOnly) return;
    console.log(
      JSON.stringify({
        type: "restore-progress",
        stage,
        completed,
        total,
        unit,
        elapsed_ms: Date.now() - commandStartedAtMs,
      }),
    );
  };
  const preflightStore = createReadOnlyEnrichmentCheckpointStore({
    bucket: config.indexBucket,
    accessToken: config.hfToken,
  });
  const targetWorkerRevision = requireEnvironment(env, "XTAP_SOURCE_REVISION");
  const preparedRevision = await prepareEnrichmentRevision({
    store: preflightStore,
    targetWorkerRevision,
  });
  await verifyPreparedEnrichmentRevision(
    deploymentManifest,
    preparedRevision,
    targetWorkerRevision,
    preflightStore,
  );
  const activeRun = preparedRevision.active.activeRun;
  emitRestoreProgress("active-run", 1, 1);
  const runId = activeRun.run_id;
  const planSha256 = activeRun.plan_sha256;
  const plan = preparedRevision.plan;
  if (plan.source.bucket !== config.rawBucket) {
    throw new Error("active enrichment plan raw Bucket mismatch");
  }
  emitRestoreProgress("plan", 1, 1);
  emitRestoreProgress(
    "checkpoint",
    preparedRevision.checkpoint.evidence.sequence,
    preparedRevision.checkpoint.evidence.sequence,
  );
  const workPath = join(config.dataDir, "planned", `${runId}.sqlite`);
  await mkdir(dirname(workPath), { recursive: true });
  await rm(workPath, { force: true });
  const workBytes = await requiredObject(preflightStore, plan.work.key);
  verifyObject(workBytes, plan.work.bytes, plan.work.sha256, "enrichment work plan");
  emitRestoreProgress("work-plan", workBytes.byteLength, plan.work.bytes, "bytes");
  await writeFile(workPath, workBytes);
  let sourceSegments: BucketSnapshotFile[];
  {
    const sourceSegmentsBytes = await requiredObject(
      preflightStore,
      plan.source.ordered_segments.key,
    );
    verifyObject(
      sourceSegmentsBytes,
      plan.source.ordered_segments.bytes,
      plan.source.ordered_segments.sha256,
      "ordered source segments",
    );
    sourceSegments = parseSourceSegments(sourceSegmentsBytes);
  }
  const sourceSnapshot = bucketSnapshotSchema.parse({
    schema_version: 1,
    bucket: plan.source.bucket,
    files: sourceSegments,
  });
  if (sha256(canonicalBytes(sourceSnapshot)) !== plan.source.snapshot_revision) {
    throw new Error("ordered source segments do not match the plan snapshot");
  }
  emitRestoreProgress("source", sourceSegments.length, sourceSegments.length);

  const preflightLog = new BucketLog(
    config.rawBucket,
    createRawBucketReader(config.rawBucket, config.hfToken),
    join(config.dataDir, "planned-raw-cache"),
  );
  const { taxonomy, contractHash } = await resolveEnrichmentTaxonomyForContract({
    log: preflightLog,
    snapshot: sourceSnapshot,
    taxonomyVersion: config.taxonomyVersion,
    llmModel: config.llmModel,
    expectedContractHash: plan.contract.contract_sha256,
    concurrency: restoreOnly ? 16 : 4,
    progress: (completed, total) => {
      emitRestoreProgress("taxonomy", completed, total);
      return Promise.resolve();
    },
  });
  emitRestoreProgress("contract", 1, 1);
  let tweetStore = new TweetStore(workPath);
  let enrichStore = new EnrichStore(
    tweetStore.database,
    taxonomy.version,
    () => new Date(),
    contractHash,
  );
  const quickCheck = tweetStore.database.pragma("quick_check") as { quick_check: string }[];
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
    throw new Error("planned work database SQLite quick_check failed");
  }
  const ordinals = readQueueOrdinals(tweetStore.database);
  const queueBaselineOrdinals = readQueueBaselineOrdinals(tweetStore.database);
  const queueIdentities = readQueueIdentities(tweetStore.database, contractHash);
  const registryNames = readRegistryNames(tweetStore.database);
  if (ordinals.size !== plan.work.queue_total || queueIdentities.size !== plan.work.queue_total) {
    throw new Error("planned work queue count does not match the plan");
  }
  if (queueBaselineOrdinals.size !== plan.work.queue_baseline_done) {
    throw new Error("planned work queue baseline does not match the plan");
  }
  if (registryNames.length + plan.work.registry_baseline_scanned !== plan.work.registry_total) {
    throw new Error("planned work registry count does not match the plan");
  }
  emitRestoreProgress("database", 1, 1);

  const requireExactOutputFrontier = preparedRevision.handoff !== null || restoreOnly;
  if (!restoreOnly) {
    try {
      const preflightState = preparedRevision.adapter.state;
      const preflightReplayEvidence = await restoreAndReconcileWorkerOutputs({
        log: preflightLog,
        sourceSegments,
        checkpointStore: preflightStore,
        rejectUncheckpointedResults: requireExactOutputFrontier,
        runId,
        state: () => preflightState,
        registryNames,
        registryBaselineOrdinal: plan.work.registry_baseline_scanned,
        queueBaselineOrdinals,
        queueIdentities,
        contractHash,
        tweetStore,
        enrichStore,
        outputClaimsProgress: () => Promise.resolve(),
        replayProgress: () => Promise.resolve(),
      });
      if (requireExactOutputFrontier && preflightReplayEvidence.orphanSegments !== 0) {
        throw new Error("verified output frontier has orphan worker output segments");
      }
      applyCheckpointToWorkerDatabase(tweetStore.database, preflightState);
      const restoredQuickCheck = tweetStore.database.pragma("quick_check") as {
        quick_check: string;
      }[];
      if (restoredQuickCheck.length !== 1 || restoredQuickCheck[0]?.quick_check !== "ok") {
        throw new Error("preflight work database SQLite quick_check failed");
      }
    } finally {
      tweetStore.close();
    }
    await writeFile(workPath, workBytes);
    tweetStore = new TweetStore(workPath);
    enrichStore = new EnrichStore(
      tweetStore.database,
      taxonomy.version,
      () => new Date(),
      contractHash,
    );
  }

  const log = restoreOnly
    ? preflightLog
    : new BucketLog(
        config.rawBucket,
        createRawBucketClient(config.rawBucket, config.hfToken),
        join(config.dataDir, "planned-raw-cache"),
      );
  const progress = restoreOnly
    ? null
    : await XTapJobProgress.create({
        bucket: config.indexBucket,
        accessToken: config.hfToken,
        sourceRevision: plan.source.snapshot_revision,
        contractHash,
        env: { ...env, XTAP_PROGRESS_RUN_ID: runId },
      });
  const baseCheckpointStore = restoreOnly
    ? preflightStore
    : createEnrichmentCheckpointStore({
        bucket: config.indexBucket,
        accessToken: config.hfToken,
      });
  const checkpointStore = withCheckpointClaimPrefetch(baseCheckpointStore, {
    runId,
    prefix: RUN_PREFIX,
    concurrency: 16,
    progress: async (completed, total) => {
      emitRestoreProgress("checkpoint-claims", completed, total);
      await progress?.checkpointClaims(completed, total);
    },
  });
  const adapter = restoreOnly
    ? preparedRevision.adapter
    : new EnrichmentCheckpointAdapter(
        createEmptyEnrichmentState({
          runId,
          planSha256,
          queueTotal: plan.work.queue_total,
          queueBaselineDone: plan.work.queue_baseline_done,
          registryTotal: plan.work.registry_total,
          registryBaselineScanned: plan.work.registry_baseline_scanned,
        }),
      );
  const attemptId = env["JOB_ID"] ?? `local-${process.pid.toString()}`;
  const coordinator = CheckpointCoordinator.create({
    runId,
    attemptId,
    ...(env["JOB_ID"] === undefined ? {} : { jobId: env["JOB_ID"] }),
    planSha256,
    store: checkpointStore,
    prefix: RUN_PREFIX,
  });
  if (!restoreOnly) {
    const restored = await coordinator.restoreLatest(adapter);
    if (restored === null) throw new Error("planned enrichment has no bootstrap checkpoint");
    if (
      restored.checkpoint.key !== preparedRevision.checkpoint.checkpoint.key ||
      restored.checkpoint.sha256 !== preparedRevision.checkpoint.checkpoint.sha256 ||
      restored.checkpoint.bytes !== preparedRevision.checkpoint.checkpoint.bytes
    ) {
      throw new Error("enrichment checkpoint changed after revision handoff preflight");
    }
  }
  let state = adapter.state;
  if (state.publication.state === "pending" || state.publication.state === "building") {
    const currentIndexBytes = await requiredObject(checkpointStore, "index/current.json");
    const currentIndex = durableIndexManifestSchema.parse(
      JSON.parse(Buffer.from(currentIndexBytes).toString("utf8")),
    );
    if (currentIndex.database.sha256 !== plan.base_index.sha256) {
      throw new Error("active enrichment plan base index is no longer current");
    }
  }

  const commitOutputs = async (outputs: readonly DurableWorkerOutput[]): Promise<void> => {
    const resultSha256: string[] = [];
    for (const output of outputs) {
      const phase = output.kind === "queue" ? "queue" : output.kind;
      const frontierKind: OutputKind = output.kind === "queue" ? "enrichment" : output.kind;
      const frontier = state.outputs[frontierKind];
      const result = await publishEnrichmentBatchResult({
        store: checkpointStore,
        prefix: RUN_PREFIX,
        value: {
          schema_version: 1,
          run_id: runId,
          phase,
          sequence: frontier.sequence + 1,
          previous_result_sha256: frontier.chain_sha256,
          ordinals: outputOrdinals(
            output,
            ordinals,
            registryNames,
            state.registry.next_ordinal,
            plan.work.registry_baseline_scanned,
          ),
          raw_segment_key: output.segmentKey,
          raw_segment_sha256: rawSegmentSha256(output.segmentKey),
          created_at: rawSegmentCreatedAt(output.segmentKey),
        },
      });
      state = applyDurableOutput(state, output, ordinals, result.sha256);
      resultSha256.push(result.sha256);
    }
    state = withCheckpointSequence(state, state.sequence + 1);
    adapter.replace(state);
    await coordinator.commit(
      {
        name: outputs.length === 1 ? `${outputs[0]?.kind ?? "output"}-segment` : "orphan-segment",
        sequence: state.sequence,
        reached_at: new Date().toISOString(),
        metadata: { result_count: outputs.length, result_sha256: resultSha256.join(",") },
      },
      adapter,
    );
  };
  const commitOutput = (output: DurableWorkerOutput): Promise<void> => commitOutputs([output]);

  const replayEvidence = await restoreAndReconcileWorkerOutputs({
    log,
    sourceSegments,
    checkpointStore,
    rejectUncheckpointedResults: requireExactOutputFrontier,
    runId,
    state: () => state,
    ...(restoreOnly || requireExactOutputFrontier ? {} : { commitOutputs }),
    registryNames,
    registryBaselineOrdinal: plan.work.registry_baseline_scanned,
    queueBaselineOrdinals,
    queueIdentities,
    contractHash,
    tweetStore,
    enrichStore,
    outputClaimsProgress: async (completed, total) => {
      emitRestoreProgress("output-claims", completed, total);
      await progress?.outputClaims(completed, total);
    },
    replayProgress: async (completed, total) => {
      emitRestoreProgress("checkpoint-replay", completed, total);
      await progress?.checkpointReplay(completed, total);
    },
  });
  if (requireExactOutputFrontier && replayEvidence.orphanSegments !== 0) {
    throw new Error("verified output frontier has orphan worker output segments");
  }
  applyCheckpointToWorkerDatabase(tweetStore.database, state);
  const restoredQuickCheck = tweetStore.database.pragma("quick_check") as {
    quick_check: string;
  }[];
  if (restoredQuickCheck.length !== 1 || restoredQuickCheck[0]?.quick_check !== "ok") {
    throw new Error("restored work database SQLite quick_check failed");
  }
  if (restoreOnly) {
    console.log(
      JSON.stringify({
        type: "restore-complete",
        run_id: runId,
        plan_sha256: planSha256,
        sequence: state.sequence,
        queue_done: state.queue.done,
        queue_total: state.queue.total,
        registry_next_ordinal: state.registry.next_ordinal,
        registry_total: state.registry.total,
        claimed_segments: replayEvidence.claimedSegments,
        orphan_segments: replayEvidence.orphanSegments,
        provider_calls: 0,
        elapsed_ms: Date.now() - commandStartedAtMs,
      }),
    );
    tweetStore.close();
    return { providerCostUsd: 0, successorHasWork: false };
  }
  if (progress === null) throw new Error("planned enrichment progress is unavailable");

  const commitPublicationBoundary = async (
    publicationState: "uploaded" | "verified" | "published",
    manifest: NonNullable<EnrichmentCheckpointState["publication"]["manifest"]>,
    databaseBytes: number,
  ): Promise<void> => {
    state = setPublicationState(state, {
      state: publicationState,
      database_key: manifest.database.key,
      database_sha256: manifest.database.sha256,
      database_bytes: databaseBytes,
      manifest,
    });
    state = withCheckpointSequence(state, state.sequence + 1);
    adapter.replace(state);
    await coordinator.commit(
      {
        name: `publication-${publicationState}`,
        sequence: state.sequence,
        reached_at: new Date().toISOString(),
        metadata: { database_sha256: manifest.database.sha256 },
      },
      adapter,
    );
  };

  try {
    if (state.publication.state === "uploaded" || state.publication.state === "verified") {
      const manifest = state.publication.manifest;
      const databaseBytes = state.publication.database_bytes;
      if (manifest === null || databaseBytes === null) {
        throw new Error("resumable publication reference is incomplete");
      }
      const resumePath = join(config.dataDir, "planned", `${runId}-resume.sqlite`);
      await DurableIndex.completeVerifiedPublication({
        indexBucket: config.indexBucket,
        accessToken: config.hfToken,
        databasePath: resumePath,
        rawBucket: config.rawBucket,
        contractHash,
        expectedCurrentDatabaseSha256: plan.base_index.sha256,
        manifest,
        alreadyVerified: state.publication.state === "verified",
        databaseBytes,
        publicationBoundary: commitPublicationBoundary,
      });
      const successor = await ensureSuccessorRun({
        config,
        log,
        checkpointStore,
        plan,
        targetWorkerRevision,
        attemptId,
        manifest,
        databaseBytes,
        databasePath: resumePath,
      });
      await finishPlannedRun(coordinator, adapter, state, progress, manifest.database.sha256);
      return { providerCostUsd: 0, successorHasWork: successor.hasWork };
    }
    if (state.publication.state === "published") {
      const manifest = state.publication.manifest;
      const databaseBytes = state.publication.database_bytes;
      if (manifest === null || databaseBytes === null) {
        throw new Error("published database reference is incomplete");
      }
      const successor = await ensureSuccessorRun({
        config,
        log,
        checkpointStore,
        plan,
        targetWorkerRevision,
        attemptId,
        manifest,
        databaseBytes,
        databasePath: join(config.dataDir, "planned", `${runId}-published.sqlite`),
      });
      await finishPlannedRun(coordinator, adapter, state, progress, manifest.database.sha256);
      return { providerCostUsd: 0, successorHasWork: successor.hasWork };
    }

    const inferenceToken = config.inferenceToken;
    if (inferenceToken === undefined) throw new Error("planned enrichment token is missing");
    const llm = createRouterLlmClient({
      hfToken: inferenceToken,
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
      maxElapsedMs: remainingWorkerElapsedMs(budget.maxElapsedMs, commandStartedAtMs, Date.now()),
      maxErrorRate: config.enrichMaxErrorRate,
      maxCostUsd: budget.maxCostUsd,
      maxCostPerCallUsd: config.enrichMaxCostPerCallUsd,
      maxDiscardedAssignmentsPerUnit: config.enrichMaxDiscardedAssignmentsPerUnit,
      discardedAssignmentRateMinUnits: config.enrichDiscardedAssignmentRateMinUnits,
    };
    const receipt = await runEnrichTick({
      enrichStore,
      log,
      taxonomy,
      llm,
      model: config.llmModel,
      verifyHubLabel: createExactHubVerifier(),
      judgeFreeLabel: createFreeLabelJudge(llm),
      maxConcurrentCalls: config.enrichMaxConcurrentCalls,
      workerId: attemptId,
      writeEmptyReceipt: true,
      leaseMs: DEFAULT_LEASE_MS,
      now: () => new Date(),
      ceilings,
      progress: {
        queue: async (depth) =>
          progress.queue({
            ...depth,
            done: depth.done + plan.work.queue_baseline_done,
          }),
        registryScan: (scanned, total) => progress.registryScan(scanned, total),
        receiptPublished: () => progress.receiptPublished(),
      },
      durableOutput: commitOutput,
      registryPlan: {
        names: registryNames,
        baselineOrdinal: plan.work.registry_baseline_scanned,
        nextOrdinal: state.registry.next_ordinal,
        total: plan.work.registry_total,
      },
    });

    if (runIsComplete(state)) {
      state = setPublicationState(state, {
        state: "building",
        database_key: null,
        database_sha256: null,
        database_bytes: null,
        manifest: null,
      });
      state = withCheckpointSequence(state, state.sequence + 1);
      adapter.replace(state);
      await coordinator.commit(
        {
          name: "publication-building",
          sequence: state.sequence,
          reached_at: new Date().toISOString(),
          metadata: {},
        },
        adapter,
      );
      const outputKeys = [
        ...new Set([
          ...sourceSegments.map((file) => file.key),
          ...(await readRunOutputKeys(checkpointStore, runId, state, {
            queue: queueBaselineOrdinals,
            registry: plan.work.registry_baseline_scanned,
          })),
        ]),
      ].sort();
      const publicationPath = join(config.dataDir, "planned", `${runId}-publication.sqlite`);
      const publication = await DurableIndex.restoreReference(
        {
          rawBucket: config.rawBucket,
          indexBucket: config.indexBucket,
          accessToken: config.hfToken,
          databasePath: publicationPath,
          log,
          taxonomyVersion: config.taxonomyVersion,
          contractHash,
          expectedCurrentDatabaseSha256: plan.base_index.sha256,
          progress,
          publicationBoundary: commitPublicationBoundary,
        },
        {
          key: plan.base_index.key,
          sha256: plan.base_index.sha256,
          sourceRevision: plan.base_index.source_revision,
        },
      );
      try {
        await publication.applyOutputSegments(outputKeys);
        const manifest = await publication.publish();
        const databaseBytes = state.publication.database_bytes;
        if (databaseBytes === null) throw new Error("published database byte count is missing");
        const successor = await ensureSuccessorRun({
          config,
          log,
          checkpointStore,
          plan,
          targetWorkerRevision,
          attemptId,
          manifest,
          databaseBytes,
          databasePath: publicationPath,
          publication,
        });
        await finishPlannedRun(coordinator, adapter, state, progress, manifest.database.sha256);
        return {
          providerCostUsd: receiptProviderCostUsd(receipt, budget.maxCostUsd),
          successorHasWork: successor.hasWork,
        };
      } finally {
        publication.close();
      }
    }
    return {
      providerCostUsd: receiptProviderCostUsd(receipt, budget.maxCostUsd),
      successorHasWork: false,
    };
  } catch (error) {
    await progress.blocked();
    throw error;
  } finally {
    tweetStore.close();
  }
}

type VerifiedSuccessor = {
  runId: string;
  planSha256: string;
  hasWork: boolean;
};

function receiptProviderCostUsd(
  receipt: EnrichReceipt,
  enforcedCostCeilingUsd: number | undefined,
): number {
  if (receipt.cost_usd !== undefined) return receipt.cost_usd;
  if (receipt.calls === 0) return 0;
  if (enforcedCostCeilingUsd !== undefined) {
    throw new Error("planned enrichment receipt is missing provider cost");
  }
  return 0;
}

async function ensureSuccessorRun(options: {
  config: ReturnType<typeof loadConfig>;
  log: BucketLog;
  checkpointStore: ReturnType<typeof createEnrichmentCheckpointStore>;
  plan: EnrichmentRunPlan;
  targetWorkerRevision: string;
  attemptId: string;
  manifest: DurableIndexManifest;
  databaseBytes: number;
  databasePath: string;
  publication?: DurableIndex;
}): Promise<VerifiedSuccessor> {
  const predecessorPlanSha256 = parseEnrichmentRunPlan(options.plan).sha256;
  const referenceKey = `${RUN_PREFIX}/${options.plan.run_id}/successor.json`;
  const existing = await options.checkpointStore.read(referenceKey);
  if (existing !== null) {
    const reference = successorReferenceSchema.parse(
      JSON.parse(Buffer.from(existing).toString("utf8")),
    );
    if (
      reference.predecessor_run_id !== options.plan.run_id ||
      reference.predecessor_plan_sha256 !== predecessorPlanSha256
    ) {
      throw new Error("enrichment successor reference predecessor mismatch");
    }
    await activateEnrichmentRun({
      store: options.checkpointStore,
      runId: reference.run_id,
      planSha256: reference.plan_sha256,
      activatedAt: reference.created_at,
      expectedCurrentPlanSha256: predecessorPlanSha256,
    });
    return readVerifiedSuccessor(
      options.checkpointStore,
      reference.run_id,
      reference.plan_sha256,
      options.targetWorkerRevision,
      options.attemptId,
    );
  }

  let publication = options.publication;
  let closePublication = false;
  let successorSourcePath: string | null = null;
  if (publication === undefined) {
    publication = await DurableIndex.restoreReference(
      {
        rawBucket: options.config.rawBucket,
        indexBucket: options.config.indexBucket,
        accessToken: options.config.hfToken,
        databasePath: options.databasePath,
        log: options.log,
        taxonomyVersion: options.config.taxonomyVersion,
        contractHash: options.plan.contract.contract_sha256,
        expectedCurrentDatabaseSha256: options.manifest.database.sha256,
      },
      {
        key: options.manifest.database.key,
        sha256: options.manifest.database.sha256,
        sourceRevision: options.manifest.source.revision,
        predecessorKeys: options.manifest.database.predecessors,
      },
    );
    closePublication = true;
  }
  try {
    const sourceSegmentCount = countRows(publication.store.database, "source_segments");
    const registryRevision = publication.enrichStore.registryRevision();
    const advance = await publication.advanceToLatest();
    const createdAt = new Date().toISOString();
    successorSourcePath = join(
      options.config.dataDir,
      "planned",
      `${options.plan.run_id}-successor-source.sqlite`,
    );
    await rm(successorSourcePath, { force: true });
    await publication.store.database.backup(successorSourcePath);
    const successor = await bootstrapEnrichmentRun({
      sourceDatabasePath: successorSourcePath,
      compactDatabasePath: join(
        options.config.dataDir,
        "planned",
        `${options.plan.run_id}-successor.sqlite`,
      ),
      registryBaselineScanned: options.plan.work.registry_total,
      registryCursor: {
        afterName: null,
        scanned: options.plan.work.registry_total,
        observedAt: options.plan.created_at,
      },
      store: options.checkpointStore,
      attemptId: options.attemptId,
      planInput: {
        schema_version: 1,
        created_at: createdAt,
        source: {
          bucket: options.config.rawBucket,
          snapshot_revision: advance.revision,
          ordered_segments: { key: "replaced", sha256: "0".repeat(64), bytes: 1 },
        },
        contract: successorContractForWorker(options.plan, options.targetWorkerRevision),
        base_index: {
          key: options.manifest.database.key,
          sha256: options.manifest.database.sha256,
          bytes: options.databaseBytes,
          source_revision: options.manifest.source.revision,
          source_segment_count: sourceSegmentCount,
          receipt_count: options.manifest.counts.receipts,
          registry_revision: registryRevision,
        },
      },
    });
    const reference = successorReferenceSchema.parse({
      schema_version: 1,
      predecessor_run_id: options.plan.run_id,
      predecessor_plan_sha256: predecessorPlanSha256,
      run_id: successor.runId,
      plan_sha256: successor.planSha256,
      created_at: createdAt,
    });
    await options.checkpointStore.writeImmutable(referenceKey, canonicalPlanBytes(reference));
    await activateEnrichmentRun({
      store: options.checkpointStore,
      runId: successor.runId,
      planSha256: successor.planSha256,
      activatedAt: createdAt,
      expectedCurrentPlanSha256: predecessorPlanSha256,
    });
    return await readVerifiedSuccessor(
      options.checkpointStore,
      successor.runId,
      successor.planSha256,
      options.targetWorkerRevision,
      options.attemptId,
    );
  } finally {
    if (successorSourcePath !== null) await rm(successorSourcePath, { force: true });
    if (closePublication) publication.close();
  }
}

export function successorContractForWorker(
  plan: EnrichmentRunPlan,
  targetWorkerRevision: string,
): EnrichmentRunPlan["contract"] {
  return { ...plan.contract, worker_revision: targetWorkerRevision };
}

async function readVerifiedSuccessor(
  store: ReturnType<typeof createEnrichmentCheckpointStore>,
  runId: string,
  planSha256: string,
  expectedWorkerRevision: string,
  attemptId: string,
): Promise<VerifiedSuccessor> {
  const bytes = await requiredObject(store, `${RUN_PREFIX}/${runId}/plan.json`);
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const { plan } = parseEnrichmentRunPlan(parsed, planSha256);
  if (plan.run_id !== runId) throw new Error("enrichment successor plan ID mismatch");
  if (plan.contract.worker_revision !== expectedWorkerRevision) {
    throw new Error("enrichment successor worker revision mismatch");
  }
  const adapter = new EnrichmentCheckpointAdapter(
    createEmptyEnrichmentState({
      runId,
      planSha256,
      queueTotal: plan.work.queue_total,
      queueBaselineDone: plan.work.queue_baseline_done,
      registryTotal: plan.work.registry_total,
      registryBaselineScanned: plan.work.registry_baseline_scanned,
    }),
  );
  const coordinator = CheckpointCoordinator.create({
    runId,
    attemptId,
    planSha256,
    store,
    prefix: RUN_PREFIX,
  });
  const restored = await coordinator.restoreLatest(adapter);
  if (restored === null) throw new Error("enrichment successor has no bootstrap checkpoint");
  return { runId, planSha256, hasWork: !runIsComplete(adapter.state) };
}

function countRows(database: Database.Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

async function finishPlannedRun(
  coordinator: CheckpointCoordinator,
  adapter: EnrichmentCheckpointAdapter,
  state: EnrichmentCheckpointState,
  progress: XTapJobProgress,
  databaseSha256: string,
): Promise<void> {
  const finalState = withCheckpointSequence(state, state.sequence + 1);
  adapter.replace(finalState);
  await coordinator.finish(
    {
      name: "complete",
      sequence: finalState.sequence,
      reached_at: new Date().toISOString(),
      metadata: { database_sha256: databaseSha256 },
    },
    adapter,
  );
  await progress.complete();
}

export function applyCheckpointToWorkerDatabase(
  db: Database.Database,
  state: EnrichmentCheckpointState,
): void {
  const queueRows = db
    .prepare("SELECT ordinal, unit_id FROM worker_queue_plan ORDER BY ordinal")
    .all() as { ordinal: number; unit_id: string }[];
  const update = db.prepare(
    `UPDATE enrich_queue SET status = ?, attempts = ?, last_error_class = ?,
       next_retry_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE unit_id = ?`,
  );
  const retrying = new Map(state.queue.retrying.map((record) => [record.ordinal, record]));
  const blocked = new Map(state.queue.blocked.map((record) => [record.ordinal, record]));
  const apply = db.transaction(() => {
    for (const row of queueRows) {
      if (isBitmapCompleted(state.completed_bitmap, row.ordinal)) {
        update.run("done", 0, null, null, row.unit_id);
        continue;
      }
      const retry = retrying.get(row.ordinal);
      if (retry !== undefined) {
        update.run("retrying", retry.attempts, retry.error_class, retry.next_retry_at, row.unit_id);
        continue;
      }
      const stopped = blocked.get(row.ordinal);
      if (stopped !== undefined) {
        update.run("blocked", stopped.attempts, stopped.reason, null, row.unit_id);
      }
    }
  });
  apply();
}

function readQueueOrdinals(db: Database.Database): ReadonlyMap<string, number> {
  const rows = db.prepare("SELECT unit_id, ordinal FROM worker_queue_plan").all() as {
    unit_id: string;
    ordinal: number;
  }[];
  return new Map(rows.map((row) => [row.unit_id, row.ordinal]));
}

function readQueueBaselineOrdinals(db: Database.Database): ReadonlySet<number> {
  const rows = db
    .prepare("SELECT ordinal FROM worker_queue_plan WHERE initial_status = 'done'")
    .all() as { ordinal: number }[];
  return new Set(rows.map((row) => row.ordinal));
}

type FrozenQueueIdentity = {
  inputHash: string;
  taxonomyVersion: number;
  contractHash: string;
};

function readQueueIdentities(
  db: Database.Database,
  contractHash: string,
): ReadonlyMap<string, FrozenQueueIdentity> {
  const rows = db
    .prepare("SELECT unit_id, input_hash, taxonomy_version FROM worker_queue_plan")
    .all() as { unit_id: string; input_hash: string; taxonomy_version: number }[];
  return new Map(
    rows.map((row) => [
      row.unit_id,
      {
        inputHash: row.input_hash,
        taxonomyVersion: row.taxonomy_version,
        contractHash,
      },
    ]),
  );
}

function readRegistryNames(db: Database.Database): readonly string[] {
  const rows = db.prepare("SELECT name FROM worker_registry_plan ORDER BY ordinal").all() as {
    name: string;
  }[];
  return rows.map((row) => row.name);
}

export function applyDurableOutput(
  current: EnrichmentCheckpointState,
  output: DurableWorkerOutput,
  ordinals: ReadonlyMap<string, number>,
  resultSha256: string,
): EnrichmentCheckpointState {
  let next = current;
  if (output.kind === "queue") {
    next = markQueueCompleted(next, requireOrdinals(output.successfulUnitIds, ordinals));
    return advanceOutputFrontier(next, "enrichment", resultSha256);
  }
  if (output.kind === "attempt") {
    next = applyAttemptEvents(next, output, ordinals);
    return advanceOutputFrontier(next, "attempt", resultSha256);
  }
  if (output.kind === "registry") {
    next = advanceRegistryCursor(
      next,
      output.decisions.map((decision) => decision.status),
    );
    return advanceOutputFrontier(next, "registry", resultSha256);
  }
  return advanceOutputFrontier(next, "receipt", resultSha256);
}

function applyAttemptEvents(
  current: EnrichmentCheckpointState,
  output: Extract<DurableWorkerOutput, { kind: "attempt" }>,
  ordinals: ReadonlyMap<string, number>,
): EnrichmentCheckpointState {
  let next = current;
  for (const event of output.events) {
    const ordinal = requireOrdinal(event.unit_id, ordinals);
    next =
      event.outcome === "blocked"
        ? recordQueueAttempt(next, {
            status: "blocked",
            value: {
              ordinal,
              attempts: event.attempt,
              reason: event.error_class ?? event.outcome,
              evidence_sha256: rawSegmentSha256(output.segmentKey),
            },
          })
        : recordQueueAttempt(next, {
            status: "retrying",
            value: {
              ordinal,
              attempts: event.attempt,
              error_class: event.error_class ?? event.outcome,
              next_retry_at: event.next_retry_at ?? null,
            },
          });
  }
  return next;
}

async function restoreAndReconcileWorkerOutputs(options: {
  log: BucketLog;
  sourceSegments: readonly BucketSnapshotFile[];
  checkpointStore: CheckpointObjectStore;
  rejectUncheckpointedResults?: boolean;
  runId: string;
  state: () => EnrichmentCheckpointState;
  commitOutputs?: (outputs: readonly DurableWorkerOutput[]) => Promise<void>;
  registryNames: readonly string[];
  registryBaselineOrdinal: number;
  queueBaselineOrdinals: ReadonlySet<number>;
  queueIdentities: ReadonlyMap<string, FrozenQueueIdentity>;
  contractHash: string;
  tweetStore: TweetStore;
  enrichStore: EnrichStore;
  outputClaimsProgress: (completed: number, total: number) => Promise<void>;
  replayProgress: (completed: number, total: number) => Promise<void>;
}): Promise<{ claimedSegments: number; orphanSegments: number }> {
  const claimedKeys = await readRunOutputKeys(
    options.checkpointStore,
    options.runId,
    options.state(),
    {
      queue: options.queueBaselineOrdinals,
      registry: options.registryBaselineOrdinal,
    },
    {
      concurrency: 16,
      progress: options.outputClaimsProgress,
      rejectUncheckpointedResults: options.rejectUncheckpointedResults ?? false,
    },
  );
  const claimed = new Set(claimedKeys);
  const seen = new Set<string>();
  const sourceFiles = new Map(options.sourceSegments.map((file) => [file.key, file]));
  let claimedSegments = 0;
  let orphanSegments = 0;
  for (const key of claimedKeys) {
    const file = sourceFiles.get(key);
    if (file === undefined) continue;
    const segment = await options.log.loadSegment(file);
    applyClaimedWorkerSegments([segment], options.log, options.tweetStore, options.enrichStore);
    seen.add(key);
    claimedSegments += 1;
  }
  await options.log.replayVerifiedTail(options.sourceSegments, {
    concurrency: 16,
    progress: options.replayProgress,
    consume: async (file, segment) => {
      if (claimed.has(file.key)) {
        applyClaimedWorkerSegments([segment], options.log, options.tweetStore, options.enrichStore);
        seen.add(file.key);
        claimedSegments += 1;
        return;
      }
      const outputs = outputsFromSegment(
        segment,
        options.registryNames,
        options.state().registry.next_ordinal - options.registryBaselineOrdinal,
        options.queueIdentities,
        options.contractHash,
      );
      if (outputs.length === 0) return;
      orphanSegments += 1;
      if (options.commitOutputs === undefined) return;
      await options.commitOutputs(outputs.map((output) => withSegmentKey(output, file.key)));
      applyClaimedWorkerSegments([segment], options.log, options.tweetStore, options.enrichStore);
    },
  });
  const missing = claimedKeys.find((key) => !seen.has(key));
  if (missing !== undefined) throw new Error(`claimed raw output segment is missing: ${missing}`);
  return { claimedSegments, orphanSegments };
}

export function applyClaimedWorkerSegments(
  segments: readonly BucketSegment[],
  log: BucketLog,
  tweetStore: TweetStore,
  enrichStore: EnrichStore,
): void {
  for (const segment of segments) log.applySegment(segment, tweetStore, enrichStore);
}

type RecoveredOutput =
  | { kind: "queue"; successfulUnitIds: readonly string[] }
  | { kind: "attempt"; events: readonly AttemptEvent[] }
  | { kind: "registry"; decisions: readonly FreeLabelEvent[] }
  | { kind: "receipt" };

function withSegmentKey(output: RecoveredOutput, segmentKey: string): DurableWorkerOutput {
  if (output.kind === "queue") return { ...output, segmentKey };
  if (output.kind === "attempt") return { ...output, segmentKey };
  if (output.kind === "registry") return { ...output, segmentKey };
  return { kind: "receipt", segmentKey };
}

// eslint-disable-next-line complexity -- Reconciliation validates each persisted output category independently.
export function outputsFromSegment(
  segment: BucketSegment,
  registryNames: readonly string[],
  registryNextOrdinal: number,
  queueIdentities: ReadonlyMap<string, FrozenQueueIdentity>,
  contractHash: string,
): RecoveredOutput[] {
  const successful = new Set<string>();
  const attempts: AttemptEvent[] = [];
  const decisions: FreeLabelEvent[] = [];
  let hasReceipt = false;
  if (registryNextOrdinal < 0 || registryNextOrdinal > registryNames.length) {
    throw new Error("registry reconciliation cursor is outside the frozen plan");
  }
  const remainingNames = new Set(registryNames.slice(registryNextOrdinal));
  for (const operation of segment.operations) {
    if (operation.mode !== "append") continue;
    for (const line of operation.lines) {
      const candidate: unknown = JSON.parse(line);
      if (operation.path.startsWith("enrichment/attempts/")) {
        const event = attemptEventSchema.parse(candidate);
        const identity = queueIdentities.get(event.unit_id);
        if (identity === undefined) continue;
        if (
          event.input_hash !== identity.inputHash ||
          event.contract_hash !== identity.contractHash
        ) {
          throw new Error("orphan attempt does not match the frozen queue identity");
        }
        if (event.outcome !== "success") attempts.push(event);
      } else if (operation.path.startsWith("enrichment/registry/")) {
        const event = freeLabelEventSchema.parse(candidate);
        if (event.contract_hash !== contractHash) {
          throw new Error("orphan registry event does not match the frozen contract");
        }
        if (remainingNames.has(event.name)) decisions.push(event);
      } else if (operation.path.startsWith("enrichment/receipts/")) {
        const receipt = parseEnrichReceipt(candidate);
        if (receipt?.contract_hash === contractHash) hasReceipt = true;
      } else if (operation.path.startsWith("enrichment/")) {
        const row = parseEnrichmentRow(candidate);
        if (row === undefined) continue;
        const identity = queueIdentities.get(row.unit_id);
        if (identity === undefined) continue;
        if (
          row.input_hash !== identity.inputHash ||
          row.contract_hash !== identity.contractHash ||
          row.taxonomy_version !== identity.taxonomyVersion
        ) {
          throw new Error("orphan enrichment does not match the frozen queue identity");
        }
        successful.add(row.unit_id);
      }
    }
  }
  const outputs: RecoveredOutput[] = [];
  if (successful.size > 0) {
    outputs.push({ kind: "queue", successfulUnitIds: [...successful].sort() });
  }
  if (attempts.length > 0) outputs.push({ kind: "attempt", events: attempts });
  if (decisions.length > 0) outputs.push({ kind: "registry", decisions });
  if (hasReceipt) outputs.push({ kind: "receipt" });
  return outputs;
}

export function parseSourceSegments(bytes: Uint8Array): BucketSnapshotFile[] {
  const candidate: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const rows = z.array(sourceSegmentSchema).parse(candidate);
  return rows.map((row) => ({
    key: row.key,
    oid: row.oid,
    ...(row.listed_oid === null ? {} : { listed_oid: row.listed_oid }),
    size: row.byte_length,
    content_sha256: row.content_sha256,
  }));
}

// eslint-disable-next-line complexity -- Publication verifies every claimed result chain before applying raw segments.
export async function readRunOutputKeys(
  store: CheckpointObjectStore,
  runId: string,
  state: EnrichmentCheckpointState,
  baseline: { queue: ReadonlySet<number>; registry: number },
  options: {
    concurrency: number;
    progress?: (completed: number, total: number) => Promise<void>;
    rejectUncheckpointedResults?: boolean;
  } = { concurrency: 1 },
): Promise<readonly string[]> {
  validateOutputBaselines(state, baseline);
  const prefix = `${RUN_PREFIX}/${runId}/batches/`;
  const keys = (await store.list(prefix)).filter((key) => key.endsWith("/result.json"));
  const results = await mapBatchesInOrder({
    inputs: keys,
    concurrency: options.concurrency,
    operation: async (key) => {
      const bytes = await requiredObject(store, key);
      const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return {
        result: enrichmentBatchResultSchema.parse(value),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  });
  const raw = new Set<string>();
  const completedQueueOrdinals = new Set<number>();
  let nextRegistryOrdinal = baseline.registry;
  const chains = new Map<OutputKind, { sequence: number; sha256: string | null }>();
  for (const { result, sha256: resultSha256 } of results) {
    if (result.run_id !== runId) throw new Error("batch result run ID mismatch");
    const frontierKind: OutputKind = result.phase === "queue" ? "enrichment" : result.phase;
    if (result.sequence > state.outputs[frontierKind].sequence) {
      if (options.rejectUncheckpointedResults === true) {
        throw new Error(`uncheckpointed ${frontierKind} result manifest`);
      }
      continue;
    }
    const previous = chains.get(frontierKind) ?? { sequence: 0, sha256: null };
    if (
      result.sequence !== previous.sequence + 1 ||
      result.previous_result_sha256 !== previous.sha256
    ) {
      throw new Error(`broken ${frontierKind} result chain`);
    }
    validateClaimedResultOrdinals({
      result,
      state,
      queueBaselineOrdinals: baseline.queue,
      completedQueueOrdinals,
      nextRegistryOrdinal,
    });
    if (result.phase === "registry") nextRegistryOrdinal += result.ordinals.length;
    chains.set(frontierKind, {
      sequence: result.sequence,
      sha256: resultSha256,
    });
    if (result.raw_segment_sha256 !== rawSegmentSha256(result.raw_segment_key)) {
      throw new Error("batch result raw segment SHA-256 mismatch");
    }
    raw.add(result.raw_segment_key);
  }
  if (completedQueueOrdinals.size !== state.queue.done - baseline.queue.size) {
    throw new Error("queue result ordinals do not match the checkpoint bitmap");
  }
  if (nextRegistryOrdinal !== state.registry.next_ordinal) {
    throw new Error("registry result ordinals do not match the checkpoint cursor");
  }
  for (const kind of ["enrichment", "attempt", "registry", "receipt"] as const) {
    const actual = chains.get(kind) ?? { sequence: 0, sha256: null };
    const expected = state.outputs[kind];
    if (actual.sequence !== expected.sequence || actual.sha256 !== expected.chain_sha256) {
      throw new Error(`missing ${kind} result manifest`);
    }
  }
  return [...raw].sort();
}

// eslint-disable-next-line complexity -- Baseline validation checks numeric bounds and every imported completion bit.
function validateOutputBaselines(
  state: EnrichmentCheckpointState,
  baseline: { queue: ReadonlySet<number>; registry: number },
): void {
  if (baseline.queue.size > state.queue.done) {
    throw new Error("queue output baseline is invalid");
  }
  if (
    !Number.isSafeInteger(baseline.registry) ||
    baseline.registry < 0 ||
    baseline.registry > state.registry.next_ordinal
  ) {
    throw new Error("registry output baseline is invalid");
  }
  for (const ordinal of baseline.queue) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= state.queue.total) {
      throw new Error("queue output baseline is invalid");
    }
    if (!isBitmapCompleted(state.completed_bitmap, ordinal)) {
      throw new Error("queue output baseline is not completed in the checkpoint bitmap");
    }
  }
}

// eslint-disable-next-line complexity -- Each result phase has separate exact ordinal invariants.
function validateClaimedResultOrdinals(options: {
  result: z.infer<typeof enrichmentBatchResultSchema>;
  state: EnrichmentCheckpointState;
  queueBaselineOrdinals: ReadonlySet<number>;
  completedQueueOrdinals: Set<number>;
  nextRegistryOrdinal: number;
}): void {
  const { result, state } = options;
  if (result.phase === "queue") {
    for (const ordinal of result.ordinals) {
      if (
        options.queueBaselineOrdinals.has(ordinal) ||
        ordinal >= state.queue.total ||
        !isBitmapCompleted(state.completed_bitmap, ordinal) ||
        options.completedQueueOrdinals.has(ordinal)
      ) {
        throw new Error("queue result ordinal does not match the checkpoint bitmap");
      }
      options.completedQueueOrdinals.add(ordinal);
    }
    return;
  }
  if (result.phase === "registry") {
    for (const [offset, ordinal] of result.ordinals.entries()) {
      if (
        ordinal !== options.nextRegistryOrdinal + offset ||
        ordinal >= state.registry.next_ordinal
      ) {
        throw new Error("registry result ordinals are not a contiguous checkpoint prefix");
      }
    }
    return;
  }
  if (result.phase === "attempt") {
    if (result.ordinals.some((ordinal) => ordinal < 0 || ordinal >= state.queue.total)) {
      throw new Error("attempt result ordinal is outside the frozen queue");
    }
    return;
  }
  if (result.ordinals.length > 0) {
    throw new Error("receipt result must not claim work ordinals");
  }
}

function outputOrdinals(
  output: DurableWorkerOutput,
  ordinals: ReadonlyMap<string, number>,
  registryNames: readonly string[],
  registryNextOrdinal: number,
  registryBaselineOrdinal: number,
): number[] {
  if (output.kind === "queue") return requireOrdinals(output.successfulUnitIds, ordinals);
  if (output.kind === "attempt") {
    return requireOrdinals(
      output.events.map((event) => event.unit_id),
      ordinals,
    );
  }
  if (output.kind === "registry") {
    return registryOutputOrdinals(
      output.decisions,
      registryNames,
      registryNextOrdinal,
      registryBaselineOrdinal,
    );
  }
  return [];
}

export function registryOutputOrdinals(
  decisions: readonly FreeLabelEvent[],
  registryNames: readonly string[],
  registryNextOrdinal: number,
  registryBaselineOrdinal: number,
): number[] {
  return decisions.map((decision, offset) => {
    const ordinal = registryNextOrdinal + offset;
    if (registryNames[ordinal - registryBaselineOrdinal] !== decision.name) {
      throw new Error("registry result does not match the frozen ordinal");
    }
    return ordinal;
  });
}

function requireOrdinals(
  unitIds: readonly string[],
  ordinals: ReadonlyMap<string, number>,
): number[] {
  return unitIds
    .map((unitId) => requireOrdinal(unitId, ordinals))
    .sort((left, right) => left - right);
}

function requireOrdinal(unitId: string, ordinals: ReadonlyMap<string, number>): number {
  const ordinal = ordinals.get(unitId);
  if (ordinal === undefined) throw new Error(`unit is outside the frozen plan: ${unitId}`);
  return ordinal;
}

export function runIsComplete(state: EnrichmentCheckpointState): boolean {
  return (
    state.queue.done + state.queue.blocked.length === state.queue.total &&
    state.queue.retrying.length === 0 &&
    state.registry.next_ordinal === state.registry.total
  );
}

function rawSegmentCreatedAt(key: string): string {
  const value = SEGMENT_TIME.exec(key)?.[1];
  if (value === undefined) throw new Error(`raw segment key has no timestamp: ${key}`);
  return new Date(Number(value)).toISOString();
}

function rawSegmentSha256(key: string): string {
  const value = SEGMENT_SHA256.exec(key)?.[1];
  if (value === undefined) throw new Error(`raw segment key has no SHA-256: ${key}`);
  return value;
}

function isBitmapCompleted(bitmap: Uint8Array, ordinal: number): boolean {
  return ((bitmap[Math.floor(ordinal / 8)] ?? 0) & (1 << (ordinal % 8))) !== 0;
}

async function requiredObject(store: CheckpointObjectStore, key: string): Promise<Uint8Array> {
  const value = await store.read(key);
  if (value === null) throw new Error(`required enrichment object is missing: ${key}`);
  return value;
}

function verifyObject(value: Uint8Array, bytes: number, sha256: string, name: string): void {
  if (value.byteLength !== bytes) throw new Error(`${name} byte count mismatch`);
  if (createHash("sha256").update(value).digest("hex") !== sha256) {
    throw new Error(`${name} SHA-256 mismatch`);
  }
}

function requireEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
