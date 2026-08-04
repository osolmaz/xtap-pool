import { join } from "node:path";

import { DEFAULT_ENRICHMENT_MODEL } from "@xtap-pool/shared";
import { z } from "zod";

import { createHubClient, DatasetMirror } from "./dataset.js";
import { DurableIndex } from "./durable-index.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import { contractHashFor } from "./enrich-worker.js";

const indexCommandConfigSchema = z.object({
  DATA_DIR: z.string().default(".data"),
  DATASET_REPO: z.string().min(1),
  INDEX_BUCKET: z.string().min(1),
  HF_TOKEN: z.string().min(1),
  LLM_MODEL: z.string().min(1).default(DEFAULT_ENRICHMENT_MODEL),
  TAXONOMY_VERSION: z.coerce.number().int().min(1).default(1),
});

/** Explicit full replay used to seed or repair the durable enrichment index. */
export async function runIndexCommand(env: Record<string, string | undefined>): Promise<void> {
  const config = indexCommandConfigSchema.parse(env);
  const hub = createHubClient(config.DATASET_REPO, config.HF_TOKEN);
  const mirror = new DatasetMirror(hub, join(config.DATA_DIR, "index-bootstrap-mirror"));
  const taxonomy = await loadEnrichTaxonomy(mirror, config.TAXONOMY_VERSION);
  if (taxonomy.error !== undefined) {
    throw new Error(`enrichment taxonomy unavailable: ${taxonomy.error}`);
  }
  const contractHash = contractHashFor({ taxonomy, model: config.LLM_MODEL });
  const index = await DurableIndex.bootstrap({
    datasetRepo: config.DATASET_REPO,
    indexBucket: config.INDEX_BUCKET,
    accessToken: config.HF_TOKEN,
    databasePath: join(config.DATA_DIR, "index", "bootstrap.sqlite"),
    mirror,
    taxonomyVersion: config.TAXONOMY_VERSION,
    contractHash,
  });
  try {
    const { manifest } = await index.publishLatest();
    const stats = index.stats();
    console.log(
      `[xtap-pool index] published ${manifest.database.sha256} at ` +
        `${manifest.dataset.revision}; tweets=${String(stats.tweetRows)} ` +
        `enrichments=${String(stats.enrichmentRows)} attempts=${String(stats.attemptEvents)}`,
    );
  } finally {
    index.close();
  }
}
