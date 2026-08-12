import { existingSpaceConfig } from "./config.js";
import type { SetupConfig } from "./config.js";
import { ENRICHMENT_JOB_DEFAULT_VARIABLES } from "./enrichment-job.js";

export type PoolManifest = SetupConfig & {
  requiredVariables: readonly string[];
  requiredSecrets: readonly string[];
  credentialRoles: {
    storage: "HF_TOKEN";
    inference: "INFERENCE_TOKEN";
  };
  enrichmentEnabled: boolean;
};

/** Desired state for one deployed pool, derived from current Space variables. */
export function manifestFromSpace(
  username: string,
  spaceRepo: string,
  variables: ReadonlyMap<string, string>,
): PoolManifest {
  const config = existingSpaceConfig(username, spaceRepo, variables);
  const enrichmentEnabled = parseEnrichmentEnabled(variables.get("ENRICH_ENABLED"));
  return {
    ...config,
    requiredVariables: [
      "RAW_BUCKET",
      "INDEX_BUCKET",
      "ALLOWED_USERS",
      "POOL_ADMINS",
      "ENRICH_ENABLED",
      ...Object.keys(ENRICHMENT_JOB_DEFAULT_VARIABLES),
    ],
    requiredSecrets: ["HF_TOKEN", "POOL_SIGNING_SECRET", "SESSION_SECRET"],
    credentialRoles: { storage: "HF_TOKEN", inference: "INFERENCE_TOKEN" },
    enrichmentEnabled,
  };
}

function parseEnrichmentEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`ENRICH_ENABLED must be 'true' or 'false', got '${value}'.`);
}
