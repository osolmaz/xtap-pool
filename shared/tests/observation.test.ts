import { describe, expect, it } from "vitest";
import {
  contentHash,
  exactCounter,
  normalizeObservation,
  observationMetrics,
  tweetContent,
} from "../src/observation.js";
import { computeInputHashFromTweets } from "../src/hash.js";
import type { PooledTweet } from "../src/tweet.js";

const tweet = (patch: Partial<PooledTweet> = {}): PooledTweet => ({
  id: "123",
  url: "https://x.com/alice/status/123",
  text: "A model test",
  author: { id: "12", username: "alice" },
  created_at: "2026-09-06T08:00:00.000Z",
  captured_at: "2026-09-06T09:00:00.000Z",
  contributed_by: "member",
  pooled_at: "2026-09-06T09:00:01.000Z",
  metrics: { likes: 100, replies: 2, retweets: 4, views: "1234" },
  ...patch,
});

describe("exact source observations", () => {
  it.each([0, 1, Number.MAX_SAFE_INTEGER, "0", "1234"])("preserves exact counter %s", (value) => {
    expect(exactCounter(value)).toBe(Number(value));
  });
  it.each([
    null,
    undefined,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "1.2K",
    "1,234",
    "01",
    "-1",
    "",
    {},
    [],
    true,
  ])("keeps invalid or missing counter %s unknown", (value) => {
    expect(exactCounter(value)).toBeNull();
  });
  it("normalizes only the source retweets field to the consumer reposts field", () => {
    expect(observationMetrics(tweet()["metrics"])).toEqual({
      likes: 100,
      replies: 2,
      reposts: 4,
      views: 1234,
    });
    expect(observationMetrics(null)).toEqual({
      likes: null,
      replies: null,
      reposts: null,
      views: null,
    });
  });
  it("does not treat ambiguous historical zeros as measured baselines", () => {
    const metrics = { likes: 0, replies: 0, retweets: 0, views: 0 };
    expect(observationMetrics(metrics)).toEqual({
      likes: null,
      replies: null,
      reposts: null,
      views: null,
    });
    expect(observationMetrics({ ...metrics, format: "exact-v1" })).toEqual({
      likes: 0,
      replies: 0,
      reposts: 0,
      views: 0,
    });
  });
  it("keeps identity stable through delivery retry and timestamp normalization", () => {
    const first = normalizeObservation(tweet());
    const retry = normalizeObservation(
      tweet({ captured_at: "2026-09-06T11:00:00+02:00", pooled_at: "2026-09-06T10:00:00.000Z" }),
    );
    expect(retry.id).toBe(first.id);
    expect(retry.observed_at).toBe(first.observed_at);
    expect(retry.received_at).not.toBe(first.received_at);
  });
  it("retains an unchanged sample at a later actual time", () => {
    const first = normalizeObservation(tweet());
    const later = normalizeObservation(tweet({ captured_at: "2026-09-06T15:00:00.000Z" }));
    expect(later.id).not.toBe(first.id);
    expect(later.content_hash).toBe(first.content_hash);
    expect(later.metrics).toEqual(first.metrics);
  });
  it("does not collapse same-time conflicting counters or distinct source identities", () => {
    const first = normalizeObservation(tweet());
    expect(normalizeObservation(tweet({ metrics: { likes: 99 } })).id).not.toBe(first.id);
    expect(normalizeObservation(tweet({ contributed_by: "other" })).id).not.toBe(first.id);
  });
  it("separates semantic input, content, and observations", () => {
    const first = tweet();
    const later = tweet({
      metrics: { likes: 400 },
      captured_at: "2026-09-06T15:00:00.000Z",
      source_endpoint: "another-response",
      author: { id: "12", username: "alice", follower_count: 999 },
    });
    expect(contentHash(later)).toBe(contentHash(first));
    expect(computeInputHashFromTweets("123:12", [later])).toBe(
      computeInputHashFromTweets("123:12", [first]),
    );
    expect(normalizeObservation(later).id).not.toBe(normalizeObservation(first).id);
    expect(tweetContent(later)).not.toHaveProperty("metrics");
    expect(tweetContent(later)).not.toHaveProperty("source_endpoint");
    expect(tweetContent(later)).not.toHaveProperty("author.follower_count");
  });
  it.each([
    { text: "Edited test" },
    { is_subscriber_only: true },
    { media: [{ url: "https://example.org/picture" }] },
    { conversation_id: "changed" },
  ])("tracks a real content or eligibility change: %s", (patch) => {
    expect(contentHash(tweet(patch))).not.toBe(contentHash(tweet()));
  });
});
