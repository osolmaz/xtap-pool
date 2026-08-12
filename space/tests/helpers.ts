import type { PooledTweet, Tweet } from "@xtap-pool/shared";

import type { SpaceConfig } from "../src/config.js";

export const testConfig: SpaceConfig = {
  port: 7860,
  dataDir: ".data-test",
  rawBucket: "osolmaz/xtap-pool-data",
  indexBucket: "osolmaz/xtap-pool-bucket",
  hfToken: "hf_test_token",
  poolSigningSecret: "pool-secret-0123456789abcdef0123456789abcdef",
  sessionSecret: "session-secret-0123456789abcdef0123456789ab",
  allowedUsers: ["osolmaz", "alice"],
  poolAdmins: ["osolmaz"],
  oauthClientId: "client-id",
  oauthClientSecret: "client-secret",
  openidProviderUrl: "https://huggingface.co",
  publicUrl: "https://dutifuldev-xtap-pool.hf.space",
  staticRoot: "../explorer/dist",
  enrichEnabled: false,
  enrichIntervalMs: 60000,
  enrichMaxConcurrentCalls: 1,
  llmModel: "zai-org/GLM-5.2",
  taxonomyVersion: 1,
};

export function makeTweet(overrides: Record<string, unknown> = {}): Tweet {
  return {
    id: "100",
    url: "https://x.com/someone/status/100",
    text: "hello world",
    captured_at: "2026-05-21T03:04:35.954Z",
    created_at: "2026-05-20T10:00:00.000Z",
    author: { username: "someone", display_name: "Some One" },
    media: [],
    ...overrides,
  };
}

export function makePooled(overrides: Record<string, unknown> = {}): PooledTweet {
  return {
    ...makeTweet(),
    contributed_by: "osolmaz",
    pooled_at: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}
