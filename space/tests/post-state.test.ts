import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeInputHash, contentHash } from "@xtap-pool/shared";
import type { PooledTweet } from "@xtap-pool/shared";
import { TweetStore } from "../src/store.js";
import { EnrichStore } from "../src/enrich-store.js";
import { UnitStore } from "../src/unit-store.js";
import { latestPost } from "../src/post-state.js";
import { makePooled } from "./helpers.js";

let store: TweetStore;
let enrich: EnrichStore;
let position: number;
const day = (n: number) => `2026-05-${String(n).padStart(2, "0")}T00:00:00.000Z`;
const post = (n: number, patch: Record<string, unknown> = {}) =>
  makePooled({
    conversation_id: "thread",
    captured_at: day(n),
    text: "model news",
    ...patch,
  });
function add(tweet: PooledTweet): string[] {
  store.observations.record(tweet, {
    segmentKey: `test/${String(position++)}`,
    operation: 0,
    path: "test.jsonl",
    position: 0,
  });
  store.insert([tweet]);
  return enrich.registerTweets([tweet]);
}
function clock() {
  return store.database
    .prepare("SELECT content_hash, content_at FROM unit_members WHERE tweet_id = '100'")
    .get();
}
beforeEach(() => {
  store = new TweetStore();
  enrich = new EnrichStore(store.database, 1, () => new Date(day(30)), "contract");
  position = 0;
});
afterEach(() => {
  store.close();
});

describe("content activity and deterministic post state", () => {
  it("does not move content coverage or hide completed posts after a metric revisit", () => {
    const original = post(21);
    add(original);
    const id = "thread:someone";
    enrich.applyEnrichment({
      unit_id: id,
      tweet_ids: ["100"],
      input_hash: computeInputHash(id, enrich.unitSemanticMembers(id)),
      contract_hash: "contract",
      preset_labels: [{ name: "ai", evidence: [{ tweet_id: "100", quote: "model" }] }],
      free_labels: [],
      model: "test",
      taxonomy_version: 1,
      enriched_at: day(22),
    });
    const before = enrich.queueProgress();
    expect(
      add(
        post(23, {
          metrics: { likes: 999, views: 80000 },
          author: { username: "someone", display_name: "Some One", follower_count: 500 },
        }),
      ),
    ).toEqual([]);
    expect(clock()).toEqual({ content_hash: contentHash(original), content_at: day(21) });
    expect(enrich.queueProgress()).toEqual(before);
    expect(
      new UnitStore(store.database, 1).query({ labels: ["ai"], cutoff: day(21) }).units,
    ).toHaveLength(1);
  });

  it.each([
    [21, 22, 23],
    [21, 23, 22],
    [22, 21, 23],
    [22, 23, 21],
    [23, 21, 22],
    [23, 22, 21],
  ])("reconstructs a late intervening edit in replay order %j", (...order) => {
    for (const n of order) add(post(n, { text: n === 22 ? "other model" : "model news" }));
    expect(clock()).toEqual({ content_hash: contentHash(post(23)), content_at: day(23) });
    expect(latestPost(store.database, "100")?.text).toBe("model news");
    expect(add(post(24, { metrics: { views: 10000 } }))).toEqual([]);
    expect(clock()).toEqual({ content_hash: contentHash(post(23)), content_at: day(23) });
  });

  it("treats a display edit as content without changing classification input", () => {
    add(post(21));
    const before = computeInputHash("thread:someone", enrich.unitSemanticMembers("thread:someone"));
    expect(add(post(22, { author: { username: "someone", display_name: "New name" } }))).toEqual([
      "thread:someone",
    ]);
    expect(computeInputHash("thread:someone", enrich.unitSemanticMembers("thread:someone"))).toBe(
      before,
    );
    expect(clock()).toEqual({
      content_hash: contentHash(
        post(22, { author: { username: "someone", display_name: "New name" } }),
      ),
      content_at: day(22),
    });
  });

  it.each([false, true])(
    "chooses a same-time private edit independently of delivery order (%s)",
    (privateFirst) => {
      const publicPost = post(21);
      const privatePost = post(21, { is_subscriber_only: true });
      for (const tweet of privateFirst ? [privatePost, publicPost] : [publicPost, privatePost])
        add(tweet);
      expect(latestPost(store.database, "100")?.["is_subscriber_only"]).toBe(true);
      expect(clock()).toEqual({ content_hash: contentHash(privatePost), content_at: day(21) });
    },
  );

  it("normalizes offset timestamps before choosing membership", () => {
    add(post(21, { captured_at: "2026-05-21T03:00:00+03:00" }));
    add(post(21, { conversation_id: "new", captured_at: "2026-05-21T01:00:00Z" }));
    expect(store.database.prepare("SELECT unit_id FROM unit_members").get()).toEqual({
      unit_id: "new:someone",
    });
  });
});
