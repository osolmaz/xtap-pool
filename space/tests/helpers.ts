import type { PooledTweet, Tweet } from "@xtap-pool/shared";

import { tweetPathFor } from "../src/bucket-log.js";
import type { SpaceConfig } from "../src/config.js";
import type { EnrichStore } from "../src/enrich-store.js";
import { prepareIngest } from "../src/ingest.js";
import type { TweetStore } from "../src/store.js";

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

/**
 * Project stamped tweets into a store the way a replayed raw tweet segment
 * does. Tests use it in place of an ingest route, which the Space no longer has.
 */
export function seedTweets(
  store: TweetStore,
  enrich: EnrichStore | undefined,
  contributor: string,
  candidates: readonly unknown[],
  now: Date,
): PooledTweet[] {
  const { stamped, rejected } = prepareIngest(candidates, contributor, now, now);
  if (rejected.length > 0) throw new Error(`seed tweets rejected: ${rejected[0]?.reason ?? ""}`);
  store.database.transaction(() => {
    for (const [position, tweet] of stamped.entries()) {
      const path = tweetPathFor(contributor, tweet.captured_at);
      const source = { segmentKey: `test-seed/${String(position)}`, operation: 0, path, position };
      store.observations.record(tweet, source);
      store.sourceEffects.recordPost(tweet, source);
    }
    store.insert(stamped);
    enrich?.registerTweets(stamped);
  })();
  return stamped;
}
