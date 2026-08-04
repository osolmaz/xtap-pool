import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const baseEnv = {
  DATASET_REPO: "osolmaz/xtap-pool-data",
  INDEX_BUCKET: "osolmaz/xtap-pool-bucket",
  HF_TOKEN: "hf_x",
  POOL_SIGNING_SECRET: "pool-secret-0123456789abcdef0123456789abcdef",
  SESSION_SECRET: "session-secret-0123456789abcdef0123456789ab",
  ALLOWED_USERS: "osolmaz, alice ,bob,",
  POOL_ADMINS: "osolmaz",
  OAUTH_CLIENT_ID: "cid",
  OAUTH_CLIENT_SECRET: "csecret",
  SPACE_HOST: "dutifuldev-xtap-pool.hf.space",
};

describe("loadConfig", () => {
  it("parses a full environment with defaults", () => {
    const config = loadConfig(baseEnv);
    expect(config.port).toBe(7860);
    expect(config.indexBucket).toBe("osolmaz/xtap-pool-bucket");
    expect(config.allowedUsers).toEqual(["osolmaz", "alice", "bob"]);
    expect(config.poolAdmins).toEqual(["osolmaz"]);
    expect(config.publicUrl).toBe("https://dutifuldev-xtap-pool.hf.space");
    expect(config.openidProviderUrl).toBe("https://huggingface.co");
  });

  it("defaults pool admins to the first allowed user", () => {
    const config = loadConfig({ ...baseEnv, POOL_ADMINS: "" });
    expect(config.poolAdmins).toEqual(["osolmaz"]);
  });

  it("keeps explicit scheme and strips trailing slashes", () => {
    const config = loadConfig({
      ...baseEnv,
      SPACE_HOST: "http://localhost:7860/",
      OPENID_PROVIDER_URL: "https://huggingface.co/",
      PORT: "8080",
    });
    expect(config.publicUrl).toBe("http://localhost:7860");
    expect(config.openidProviderUrl).toBe("https://huggingface.co");
    expect(config.port).toBe(8080);
  });

  it("rejects missing required settings and short secrets", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ ...baseEnv, POOL_SIGNING_SECRET: "short" })).toThrow();
    expect(() => loadConfig({ ...baseEnv, HF_TOKEN: "" })).toThrow();
  });

  it("defaults the enrichment settings with the worker off", () => {
    const config = loadConfig(baseEnv);
    expect(config.enrichEnabled).toBe(false);
    expect(config.enrichIntervalMs).toBe(60000);
    expect(config.enrichMaxConcurrentCalls).toBe(1);
    expect(config.llmModel).toBe("zai-org/GLM-5.2");
    expect(config.taxonomyVersion).toBe(1);
  });

  it("parses explicit enrichment settings", () => {
    const config = loadConfig({
      ...baseEnv,
      ENRICH_ENABLED: "true",
      INFERENCE_TOKEN: "hf_inference",
      ENRICH_INTERVAL_MS: "5000",
      ENRICH_MAX_CONCURRENT_CALLS: "32",
      ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT: "0.15",
      ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS: "200",
      LLM_MODEL: "meta-llama/Llama-4",
      TAXONOMY_VERSION: "3",
    });
    expect(config.enrichEnabled).toBe(true);
    expect(config.inferenceToken).toBe("hf_inference");
    expect(config.enrichIntervalMs).toBe(5000);
    expect(config.enrichMaxConcurrentCalls).toBe(32);
    expect(config.enrichMaxDiscardedAssignmentsPerUnit).toBe(0.15);
    expect(config.enrichDiscardedAssignmentRateMinUnits).toBe(200);
    expect(config.llmModel).toBe("meta-llama/Llama-4");
    expect(config.taxonomyVersion).toBe(3);
    expect(() => loadConfig({ ...baseEnv, TAXONOMY_VERSION: "0" })).toThrow();
    expect(() => loadConfig({ ...baseEnv, ENRICH_MAX_CONCURRENT_CALLS: "33" })).toThrow();
    expect(() => loadConfig({ ...baseEnv, ENRICH_ENABLED: "yes" })).toThrow();
  });

  it("requires a separate inference token when enrichment is enabled", () => {
    expect(() => loadConfig({ ...baseEnv, ENRICH_ENABLED: "true" })).toThrow(
      "INFERENCE_TOKEN is required",
    );
  });

  it("requires both discarded-assignment rate settings", () => {
    expect(() =>
      loadConfig({ ...baseEnv, ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT: "0.15" }),
    ).toThrow("must be configured together");
    expect(() =>
      loadConfig({ ...baseEnv, ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS: "200" }),
    ).toThrow("must be configured together");
    expect(() =>
      loadConfig({
        ...baseEnv,
        ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT: "-0.1",
        ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS: "200",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...baseEnv,
        ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT: "0.15",
        ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS: "0",
      }),
    ).toThrow();
  });

  it("requires measurable pricing and a conservative per-call bound for a cost ceiling", () => {
    expect(() => loadConfig({ ...baseEnv, ENRICH_MAX_COST_USD: "1" })).toThrow(
      "ENRICH_MAX_COST_USD requires",
    );
    const config = loadConfig({
      ...baseEnv,
      ENRICH_MAX_COST_USD: "1",
      ENRICH_MAX_COST_PER_CALL_USD: "0.2",
      ENRICH_INPUT_TOKEN_USD: "0.000001",
      ENRICH_OUTPUT_TOKEN_USD: "0.000002",
    });
    expect(config).toMatchObject({
      enrichMaxCostUsd: 1,
      enrichMaxCostPerCallUsd: 0.2,
      enrichInputTokenUsd: 0.000001,
      enrichOutputTokenUsd: 0.000002,
    });
  });
});
