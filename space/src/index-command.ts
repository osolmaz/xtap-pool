import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_ENRICHMENT_MODEL } from "@xtap-pool/shared";
import { z } from "zod";

import { BucketLog, canonicalBytes, createRawBucketClient, sha256 } from "./bucket-log.js";
import {
  createDurableIndexBucketClient,
  durableIndexManifestSchema,
  DurableIndex,
} from "./durable-index.js";
import type { DurableIndexManifest, DurableIndexOptions } from "./durable-index.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import { contractHashFor } from "./enrich-worker.js";
import { prepareIndexBootstrap } from "./index-bootstrap.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const schema = z.object({
  DATA_DIR: z.string().default(".data"),
  RAW_BUCKET: z.string().min(1),
  INDEX_BUCKET: z.string().min(1),
  HF_TOKEN: z.string().min(1),
  LLM_MODEL: z.string().min(1).optional(),
  TAXONOMY_VERSION: z.coerce.number().int().min(1).default(1),
  INDEX_BOOTSTRAP_MODE: z.enum(["prepare", "publish"]).default("prepare"),
  INDEX_BOOTSTRAP_SOURCE: hash.optional(),
  INDEX_BOOTSTRAP_EXPECTED_DATABASE: hash.optional(),
  INDEX_BOOTSTRAP_MAX_SEGMENTS: z.coerce.number().int().positive().optional(),
  INDEX_BOOTSTRAP_CHUNK_SIZE: z.coerce.number().int().min(1).max(500).default(128),
  INDEX_BOOTSTRAP_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
});
type Config = z.infer<typeof schema>;

/** Explicit resumable CPU replay. Preparation never publishes a database. */
export async function runIndexCommand(
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<void> {
  const config = schema.parse(env);
  const log = new BucketLog(
    config.RAW_BUCKET,
    createRawBucketClient(config.RAW_BUCKET, config.HF_TOKEN),
    join(config.DATA_DIR, "index-bootstrap-cache"),
  );
  const bucket = createDurableIndexBucketClient(config.INDEX_BUCKET, config.HF_TOKEN);
  const rawManifest = await bucket.readText("index/current.json");
  const current =
    rawManifest === undefined
      ? undefined
      : durableIndexManifestSchema.parse(JSON.parse(rawManifest));
  const contractHash = await bootstrapContract(config, log, current);
  const options: DurableIndexOptions = {
    rawBucket: config.RAW_BUCKET,
    indexBucket: config.INDEX_BUCKET,
    accessToken: config.HF_TOKEN,
    databasePath: join(config.DATA_DIR, "index", "bootstrap.sqlite"),
    log,
    bucketClient: bucket,
    taxonomyVersion: config.TAXONOMY_VERSION,
    contractHash,
    sourceReplayConcurrency: config.INDEX_BOOTSTRAP_CONCURRENCY,
    predecessorKeys:
      current === undefined ? [] : [current.database.key, ...current.database.predecessors],
    ...(config.INDEX_BOOTSTRAP_EXPECTED_DATABASE === undefined
      ? {}
      : {
          expectedCurrentDatabaseSha256: config.INDEX_BOOTSTRAP_EXPECTED_DATABASE,
        }),
  };
  if (config.INDEX_BOOTSTRAP_MODE === "publish") {
    assertPublishPredecessor(config, current);
    await publishPreparedIndex(options, signal);
    return;
  }
  const sourceRevision = await bootstrapSource(config, options, current);
  const result = await prepareIndexBootstrap({
    ...options,
    sourceRevision,
    chunkSize: config.INDEX_BOOTSTRAP_CHUNK_SIZE,
    ...(config.INDEX_BOOTSTRAP_MAX_SEGMENTS === undefined
      ? {}
      : { maxSegments: config.INDEX_BOOTSTRAP_MAX_SEGMENTS }),
    ...(signal === undefined ? {} : { signal }),
    onCheckpoint: (progress) => {
      console.log(JSON.stringify({ state: "checkpoint", ...progress }));
      return Promise.resolve();
    },
  });
  try {
    console.log(
      JSON.stringify({
        state: result.complete ? "prepared" : "paused",
        ...result.progress,
        counts: result.index.stats(),
      }),
    );
  } finally {
    result.index.close();
  }
}

async function bootstrapContract(
  config: Config,
  log: BucketLog,
  current: DurableIndexManifest | undefined,
): Promise<string> {
  if (current !== undefined) {
    if (current.source.bucket !== config.RAW_BUCKET)
      throw new Error("bootstrap source Bucket mismatch");
    if (config.LLM_MODEL !== undefined)
      throw new Error(
        "an existing index bootstrap reuses its recorded classifier contract; omit LLM_MODEL",
      );
    return current.projection.contract_hash;
  }
  const taxonomy = await loadEnrichTaxonomy(log, config.TAXONOMY_VERSION);
  if (taxonomy.error !== undefined)
    throw new Error(`enrichment taxonomy unavailable: ${taxonomy.error}`);
  return contractHashFor({ taxonomy, model: config.LLM_MODEL ?? DEFAULT_ENRICHMENT_MODEL });
}

async function bootstrapSource(
  config: Config,
  options: DurableIndexOptions,
  current: DurableIndexManifest | undefined,
): Promise<string> {
  if (config.INDEX_BOOTSTRAP_SOURCE !== undefined) return config.INDEX_BOOTSTRAP_SOURCE;
  const frozen = `${options.databasePath}.source.json`;
  if (existsSync(frozen)) return sha256(await readFile(frozen));
  return current?.source.revision ?? (await options.log.createSnapshot()).revision;
}

function assertPublishPredecessor(config: Config, current: DurableIndexManifest | undefined): void {
  if (current === undefined) {
    if (config.INDEX_BOOTSTRAP_EXPECTED_DATABASE !== undefined)
      throw new Error("expected bootstrap predecessor is missing");
  } else if (config.INDEX_BOOTSTRAP_EXPECTED_DATABASE !== current.database.sha256) {
    throw new Error(
      "publication requires INDEX_BOOTSTRAP_EXPECTED_DATABASE to match the current index; stop other publishers before cutover",
    );
  }
}

async function publishPreparedIndex(
  options: DurableIndexOptions,
  signal?: AbortSignal,
): Promise<void> {
  const source = sha256(await readFile(`${options.databasePath}.source.json`));
  const target = await options.log.loadSnapshot(source);
  const index = DurableIndex.openLocal(options);
  try {
    index.verify();
    const applied = new Map(
      index.sourceSnapshot().files.map((file) => [file.key, sha256(canonicalBytes(file))]),
    );
    if (target.files.some((file) => applied.get(file.key) !== sha256(canonicalBytes(file))))
      throw new Error("bootstrap is incomplete; finish preparation before publishing");
    if (signal?.aborted) throw new Error("bootstrap publication aborted before source advance");
    await index.advanceToLatest();
    if (signal?.aborted) throw new Error("bootstrap publication aborted before upload");
    const manifest = await index.publish();
    console.log(
      JSON.stringify({
        state: "published",
        source: manifest.source.revision,
        database: manifest.database.sha256,
        counts: manifest.counts,
      }),
    );
  } finally {
    index.close();
  }
}
