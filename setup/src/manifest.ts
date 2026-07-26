import { existingSpaceConfig } from "./config.js";
import type { SetupConfig } from "./config.js";

export type PoolManifest = SetupConfig & {
  requiredVariables: readonly string[];
  requiredSecrets: readonly string[];
  credentialRoles: {
    dataset: "HF_TOKEN";
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
    requiredVariables: ["DATASET_REPO", "ALLOWED_USERS", "POOL_ADMINS"],
    requiredSecrets: enrichmentEnabled
      ? ["HF_TOKEN", "INFERENCE_TOKEN", "POOL_SIGNING_SECRET", "SESSION_SECRET"]
      : ["HF_TOKEN", "POOL_SIGNING_SECRET", "SESSION_SECRET"],
    credentialRoles: { dataset: "HF_TOKEN", inference: "INFERENCE_TOKEN" },
    enrichmentEnabled,
  };
}

function parseEnrichmentEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`ENRICH_ENABLED must be 'true' or 'false', got '${value}'.`);
}
