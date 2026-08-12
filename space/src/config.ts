import { DEFAULT_ENRICHMENT_MODEL } from "@xtap-pool/shared";
import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(7860),
  DATA_DIR: z.string().default(".data"),
  RAW_BUCKET: z.string().min(1),
  INDEX_BUCKET: z.string().min(1),
  HF_TOKEN: z.string().min(1),
  INFERENCE_TOKEN: z.string().min(1).optional(),
  POOL_SIGNING_SECRET: z.string().min(32),
  SESSION_SECRET: z.string().min(32),
  ALLOWED_USERS: z.string().min(1),
  POOL_ADMINS: z.string().default(""),
  OAUTH_CLIENT_ID: z.string().min(1),
  OAUTH_CLIENT_SECRET: z.string().min(1),
  OPENID_PROVIDER_URL: z.string().default("https://huggingface.co"),
  SPACE_HOST: z.string().min(1),
  STATIC_ROOT: z.string().default("../explorer/dist"),
  ENRICH_ENABLED: z.enum(["true", "false"]).default("false"),
  ENRICH_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  ENRICH_MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).max(32).default(1),
  ENRICH_MAX_ELAPSED_MS: z.coerce.number().int().positive().optional(),
  ENRICH_MAX_ERROR_RATE: z.coerce.number().min(0).max(1).optional(),
  ENRICH_MAX_COST_USD: z.coerce.number().positive().optional(),
  ENRICH_MAX_COST_PER_CALL_USD: z.coerce.number().positive().optional(),
  ENRICH_INPUT_TOKEN_USD: z.coerce.number().nonnegative().optional(),
  ENRICH_OUTPUT_TOKEN_USD: z.coerce.number().nonnegative().optional(),
  ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT: z.coerce.number().nonnegative().optional(),
  ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS: z.coerce.number().int().positive().optional(),
  LLM_MODEL: z.string().min(1).default(DEFAULT_ENRICHMENT_MODEL),
  TAXONOMY_VERSION: z.coerce.number().int().min(1).default(1),
});

export type SpaceConfig = {
  port: number;
  dataDir: string;
  rawBucket: string;
  indexBucket: string;
  hfToken: string;
  inferenceToken?: string;
  poolSigningSecret: string;
  sessionSecret: string;
  allowedUsers: readonly string[];
  poolAdmins: readonly string[];
  oauthClientId: string;
  oauthClientSecret: string;
  openidProviderUrl: string;
  /** Public base URL of the Space, e.g. `https://user-xtap-pool.hf.space`. */
  publicUrl: string;
  staticRoot: string;
  enrichEnabled: boolean;
  enrichIntervalMs: number;
  enrichMaxConcurrentCalls: number;
  enrichMaxElapsedMs?: number;
  enrichMaxErrorRate?: number;
  enrichMaxCostUsd?: number;
  enrichMaxCostPerCallUsd?: number;
  enrichInputTokenUsd?: number;
  enrichOutputTokenUsd?: number;
  enrichMaxDiscardedAssignmentsPerUnit?: number;
  enrichDiscardedAssignmentRateMinUnits?: number;
  llmModel: string;
  taxonomyVersion: number;
};

/** Parse and normalize configuration from environment variables. Throws on invalid config. */
// eslint-disable-next-line complexity -- Cross-field credential, pricing, and ceiling invariants are validated at one configuration boundary.
export function loadConfig(env: Record<string, string | undefined>): SpaceConfig {
  const parsed = configSchema.parse(env);
  if (parsed.ENRICH_ENABLED === "true" && parsed.INFERENCE_TOKEN === undefined) {
    throw new Error("INFERENCE_TOKEN is required when ENRICH_ENABLED=true.");
  }
  if (
    parsed.ENRICH_MAX_COST_USD !== undefined &&
    (parsed.ENRICH_MAX_COST_PER_CALL_USD === undefined ||
      parsed.ENRICH_INPUT_TOKEN_USD === undefined ||
      parsed.ENRICH_OUTPUT_TOKEN_USD === undefined)
  ) {
    throw new Error(
      "ENRICH_MAX_COST_USD requires ENRICH_MAX_COST_PER_CALL_USD, ENRICH_INPUT_TOKEN_USD and ENRICH_OUTPUT_TOKEN_USD.",
    );
  }
  if (
    (parsed.ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT === undefined) !==
    (parsed.ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS === undefined)
  ) {
    throw new Error(
      "ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT and ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS must be configured together.",
    );
  }
  const host = parsed.SPACE_HOST.replace(/\/+$/, "");
  const allowedUsers = users(parsed.ALLOWED_USERS);
  const poolAdmins = users(parsed.POOL_ADMINS);
  return {
    port: parsed.PORT,
    dataDir: parsed.DATA_DIR,
    rawBucket: parsed.RAW_BUCKET,
    indexBucket: parsed.INDEX_BUCKET,
    hfToken: parsed.HF_TOKEN,
    ...(parsed.INFERENCE_TOKEN === undefined ? {} : { inferenceToken: parsed.INFERENCE_TOKEN }),
    poolSigningSecret: parsed.POOL_SIGNING_SECRET,
    sessionSecret: parsed.SESSION_SECRET,
    allowedUsers,
    poolAdmins: poolAdmins.length > 0 ? poolAdmins : allowedUsers.slice(0, 1),
    oauthClientId: parsed.OAUTH_CLIENT_ID,
    oauthClientSecret: parsed.OAUTH_CLIENT_SECRET,
    openidProviderUrl: parsed.OPENID_PROVIDER_URL.replace(/\/+$/, ""),
    publicUrl: host.startsWith("http") ? host : `https://${host}`,
    staticRoot: parsed.STATIC_ROOT,
    enrichEnabled: parsed.ENRICH_ENABLED === "true",
    enrichIntervalMs: parsed.ENRICH_INTERVAL_MS,
    enrichMaxConcurrentCalls: parsed.ENRICH_MAX_CONCURRENT_CALLS,
    ...(parsed.ENRICH_MAX_ELAPSED_MS === undefined
      ? {}
      : { enrichMaxElapsedMs: parsed.ENRICH_MAX_ELAPSED_MS }),
    ...(parsed.ENRICH_MAX_ERROR_RATE === undefined
      ? {}
      : { enrichMaxErrorRate: parsed.ENRICH_MAX_ERROR_RATE }),
    ...(parsed.ENRICH_MAX_COST_USD === undefined
      ? {}
      : { enrichMaxCostUsd: parsed.ENRICH_MAX_COST_USD }),
    ...(parsed.ENRICH_MAX_COST_PER_CALL_USD === undefined
      ? {}
      : { enrichMaxCostPerCallUsd: parsed.ENRICH_MAX_COST_PER_CALL_USD }),
    ...(parsed.ENRICH_INPUT_TOKEN_USD === undefined
      ? {}
      : { enrichInputTokenUsd: parsed.ENRICH_INPUT_TOKEN_USD }),
    ...(parsed.ENRICH_OUTPUT_TOKEN_USD === undefined
      ? {}
      : { enrichOutputTokenUsd: parsed.ENRICH_OUTPUT_TOKEN_USD }),
    ...(parsed.ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT === undefined
      ? {}
      : {
          enrichMaxDiscardedAssignmentsPerUnit: parsed.ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT,
        }),
    ...(parsed.ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS === undefined
      ? {}
      : {
          enrichDiscardedAssignmentRateMinUnits: parsed.ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS,
        }),
    llmModel: parsed.LLM_MODEL,
    taxonomyVersion: parsed.TAXONOMY_VERSION,
  };
}

function users(value: string): string[] {
  return value
    .split(",")
    .map((user) => user.trim())
    .filter((user) => user.length > 0);
}
