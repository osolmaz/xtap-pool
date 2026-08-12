import { join } from "node:path";

import { DEFAULT_ENRICHMENT_MODEL } from "@xtap-pool/shared";
import { z } from "zod";

import { BucketLog, createRawBucketClient } from "./bucket-log.js";
import { DurableIndex } from "./durable-index.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import { contractHashFor } from "./enrich-worker.js";

const schema = z.object({
  DATA_DIR: z.string().default(".data"),
  RAW_BUCKET: z.string().min(1),
  INDEX_BUCKET: z.string().min(1),
  HF_TOKEN: z.string().min(1),
  LLM_MODEL: z.string().min(1).default(DEFAULT_ENRICHMENT_MODEL),
  TAXONOMY_VERSION: z.coerce.number().int().min(1).default(1),
});

/** Explicit full replay used to seed or repair the Bucket-backed index. */
export async function runIndexCommand(env: Record<string, string | undefined>): Promise<void> {
  const config = schema.parse(env);
  const log = new BucketLog(
    config.RAW_BUCKET,
    createRawBucketClient(config.RAW_BUCKET, config.HF_TOKEN),
    join(config.DATA_DIR, "index-bootstrap-cache"),
  );
  const taxonomy = await loadEnrichTaxonomy(log, config.TAXONOMY_VERSION);
  if (taxonomy.error !== undefined)
    throw new Error(`enrichment taxonomy unavailable: ${taxonomy.error}`);
  const contractHash = contractHashFor({ taxonomy, model: config.LLM_MODEL });
  const index = await DurableIndex.bootstrap({
    rawBucket: config.RAW_BUCKET,
    indexBucket: config.INDEX_BUCKET,
    accessToken: config.HF_TOKEN,
    databasePath: join(config.DATA_DIR, "index", "bootstrap.sqlite"),
    log,
    taxonomyVersion: config.TAXONOMY_VERSION,
    contractHash,
  });
  try {
    const { manifest } = await index.publishLatest();
    console.log(
      `[xtap-pool index] published ${manifest.database.sha256} at ${manifest.source.revision}; tweets=${String(manifest.counts.tweets)} enrichments=${String(manifest.counts.enrichments)}`,
    );
  } finally {
    index.close();
  }
}
