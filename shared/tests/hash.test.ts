import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  computeContractHash,
  computeInputHash,
  computeInputHashFromTweets,
  PROCESSOR_VERSION,
  semanticTweetFields,
} from "../src/hash.js";
import type { PooledTweet } from "../src/tweet.js";

function pooled(overrides: Record<string, unknown> = {}): PooledTweet {
  return {
    id: "100",
    url: "https://x.com/someone/status/100",
    text: "hello world",
    captured_at: "2026-05-21T03:04:35.954Z",
    created_at: "2026-05-20T10:00:00.000Z",
    author: { id: "author-a", username: "someone", display_name: "Some One" },
    contributed_by: "osolmaz",
    pooled_at: "2026-05-21T03:05:00.000Z",
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("sorts keys and drops undefined values", () => {
    expect(canonicalJson({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ nested: { z: 1, a: 2 } })).toBe('{"nested":{"a":2,"z":1}}');
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("keeps array order", () => {
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
  });
});

describe("computeInputHash", () => {
  it("is stable across capture reorderings, metrics changes and contributor differences", () => {
    const first = pooled();
    const second = pooled({
      captured_at: "2026-06-01T00:00:00.000Z",
      pooled_at: "2026-06-01T00:00:00.000Z",
      contributed_by: "alice",
      like_count: 500,
    });
    expect(computeInputHashFromTweets("100:someone", [first])).toBe(
      computeInputHashFromTweets("100:someone", [second]),
    );
  });

  it("changes when the semantic input changes", () => {
    const baseline = pooled();
    const differentText = pooled({ text: "different words" });
    const withReply = pooled({ in_reply_to_status_id: "99" });
    const withQuote = pooled({ quoted_status_id: "42" });
    const subscriberOnly = pooled({ is_subscriber_only: true });
    const differentAuthor = pooled({ author: { id: "author-b", username: "someone" } });
    const baseHash = computeInputHashFromTweets("100:someone", [baseline]);
    expect(computeInputHashFromTweets("100:someone", [differentText])).not.toBe(baseHash);
    expect(computeInputHashFromTweets("100:someone", [withReply])).not.toBe(baseHash);
    expect(computeInputHashFromTweets("100:someone", [withQuote])).not.toBe(baseHash);
    expect(computeInputHashFromTweets("100:someone", [subscriberOnly])).not.toBe(baseHash);
    expect(computeInputHashFromTweets("100:someone", [differentAuthor])).not.toBe(baseHash);
  });

  it("changes when membership changes", () => {
    const root = pooled();
    const reply = pooled({ id: "101", text: "reply" });
    const single = computeInputHashFromTweets("100:someone", [root]);
    const multi = computeInputHashFromTweets("100:someone", [root, reply]);
    expect(single).not.toBe(multi);
  });

  it("does not depend on the order tweets are supplied", () => {
    const one = pooled();
    const two = pooled({ id: "101", text: "reply" });
    const a = computeInputHashFromTweets("100:someone", [one, two]);
    const b = computeInputHashFromTweets("100:someone", [two, one]);
    expect(a).toBe(b);
  });

  it("respects expanded URLs from raw arrays or entities.urls", () => {
    const viaArray = computeInputHashFromTweets("100:someone", [
      pooled({ expanded_urls: ["https://example.com/a"] }),
    ]);
    const viaEntities = computeInputHashFromTweets("100:someone", [
      pooled({ entities: { urls: [{ expanded_url: "https://example.com/a" }] } }),
    ]);
    const noUrl = computeInputHashFromTweets("100:someone", [pooled()]);
    expect(viaArray).toBe(viaEntities);
    expect(viaArray).not.toBe(noUrl);
  });

  it("normalizes semantic fields for downstream consumers", () => {
    const fields = semanticTweetFields(
      pooled({ conversation_id: "42", entities: { urls: [{ expanded_url: "https://x/1" }] } }),
    );
    expect(fields.expanded_urls).toEqual(["https://x/1"]);
    expect(fields.conversation_id).toBe("42");
    expect(fields.author_username).toBe("someone");
    expect(fields.is_retweet).toBe(false);
  });

  it("handles numeric references and malformed optional URL containers deterministically", () => {
    const fields = semanticTweetFields(
      pooled({
        conversation_id: 42,
        in_reply_to_tweet_id: 9,
        quoted_tweet_id: 8,
        entities: { urls: [null, { expanded_url: 7 }] },
        expanded_urls: ["", 7],
      }),
    );
    expect(fields).toMatchObject({ conversation_id: "42", reply_to: "9", quoted_status_id: "8" });
    expect(fields.expanded_urls).toEqual([]);
    expect(semanticTweetFields(pooled({ entities: null })).expanded_urls).toEqual([]);
    expect(
      semanticTweetFields(pooled({ entities: { urls: "not-an-array" } })).expanded_urls,
    ).toEqual([]);
  });
});

describe("computeContractHash", () => {
  const baseline = {
    taxonomy_version: 1,
    labels: [{ name: "ai", description: "d" }],
    model: "zai-org/GLM-5.2",
    processor_version: PROCESSOR_VERSION,
    prompt_template_id: "batch-v1",
    output_schema_id: "units-v1",
    normalization_id: "free-labels-v1",
  } as const;

  it("changes when any contract field changes", () => {
    const base = computeContractHash(baseline);
    expect(computeContractHash({ ...baseline, taxonomy_version: 2 })).not.toBe(base);
    expect(computeContractHash({ ...baseline, model: "other" })).not.toBe(base);
    expect(
      computeContractHash({
        ...baseline,
        labels: [{ name: "ai", description: "different" }],
      }),
    ).not.toBe(base);
    expect(computeContractHash({ ...baseline, processor_version: 2 })).not.toBe(base);
    expect(computeContractHash({ ...baseline, prompt_template_id: "batch-v2" })).not.toBe(base);
  });

  it("is stable under cosmetic label reorder", () => {
    const original = computeContractHash({
      ...baseline,
      labels: [
        { name: "ai", description: "a" },
        { name: "agents", description: "b" },
      ],
    });
    const reordered = computeContractHash({
      ...baseline,
      labels: [
        { name: "agents", description: "b" },
        { name: "ai", description: "a" },
      ],
    });
    expect(original).toBe(reordered);
  });
});

describe("computeInputHash from fields", () => {
  it("matches the tweet-based helper", () => {
    const tweet = pooled();
    const fromFields = computeInputHash("100:someone", [semanticTweetFields(tweet)]);
    const fromTweet = computeInputHashFromTweets("100:someone", [tweet]);
    expect(fromFields).toBe(fromTweet);
  });
});
