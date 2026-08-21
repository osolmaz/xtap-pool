import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { bucketSnapshotSchema, BucketLog, createRawBucketReader } from "./bucket-log.js";
import {
  compactEnrichmentWorkDatabase,
  registryCandidateIsPending,
} from "./bootstrap-enrichment-run.js";
import type { RegistryImportCursor } from "./bootstrap-enrichment-run.js";
import type { EnrichmentRunPlanInput } from "./enrich-run-plan.js";
import { canonicalPlanBytes } from "./enrich-run-plan.js";
import {
  createDurableIndexBucketReader,
  durableIndexManifestSchema,
  DurableIndex,
} from "./durable-index.js";
import {
  resolveEnrichmentTaxonomyAfterTail,
  resolveEnrichmentTaxonomyForContract,
} from "./enrich-taxonomy-contract.js";

const CURRENT_MANIFEST_KEY = "index/current.json";
const RUN_PREFIX = "operations/enrichment/runs";

export type BootstrapProgress = {
  stage:
    | "manifest"
    | "database"
    | "snapshot"
    | "metadata"
    | "source"
    | "taxonomy-base"
    | "taxonomy-final"
    | "contract"
    | "projection"
    | "candidate";
  completed: number;
  total: number;
  unit: "items" | "bytes";
  elapsedMs: number;
};

export type BootstrapCandidate = {
  schema_version: 1;
  pointer_sha256: string;
  run_object_count: number;
  base_database: {
    key: string;
    sha256: string;
    bytes: number;
    source_revision: string;
    source_segment_count: number;
    receipt_count: number;
    registry_revision: number;
  };
  source: {
    bucket: string;
    snapshot_revision: string;
    files_changed: number;
    rows_applied: number;
  };
  contract: {
    worker_revision: string;
    contract_sha256: string;
    taxonomy_version: number;
    model: string;
    provider: string;
  };
  queue: {
    base_total: number;
    total: number;
    baseline_done: number;
    done: number;
    unresolved: number;
  };
  registry: {
    base_total: number;
    base_scanned: number;
    total: number;
    baseline_scanned: number;
    revision: number;
  };
  compact_database: { sha256: string; bytes: number };
  candidate_sha256: string;
};

export type PreparedEnrichmentBootstrap = {
  candidate: BootstrapCandidate;
  pointerBytes: string;
  sourceDatabasePath: string;
  compactDatabasePath: string;
  planInput: Omit<EnrichmentRunPlanInput, "work">;
  registryCursor?: RegistryImportCursor;
};

// eslint-disable-next-line complexity -- Preparation verifies each independent production identity before producing a candidate.
export async function prepareEnrichmentBootstrap(options: {
  rawBucket: string;
  indexBucket: string;
  accessToken: string;
  dataDir: string;
  taxonomyVersion: number;
  llmModel: string;
  workerRevision: string;
  sourceReplayConcurrency?: number;
  progress?: (progress: BootstrapProgress) => Promise<void>;
}): Promise<PreparedEnrichmentBootstrap> {
  const started = Date.now();
  const emit = async (
    stage: BootstrapProgress["stage"],
    completed: number,
    total: number,
    unit: BootstrapProgress["unit"],
  ): Promise<void> =>
    options.progress?.({ stage, completed, total, unit, elapsedMs: Date.now() - started });
  await mkdir(options.dataDir, { recursive: true });
  const rawReader = createRawBucketReader(options.rawBucket, options.accessToken);
  const indexReader = createDurableIndexBucketReader(options.indexBucket, options.accessToken);

  const pointerBytes = await indexReader.readText(CURRENT_MANIFEST_KEY);
  if (pointerBytes === undefined) throw new Error("durable index manifest is missing");
  const manifest = durableIndexManifestSchema.parse(JSON.parse(pointerBytes) as unknown);
  if (manifest.source.bucket !== options.rawBucket) {
    throw new Error("durable index manifest raw Bucket does not match bootstrap input");
  }
  await emit("manifest", 1, 1, "items");

  const snapshotBytes = await rawReader.download(`v1/snapshots/${manifest.source.revision}.json`);
  if (snapshotBytes === undefined) throw new Error("validated raw snapshot is missing");
  if (sha256(snapshotBytes) !== manifest.source.revision) {
    throw new Error("validated raw snapshot checksum mismatch");
  }
  const snapshot = bucketSnapshotSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes)) as unknown,
  );
  if (snapshot.bucket !== options.rawBucket)
    throw new Error("validated raw snapshot Bucket mismatch");
  await emit("snapshot", snapshot.files.length, snapshot.files.length, "items");

  const log = new BucketLog(options.rawBucket, rawReader, join(options.dataDir, "raw-cache"));
  const verifiedBasePath = join(options.dataDir, "base.sqlite");
  const sourceDatabasePath = join(options.dataDir, "source.sqlite");
  const compactionSourcePath = join(options.dataDir, "compaction-source.sqlite");
  const compactDatabasePath = join(options.dataDir, "work-plan.sqlite");
  const index = await DurableIndex.restoreReferenceReadOnly(
    {
      rawBucket: options.rawBucket,
      indexBucket: options.indexBucket,
      accessToken: options.accessToken,
      databasePath: sourceDatabasePath,
      log,
      taxonomyVersion: options.taxonomyVersion,
      contractHash: manifest.projection.contract_hash,
      bucketClient: indexReader,
      reuseVerifiedDatabase: true,
      verifiedBasePath,
      ...(options.sourceReplayConcurrency === undefined
        ? {}
        : { sourceReplayConcurrency: options.sourceReplayConcurrency }),
      progress: {
        restoreDatabase: async (completed, total) => emit("database", completed, total, "bytes"),
        metadataReplay: async (completed, total) => emit("metadata", completed, total, "items"),
        sourceReplay: async ({ completed, total }) => emit("source", completed, total, "items"),
        databaseBuild: () => Promise.resolve(),
        databaseUpload: () => Promise.resolve(),
        databaseVerify: () => Promise.resolve(),
        manifestPublished: () => Promise.resolve(),
      },
    },
    {
      key: manifest.database.key,
      sha256: manifest.database.sha256,
      sourceRevision: manifest.source.revision,
      predecessorKeys: manifest.database.predecessors,
    },
  );
  try {
    const { taxonomy: baseTaxonomy, contractHash: baseContractHash } =
      await resolveEnrichmentTaxonomyForContract({
        log,
        snapshot,
        taxonomyVersion: options.taxonomyVersion,
        llmModel: options.llmModel,
        expectedContractHash: manifest.projection.contract_hash,
        concurrency: options.sourceReplayConcurrency ?? 1,
        progress: async (completed, total) => emit("taxonomy-base", completed, total, "items"),
      });

    const baseDatabaseBytes = (await stat(sourceDatabasePath)).size;
    const baseSourceSegmentCount = (
      index.store.database.prepare("SELECT COUNT(*) AS count FROM source_segments").get() as {
        count: number;
      }
    ).count;
    const baseRegistryRevision = index.enrichStore.registryRevision();
    const baseRegistryCursor = registryCursorFromReceipt(log.latestReceipt());
    const baseWork = inspectBaseWork(index.store.database, baseRegistryCursor);
    const advance = await index.advanceToLatest();
    const registryCursor = registryCursorFromReceipt(log.latestReceipt());
    const { contractHash } = await resolveEnrichmentTaxonomyAfterTail({
      log,
      baseSnapshot: snapshot,
      finalSnapshot: advance.snapshot,
      baseTaxonomy,
      taxonomyVersion: options.taxonomyVersion,
      llmModel: options.llmModel,
      expectedContractHash: manifest.projection.contract_hash,
      concurrency: options.sourceReplayConcurrency ?? 1,
      progress: async (completed, total) => emit("taxonomy-final", completed, total, "items"),
    });
    if (contractHash !== baseContractHash) {
      throw new Error("final source taxonomy contract differs from the validated base contract");
    }
    await emit("contract", 1, 1, "items");
    await index.createWorkingCopy(compactionSourcePath);
    const compact = await compactEnrichmentWorkDatabase({
      sourcePath: compactionSourcePath,
      destinationPath: compactDatabasePath,
      registryBaselineScanned: registryCursor?.scanned ?? 0,
      ...(registryCursor === undefined ? {} : { registryCursor }),
    });
    await emit("projection", 1, 1, "items");

    const compactBytes = (await stat(compactDatabasePath)).size;
    const compactSha256 = await fileSha256(compactDatabasePath);
    const runObjects = await indexReader.list(RUN_PREFIX);
    const provider = options.llmModel.split(":")[1] ?? "huggingface-router";
    const identity = {
      schema_version: 1 as const,
      pointer_sha256: sha256(new TextEncoder().encode(pointerBytes)),
      run_object_count: runObjects.length,
      base_database: {
        key: manifest.database.key,
        sha256: manifest.database.sha256,
        bytes: baseDatabaseBytes,
        source_revision: manifest.source.revision,
        source_segment_count: baseSourceSegmentCount,
        receipt_count: manifest.counts.receipts,
        registry_revision: baseRegistryRevision,
      },
      source: {
        bucket: options.rawBucket,
        snapshot_revision: advance.revision,
        files_changed: advance.filesChanged,
        rows_applied: advance.rowsApplied,
      },
      contract: {
        worker_revision: options.workerRevision,
        contract_sha256: contractHash,
        taxonomy_version: options.taxonomyVersion,
        model: options.llmModel,
        provider,
      },
      queue: {
        base_total: baseWork.queueTotal,
        total: compact.queueTotal,
        baseline_done: baseWork.queueDone,
        done: compact.queueBaselineDone,
        unresolved: compact.retainedQueueUnits,
      },
      registry: {
        base_total: baseWork.registryTotal,
        base_scanned: baseRegistryCursor?.scanned ?? 0,
        total: compact.registryTotal,
        baseline_scanned: registryCursor?.scanned ?? 0,
        revision: index.enrichStore.registryRevision(),
      },
      compact_database: { sha256: compactSha256, bytes: compactBytes },
    };
    const candidateSha256 = sha256(canonicalPlanBytes(identity));
    const candidate: BootstrapCandidate = { ...identity, candidate_sha256: candidateSha256 };
    await emit("candidate", 1, 1, "items");
    const planInput: Omit<EnrichmentRunPlanInput, "work"> = {
      schema_version: 1,
      created_at: new Date().toISOString(),
      source: {
        bucket: options.rawBucket,
        snapshot_revision: advance.revision,
        ordered_segments: { key: "replaced", sha256: "0".repeat(64), bytes: 1 },
      },
      contract: candidate.contract,
      base_index: candidate.base_database,
    };
    return {
      candidate,
      pointerBytes,
      sourceDatabasePath,
      compactDatabasePath,
      planInput,
      ...(registryCursor === undefined ? {} : { registryCursor }),
    };
  } finally {
    index.close();
  }
}

function registryCursorFromReceipt(
  receipt: ReturnType<BucketLog["latestReceipt"]>,
): RegistryImportCursor | undefined {
  const registryScan = receipt?.registry_scan;
  return receipt !== undefined &&
    registryScan !== undefined &&
    registryScan.scanned > 0 &&
    typeof registryScan.after_name === "string"
    ? {
        afterName: registryScan.after_name,
        scanned: registryScan.scanned,
        observedAt: receipt.finished_at,
      }
    : undefined;
}

function inspectBaseWork(
  database: Database.Database,
  registryCursor: RegistryImportCursor | undefined,
): { queueTotal: number; queueDone: number; registryTotal: number } {
  const queue = database
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
       FROM enrich_queue`,
    )
    .get() as { total: number; done: number };
  const candidates = database
    .prepare(
      `SELECT name, first_observed_at
       FROM free_label_registry WHERE status = 'candidate' ORDER BY name`,
    )
    .all() as { name: string; first_observed_at: string }[];
  const pending = candidates.filter((candidate) =>
    registryCandidateIsPending(candidate, registryCursor),
  ).length;
  return {
    queueTotal: queue.total,
    queueDone: queue.done,
    registryTotal: (registryCursor?.scanned ?? 0) + pending,
  };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
