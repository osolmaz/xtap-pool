import type { BucketLog, BucketSnapshot } from "./bucket-log.js";
import { loadEnrichTaxonomy } from "./enrich-config.js";
import type { EnrichTaxonomy } from "./enrich-config.js";
import { contractHashFor } from "./enrich-worker.js";

/** Resolve the taxonomy authenticated by one immutable plan or index contract. */
export async function resolveEnrichmentTaxonomyForContract(options: {
  log: Pick<BucketLog, "primeTextCacheFromLatestWrites" | "readText">;
  snapshot: BucketSnapshot;
  taxonomyVersion: number;
  llmModel: string;
  expectedContractHash: string;
  concurrency: number;
  progress?: (completed: number, total: number) => Promise<void>;
}): Promise<{ taxonomy: EnrichTaxonomy; contractHash: string }> {
  await options.log.primeTextCacheFromLatestWrites(
    options.snapshot,
    options.concurrency,
    options.progress,
  );
  const taxonomy = await loadEnrichTaxonomy(options.log, options.taxonomyVersion);
  if (taxonomy.error !== undefined) throw new Error(`taxonomy unavailable: ${taxonomy.error}`);
  const contractHash = contractHashFor({ taxonomy, model: options.llmModel });
  if (contractHash !== options.expectedContractHash) {
    throw new Error("taxonomy-derived contract does not match the authenticated contract");
  }
  return { taxonomy, contractHash };
}
