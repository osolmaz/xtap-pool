import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  durableIndexManifestSchema,
  createDurableIndexBucketClient,
  DurableIndex,
} from "./durable-index.js";
import { activateEnrichmentRun } from "./enrich-active-run.js";
import { bootstrapEnrichmentRun } from "./bootstrap-enrichment-run.js";
import { BucketLog, createRawBucketClient } from "./bucket-log.js";
import { loadConfig } from "./config.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import { createEnrichmentCheckpointStore } from "./enrich-checkpoint.js";
import { contractHashFor } from "./enrich-worker.js";

const CURRENT_MANIFEST_KEY = "index/current.json";

// eslint-disable-next-line complexity -- Bootstrap verifies every production identity before isolated writes.
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const workerRevision = requireEnvironment(process.env, "XTAP_SOURCE_REVISION");
  const attemptId = process.env["JOB_ID"] ?? `bootstrap-${process.pid.toString()}`;
  const dataDir = join(config.dataDir, "bootstrap-run");
  await mkdir(dataDir, { recursive: true });
  const log = new BucketLog(
    config.rawBucket,
    createRawBucketClient(config.rawBucket, config.hfToken),
    join(dataDir, "raw-cache"),
  );
  const taxonomy = await loadEnrichTaxonomy(log, config.taxonomyVersion);
  if (taxonomy.error !== undefined) throw new Error(`taxonomy unavailable: ${taxonomy.error}`);
  const contractHash = contractHashFor({ taxonomy, model: config.llmModel });
  const bucket = createDurableIndexBucketClient(config.indexBucket, config.hfToken);
  const before = await bucket.readText(CURRENT_MANIFEST_KEY);
  if (before === undefined) throw new Error("durable index manifest is missing");
  const manifest = durableIndexManifestSchema.parse(JSON.parse(before) as unknown);
  if (
    manifest.source.bucket !== config.rawBucket ||
    manifest.projection.contract_hash !== contractHash
  ) {
    throw new Error("durable index manifest does not match bootstrap contract");
  }
  const sourceDatabasePath = join(dataDir, "source.sqlite");
  const index = await DurableIndex.restoreReference(
    {
      rawBucket: config.rawBucket,
      indexBucket: config.indexBucket,
      accessToken: config.hfToken,
      databasePath: sourceDatabasePath,
      log,
      taxonomyVersion: config.taxonomyVersion,
      contractHash,
      bucketClient: bucket,
    },
    {
      key: manifest.database.key,
      sha256: manifest.database.sha256,
      sourceRevision: manifest.source.revision,
      predecessorKeys: manifest.database.predecessors,
    },
  );
  try {
    const baseDatabaseBytes = (await stat(sourceDatabasePath)).size;
    const baseSourceSegmentCount = (
      index.store.database.prepare("SELECT COUNT(*) AS count FROM source_segments").get() as {
        count: number;
      }
    ).count;
    const baseRegistryRevision = index.enrichStore.registryRevision();
    const advance = await index.advanceToLatest();
    const registryBaselineScanned = log.latestReceipt()?.registry_scan?.scanned ?? 0;
    const checkpointStore = createEnrichmentCheckpointStore({
      bucket: config.indexBucket,
      accessToken: config.hfToken,
    });
    const result = await bootstrapEnrichmentRun({
      sourceDatabasePath,
      compactDatabasePath: join(dataDir, "work-plan.sqlite"),
      registryBaselineScanned,
      store: checkpointStore,
      attemptId,
      ...(process.env["JOB_ID"] === undefined ? {} : { jobId: process.env["JOB_ID"] }),
      planInput: {
        schema_version: 1,
        created_at: new Date().toISOString(),
        source: {
          bucket: config.rawBucket,
          snapshot_revision: advance.revision,
          ordered_segments: { key: "replaced", sha256: "0".repeat(64), bytes: 1 },
        },
        contract: {
          worker_revision: workerRevision,
          contract_sha256: contractHash,
          taxonomy_version: config.taxonomyVersion,
          model: config.llmModel,
          provider: config.llmModel.split(":")[1] ?? "huggingface-router",
        },
        base_index: {
          key: manifest.database.key,
          sha256: manifest.database.sha256,
          bytes: baseDatabaseBytes,
          source_segment_count: baseSourceSegmentCount,
          receipt_count: manifest.counts.receipts,
          registry_revision: baseRegistryRevision,
        },
      },
    });
    await activateEnrichmentRun({
      store: checkpointStore,
      runId: result.runId,
      planSha256: result.planSha256,
      activatedAt: new Date().toISOString(),
    });
    const after = await bucket.readText(CURRENT_MANIFEST_KEY);
    if (after !== before) throw new Error("durable index changed during bootstrap import");
    console.log(JSON.stringify(result));
  } finally {
    index.close();
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

try {
  await main();
} catch (error) {
  console.error(
    `[xtap-pool bootstrap] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
