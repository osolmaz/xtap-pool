import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";
import { CheckpointCoordinator } from "@osolmaz/hf-job-control";
import {
  attemptEventSchema,
  freeLabelEventSchema,
  parseEnrichReceipt,
  parseEnrichmentRow,
} from "@xtap-pool/shared";
import type { AttemptEvent, FreeLabelEvent } from "@xtap-pool/shared";

import { activateEnrichmentRun, resolveActiveEnrichmentRun } from "./enrich-active-run.js";
import { bootstrapEnrichmentRun } from "./bootstrap-enrichment-run.js";
import { BucketLog, createRawBucketClient } from "./bucket-log.js";
import type { BucketSegment, BucketSnapshotFile } from "./bucket-log.js";
import { loadConfig } from "./config.js";
import { durableIndexManifestSchema, DurableIndex } from "./durable-index.js";
import type { DurableIndexManifest } from "./durable-index.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import {
  createEnrichmentCheckpointStore,
  EnrichmentCheckpointAdapter,
} from "./enrich-checkpoint.js";
import { enrichmentBatchResultSchema, publishEnrichmentBatchResult } from "./enrich-batch.js";
import { canonicalPlanBytes, parseEnrichmentRunPlan } from "./enrich-run-plan.js";
import type { EnrichmentRunPlan } from "./enrich-run-plan.js";
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
  contractHashFor,
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

// eslint-disable-next-line complexity -- The command owns ordered restore, work, checkpoint, and publication stages.
export async function runPlannedEnrichmentCommand(
  env: Record<string, string | undefined>,
): Promise<void> {
  const commandStartedAtMs = Date.now();
  const config = loadConfig(env);
  if (!config.enrichEnabled || config.inferenceToken === undefined) {
    throw new Error("planned enrichment requires ENRICH_ENABLED and INFERENCE_TOKEN");
  }
  const checkpointStore = createEnrichmentCheckpointStore({
    bucket: config.indexBucket,
    accessToken: config.hfToken,
  });
  const activeRun = await resolveActiveEnrichmentRun(checkpointStore);
  const runId = activeRun.run_id;
  const planSha256 = activeRun.plan_sha256;
  const planPath = `${RUN_PREFIX}/${runId}/plan.json`;
  const planBytes = await requiredObject(checkpointStore, planPath);
  const parsedPlan: unknown = JSON.parse(Buffer.from(planBytes).toString("utf8"));
  const { plan } = parseEnrichmentRunPlan(parsedPlan, planSha256);
  if (plan.run_id !== runId) throw new Error("active enrichment run ID mismatch");
  if (plan.contract.worker_revision !== requireEnvironment(env, "XTAP_SOURCE_REVISION")) {
    throw new Error("planned enrichment worker revision does not match running code");
  }
  const workBytes = await requiredObject(checkpointStore, plan.work.key);
  verifyObject(workBytes, plan.work.bytes, plan.work.sha256, "enrichment work plan");
  const sourceSegmentsBytes = await requiredObject(
    checkpointStore,
    plan.source.ordered_segments.key,
  );
  verifyObject(
    sourceSegmentsBytes,
    plan.source.ordered_segments.bytes,
    plan.source.ordered_segments.sha256,
    "ordered source segments",
  );
  const sourceSegments = parseSourceSegments(sourceSegmentsBytes);
  const workPath = join(config.dataDir, "planned", `${runId}.sqlite`);
  await mkdir(dirname(workPath), { recursive: true });
  await rm(workPath, { force: true });
  await writeFile(workPath, workBytes);

  const log = new BucketLog(
    config.rawBucket,
    createRawBucketClient(config.rawBucket, config.hfToken),
    join(config.dataDir, "planned-raw-cache"),
  );
  const taxonomy = await loadEnrichTaxonomy(log, config.taxonomyVersion);
  if (taxonomy.error !== undefined) throw new Error(`taxonomy unavailable: ${taxonomy.error}`);
  const contractHash = contractHashFor({ taxonomy, model: config.llmModel });
  if (contractHash !== plan.contract.contract_sha256) {
    throw new Error("planned enrichment contract does not match running code");
  }
  const tweetStore = new TweetStore(workPath);
  const enrichStore = new EnrichStore(
    tweetStore.database,
    taxonomy.version,
    () => new Date(),
    contractHash,
  );
  const initialState = createEmptyEnrichmentState({
    runId,
    planSha256,
    queueTotal: plan.work.queue_total,
    queueBaselineDone: plan.work.queue_baseline_done,
    registryTotal: plan.work.registry_total,
    registryBaselineScanned: plan.work.registry_baseline_scanned,
  });
  const adapter = new EnrichmentCheckpointAdapter(initialState);
  const attemptId = env["JOB_ID"] ?? `local-${process.pid.toString()}`;
  const coordinator = CheckpointCoordinator.create({
    runId,
    attemptId,
    ...(env["JOB_ID"] === undefined ? {} : { jobId: env["JOB_ID"] }),
    planSha256,
    store: checkpointStore,
    prefix: RUN_PREFIX,
  });
  const restored = await coordinator.restoreLatest(adapter);
  if (restored === null) throw new Error("planned enrichment has no bootstrap checkpoint");
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
  applyCheckpointToWorkerDatabase(tweetStore.database, state);
  const ordinals = readQueueOrdinals(tweetStore.database);
  const queueIdentities = readQueueIdentities(tweetStore.database, contractHash);
  const registryNames = readRegistryNames(tweetStore.database);
  const progress = await XTapJobProgress.create({
    bucket: config.indexBucket,
    accessToken: config.hfToken,
    sourceRevision: plan.source.snapshot_revision,
    contractHash,
    env: { ...env, XTAP_PROGRESS_RUN_ID: runId },
  });

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

  await reconcileOrphanOutputs({
    log,
    sourceSegments,
    checkpointStore,
    runId,
    state: () => state,
    commitOutputs,
    registryNames,
    registryBaselineOrdinal: plan.work.registry_baseline_scanned,
    queueIdentities,
    contractHash,
  });
  applyCheckpointToWorkerDatabase(tweetStore.database, state);

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
      await ensureSuccessorRun({
        config,
        log,
        checkpointStore,
        plan,
        attemptId,
        manifest,
        databaseBytes,
        databasePath: resumePath,
      });
      await finishPlannedRun(coordinator, adapter, state, progress, manifest.database.sha256);
      return;
    }
    if (state.publication.state === "published") {
      const manifest = state.publication.manifest;
      const databaseBytes = state.publication.database_bytes;
      if (manifest === null || databaseBytes === null) {
        throw new Error("published database reference is incomplete");
      }
      await ensureSuccessorRun({
        config,
        log,
        checkpointStore,
        plan,
        attemptId,
        manifest,
        databaseBytes,
        databasePath: join(config.dataDir, "planned", `${runId}-published.sqlite`),
      });
      await finishPlannedRun(coordinator, adapter, state, progress, manifest.database.sha256);
      return;
    }

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
    await runEnrichTick({
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
          ...(await readRunOutputKeys(checkpointStore, runId, state)),
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
        await ensureSuccessorRun({
          config,
          log,
          checkpointStore,
          plan,
          attemptId,
          manifest,
          databaseBytes,
          databasePath: publicationPath,
          publication,
        });
        await finishPlannedRun(coordinator, adapter, state, progress, manifest.database.sha256);
      } finally {
        publication.close();
      }
    }
  } catch (error) {
    await progress.blocked();
    throw error;
  } finally {
    tweetStore.close();
  }
}

async function ensureSuccessorRun(options: {
  config: ReturnType<typeof loadConfig>;
  log: BucketLog;
  checkpointStore: ReturnType<typeof createEnrichmentCheckpointStore>;
  plan: EnrichmentRunPlan;
  attemptId: string;
  manifest: DurableIndexManifest;
  databaseBytes: number;
  databasePath: string;
  publication?: DurableIndex;
}): Promise<void> {
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
    return;
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
      registryBaselineScanned: 0,
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
        contract: options.plan.contract,
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
  } finally {
    if (successorSourcePath !== null) await rm(successorSourcePath, { force: true });
    if (closePublication) publication.close();
  }
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

async function reconcileOrphanOutputs(options: {
  log: BucketLog;
  sourceSegments: readonly BucketSnapshotFile[];
  checkpointStore: ReturnType<typeof createEnrichmentCheckpointStore>;
  runId: string;
  state: () => EnrichmentCheckpointState;
  commitOutputs: (outputs: readonly DurableWorkerOutput[]) => Promise<void>;
  registryNames: readonly string[];
  registryBaselineOrdinal: number;
  queueIdentities: ReadonlyMap<string, FrozenQueueIdentity>;
  contractHash: string;
}): Promise<void> {
  const processed = new Set(
    await readRunOutputKeys(options.checkpointStore, options.runId, options.state()),
  );
  const known = new Set(options.sourceSegments.map((file) => file.key));
  const discovered = await options.log.discoverSnapshot(options.sourceSegments);
  const newFiles = discovered.snapshot.files.filter(
    (file) => !known.has(file.key) && !processed.has(file.key),
  );
  for (const file of newFiles) {
    const segment = await options.log.loadSegment(file);
    const outputs = outputsFromSegment(
      segment,
      options.registryNames,
      options.state().registry.next_ordinal - options.registryBaselineOrdinal,
      options.queueIdentities,
      options.contractHash,
    );
    if (outputs.length > 0) {
      await options.commitOutputs(outputs.map((output) => withSegmentKey(output, file.key)));
    }
  }
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
async function readRunOutputKeys(
  store: ReturnType<typeof createEnrichmentCheckpointStore>,
  runId: string,
  state: EnrichmentCheckpointState,
): Promise<readonly string[]> {
  const prefix = `${RUN_PREFIX}/${runId}/batches/`;
  const keys = await store.list(prefix);
  const raw = new Set<string>();
  const chains = new Map<OutputKind, { sequence: number; sha256: string | null }>();
  for (const key of keys) {
    if (!key.endsWith("/result.json")) continue;
    const bytes = await requiredObject(store, key);
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const result = enrichmentBatchResultSchema.parse(value);
    if (result.run_id !== runId) throw new Error("batch result run ID mismatch");
    const frontierKind: OutputKind = result.phase === "queue" ? "enrichment" : result.phase;
    if (result.sequence > state.outputs[frontierKind].sequence) continue;
    const previous = chains.get(frontierKind) ?? { sequence: 0, sha256: null };
    if (
      result.sequence !== previous.sequence + 1 ||
      result.previous_result_sha256 !== previous.sha256
    ) {
      throw new Error(`broken ${frontierKind} result chain`);
    }
    chains.set(frontierKind, {
      sequence: result.sequence,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    raw.add(result.raw_segment_key);
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

async function requiredObject(
  store: ReturnType<typeof createEnrichmentCheckpointStore>,
  key: string,
): Promise<Uint8Array> {
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
