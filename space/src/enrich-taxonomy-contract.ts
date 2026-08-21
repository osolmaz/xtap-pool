import type { BucketLog, BucketSnapshot } from "./bucket-log.js";
import {
  LABELS_CONFIG_PATH,
  DEFAULT_TAXONOMY,
  loadEnrichTaxonomy,
  parseEnrichTaxonomyText,
} from "./enrich-config.js";
import type { EnrichTaxonomy } from "./enrich-config.js";
import { contractHashFor } from "./enrich-worker.js";

/** Resolve the taxonomy authenticated by one immutable plan or index contract. */
export async function resolveEnrichmentTaxonomyForContract(options: {
  log: Pick<BucketLog, "readText">;
  snapshot: BucketSnapshot;
  taxonomyVersion: number;
  llmModel: string;
  expectedContractHash: string;
  concurrency: number;
  progress?: (completed: number, total: number) => Promise<void>;
}): Promise<{ taxonomy: EnrichTaxonomy; contractHash: string }> {
  const fallback: EnrichTaxonomy = {
    labels: DEFAULT_TAXONOMY,
    version: options.taxonomyVersion,
    source: "default",
  };
  const fallbackContractHash = contractHashFor({ taxonomy: fallback, model: options.llmModel });
  if (fallbackContractHash === options.expectedContractHash) {
    await options.progress?.(1, 1);
    return { taxonomy: fallback, contractHash: fallbackContractHash };
  }

  const taxonomy = await loadEnrichTaxonomy(options.log, options.taxonomyVersion, {
    snapshot: options.snapshot,
    concurrency: options.concurrency,
    ...(options.progress === undefined ? {} : { progress: options.progress }),
  });
  if (taxonomy.error !== undefined) throw new Error(`taxonomy unavailable: ${taxonomy.error}`);
  const contractHash = contractHashFor({ taxonomy, model: options.llmModel });
  if (contractHash !== options.expectedContractHash) {
    throw new Error("taxonomy-derived contract does not match the authenticated contract");
  }
  return { taxonomy, contractHash };
}

/** Apply only post-snapshot configuration writes before accepting a bootstrap contract. */
// eslint-disable-next-line complexity -- Tail validation checks immutable base membership, configuration deltas, and contract identity.
export async function resolveEnrichmentTaxonomyAfterTail(options: {
  log: Pick<BucketLog, "readText">;
  baseSnapshot: BucketSnapshot;
  finalSnapshot: BucketSnapshot;
  baseTaxonomy: EnrichTaxonomy;
  taxonomyVersion: number;
  llmModel: string;
  expectedContractHash: string;
  concurrency: number;
  progress?: (completed: number, total: number) => Promise<void>;
}): Promise<{ taxonomy: EnrichTaxonomy; contractHash: string }> {
  const finalByKey = new Map(options.finalSnapshot.files.map((file) => [file.key, file]));
  for (const baseFile of options.baseSnapshot.files) {
    const finalFile = finalByKey.get(baseFile.key);
    if (finalFile === undefined || JSON.stringify(finalFile) !== JSON.stringify(baseFile)) {
      throw new Error(`validated base source changed before bootstrap: ${baseFile.key}`);
    }
  }
  const baseKeys = new Set(options.baseSnapshot.files.map((file) => file.key));
  const configTail = options.finalSnapshot.files.filter(
    (file) =>
      !baseKeys.has(file.key) && (file.key.includes("/config/") || file.key.includes("/mixed/")),
  );
  let taxonomy = options.baseTaxonomy;
  if (configTail.length === 0) {
    await options.progress?.(0, 0);
  } else {
    const raw = await options.log.readText(LABELS_CONFIG_PATH, {
      snapshot: options.finalSnapshot,
      concurrency: options.concurrency,
      ...(options.progress === undefined ? {} : { progress: options.progress }),
    });
    if (raw !== undefined) taxonomy = parseEnrichTaxonomyText(raw, options.taxonomyVersion);
  }
  const contractHash = contractHashFor({ taxonomy, model: options.llmModel });
  if (contractHash !== options.expectedContractHash) {
    throw new Error("post-snapshot taxonomy changes the authenticated contract");
  }
  return { taxonomy, contractHash };
}
