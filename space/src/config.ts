import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(7860),
  DATA_DIR: z.string().default(".data"),
  DATASET_REPO: z.string().min(1),
  HF_TOKEN: z.string().min(1),
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
  ENRICH_MAX_UNITS_PER_TICK: z.coerce.number().int().positive().default(100),
  LLM_MODEL: z.string().min(1).default("zai-org/GLM-5.2"),
  TAXONOMY_VERSION: z.coerce.number().int().min(1).default(1),
});

export type SpaceConfig = {
  port: number;
  dataDir: string;
  datasetRepo: string;
  hfToken: string;
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
  enrichMaxUnitsPerTick: number;
  llmModel: string;
  taxonomyVersion: number;
};

/** Parse and normalize configuration from environment variables. Throws on invalid config. */
export function loadConfig(env: Record<string, string | undefined>): SpaceConfig {
  const parsed = configSchema.parse(env);
  const host = parsed.SPACE_HOST.replace(/\/+$/, "");
  const allowedUsers = users(parsed.ALLOWED_USERS);
  const poolAdmins = users(parsed.POOL_ADMINS);
  return {
    port: parsed.PORT,
    dataDir: parsed.DATA_DIR,
    datasetRepo: parsed.DATASET_REPO,
    hfToken: parsed.HF_TOKEN,
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
    enrichMaxUnitsPerTick: parsed.ENRICH_MAX_UNITS_PER_TICK,
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
