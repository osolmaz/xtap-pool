import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const baseEnv = {
  DATASET_REPO: "dutifuldev/xtap-pool-data",
  HF_TOKEN: "hf_x",
  POOL_SIGNING_SECRET: "pool-secret-0123456789abcdef0123456789abcdef",
  SESSION_SECRET: "session-secret-0123456789abcdef0123456789ab",
  ALLOWED_USERS: "osolmaz, alice ,bob,",
  OAUTH_CLIENT_ID: "cid",
  OAUTH_CLIENT_SECRET: "csecret",
  SPACE_HOST: "dutifuldev-xtap-pool.hf.space",
};

describe("loadConfig", () => {
  it("parses a full environment with defaults", () => {
    const config = loadConfig(baseEnv);
    expect(config.port).toBe(7860);
    expect(config.allowedUsers).toEqual(["osolmaz", "alice", "bob"]);
    expect(config.publicUrl).toBe("https://dutifuldev-xtap-pool.hf.space");
    expect(config.openidProviderUrl).toBe("https://huggingface.co");
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
});
