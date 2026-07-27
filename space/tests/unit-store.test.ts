import { describe, expect, it } from "vitest";

import type { EnrichmentRow, PooledTweet } from "@xtap-pool/shared";
import { unitIdFor } from "@xtap-pool/shared";

import { EnrichStore } from "../src/enrich-store.js";
import { TweetStore } from "../src/store.js";
import { InvalidUnitCursorError, StaleUnitRevisionError, UnitStore } from "../src/unit-store.js";
import { makePooled } from "./helpers.js";

const NOW = "2026-07-27T00:00:00.000Z";

function enrichment(tweetIds: readonly string[], unitId: string, labels: string[]): EnrichmentRow {
  return {
    unit_id: unitId,
    tweet_ids: [...tweetIds],
    labels,
    free_labels: ["gguf"],
    concepts: [{ name: "Qwen3 8B", aliases: ["Qwen/Qwen3-8B"] }],
    model: "test-model",
    taxonomy_version: 1,
    enriched_at: NOW,
  };
}

function pooled(id: string, overrides: Record<string, unknown> = {}): PooledTweet {
  return makePooled({
    id,
    url: `https://x.com/someone/status/${id}`,
    captured_at: `2026-07-2${id}T12:00:00.000Z`,
    created_at: `2026-07-2${id}T10:00:00.000Z`,
    conversation_id: "conversation-1",
    ...overrides,
  });
}

describe("UnitStore", () => {
  it("returns complete enriched conversation-author units", () => {
    const tweets = new TweetStore();
    const enrich = new EnrichStore(tweets.database, 1);
    const units = new UnitStore(tweets.database, 1);
    const posts = [pooled("1"), pooled("2", { text: "Qwen local model" })];
    tweets.insert(posts);
    enrich.registerTweets(posts);
    const root = posts[0];
    if (root === undefined) throw new Error("missing test root");
    const unitId = unitIdFor(root);
    enrich.applyEnrichment(enrichment(["1", "2"], unitId, ["ai", "local-models"]));

    const page = units.query({ labels: ["ai", "local-models"], labelMode: "all" });
    expect(page.units).toHaveLength(1);
    expect(page.units[0]).toMatchObject({
      id: unitId,
      preset_labels: ["ai", "local-models"],
      free_labels: ["gguf"],
      contributors: ["osolmaz"],
      concepts: [{ slug: "qwen3-8b", name: "Qwen3 8B", aliases: ["Qwen/Qwen3-8B"] }],
    });
    expect(page.units[0]?.posts.map((post) => post.id)).toEqual(["1", "2"]);
    tweets.close();
  });

  it("withholds a unit until enrichment covers its current membership", () => {
    const tweets = new TweetStore();
    const enrich = new EnrichStore(tweets.database, 1);
    const units = new UnitStore(tweets.database, 1);
    const root = pooled("1");
    tweets.insert([root]);
    enrich.registerTweets([root]);
    const unitId = unitIdFor(root);
    enrich.applyEnrichment(enrichment(["1"], unitId, ["ai"]));
    expect(units.query({ labels: ["ai"] }).units).toHaveLength(1);

    const reply = pooled("2");
    tweets.insert([reply]);
    enrich.registerTweets([reply]);
    expect(enrich.queueEntry(unitId)?.status).toBe("queued");
    expect(units.query({ labels: ["ai"] }).units).toHaveLength(0);

    enrich.applyEnrichment(enrichment(["1", "2"], unitId, ["ai"]));
    expect(units.query({ labels: ["ai"] }).units[0]?.posts).toHaveLength(2);
    tweets.close();
  });

  it("paginates whole units and rejects a cursor after visible data changes", () => {
    const tweets = new TweetStore();
    const enrich = new EnrichStore(tweets.database, 1);
    const units = new UnitStore(tweets.database, 1);
    for (const id of ["1", "2"]) {
      const post = pooled(id, { conversation_id: `conversation-${id}` });
      tweets.insert([post]);
      enrich.registerTweets([post]);
      enrich.applyEnrichment(enrichment([id], unitIdFor(post), ["ai"]));
    }

    const first = units.query({ labels: ["ai"], limit: 1 });
    expect(first.units).toHaveLength(1);
    expect(first.next_cursor).toBeDefined();
    const cursor = first.next_cursor;
    if (cursor === undefined) throw new Error("missing test cursor");
    const second = units.query({ labels: ["ai"], limit: 1, cursor });
    expect(second.units).toHaveLength(1);
    expect(second.revision).toBe(first.revision);

    const newPost = pooled("3", { conversation_id: "conversation-3" });
    tweets.insert([newPost]);
    enrich.registerTweets([newPost]);
    enrich.applyEnrichment(enrichment(["3"], unitIdFor(newPost), ["ai"]));
    expect(() => units.query({ cursor })).toThrow(StaleUnitRevisionError);
    expect(() => units.query({ cursor: "not-a-cursor" })).toThrow(InvalidUnitCursorError);
    tweets.close();
  });

  it("advances the result revision when queue status changes", () => {
    const tweets = new TweetStore();
    const enrich = new EnrichStore(tweets.database, 1);
    const units = new UnitStore(tweets.database, 1);
    const post = pooled("1");
    tweets.insert([post]);
    enrich.registerTweets([post]);
    const before = units.currentRevision();

    expect(enrich.claimQueued(1)).toHaveLength(1);
    expect(units.currentRevision()).not.toBe(before);
    tweets.close();
  });

  it("excludes subscriber-containing and retweet-only units for public publication", () => {
    const tweets = new TweetStore();
    const enrich = new EnrichStore(tweets.database, 1);
    const units = new UnitStore(tweets.database, 1);
    const publicPost = pooled("1", { conversation_id: "public" });
    const privateRoot = pooled("2", { conversation_id: "private" });
    const privateReply = pooled("3", {
      conversation_id: "private",
      is_subscriber_only: true,
    });
    const retweet = pooled("4", { conversation_id: "retweet", is_retweet: true });
    const posts = [publicPost, privateRoot, privateReply, retweet];
    tweets.insert(posts);
    enrich.registerTweets(posts);
    enrich.applyEnrichment(enrichment(["1"], unitIdFor(publicPost), ["ai"]));
    enrich.applyEnrichment(enrichment(["2", "3"], unitIdFor(privateRoot), ["ai"]));
    enrich.applyEnrichment(enrichment(["4"], unitIdFor(retweet), ["ai"]));

    expect(units.query({ labels: ["ai"] }).units).toHaveLength(3);
    expect(
      units.query({ labels: ["ai"], publication: "public-original" }).units.map((unit) => unit.id),
    ).toEqual([unitIdFor(publicPost)]);
    tweets.close();
  });

  it("restricts units by exact author IDs", () => {
    const tweets = new TweetStore();
    const enrich = new EnrichStore(tweets.database, 1);
    const units = new UnitStore(tweets.database, 1);
    const allowed = pooled("1", {
      conversation_id: "allowed",
      author: { id: "author-allowed", username: "renamed-user" },
    });
    const excluded = pooled("2", {
      conversation_id: "excluded",
      author: { id: "author-excluded", username: "allowed-looking-handle" },
    });
    tweets.insert([allowed, excluded]);
    enrich.registerTweets([allowed, excluded]);
    enrich.applyEnrichment(enrichment(["1"], unitIdFor(allowed), ["ai"]));
    enrich.applyEnrichment(enrichment(["2"], unitIdFor(excluded), ["ai"]));

    expect(units.query({ labels: ["ai"], authorIds: ["author-allowed"] }).units).toEqual([
      expect.objectContaining({ id: unitIdFor(allowed) }),
    ]);
    expect(units.query({ labels: ["ai"], authorIds: ["missing"] }).units).toEqual([]);

    const mixedAllowed = pooled("3", {
      conversation_id: "mixed",
      author: { id: "author-allowed", username: "shared-handle" },
    });
    const mixedExcluded = pooled("4", {
      conversation_id: "mixed",
      author: { id: "author-excluded", username: "shared-handle" },
    });
    tweets.insert([mixedAllowed, mixedExcluded]);
    enrich.registerTweets([mixedAllowed, mixedExcluded]);
    enrich.applyEnrichment(enrichment(["3", "4"], unitIdFor(mixedAllowed), ["ai"]));
    expect(
      units.query({ labels: ["ai"], authorIds: ["author-allowed"] }).units.map((unit) => unit.id),
    ).toEqual([unitIdFor(allowed)]);
    tweets.close();
  });

  it("uses any and all label semantics explicitly", () => {
    const tweets = new TweetStore();
    const enrich = new EnrichStore(tweets.database, 1);
    const units = new UnitStore(tweets.database, 1);
    const ai = pooled("1", { conversation_id: "ai" });
    const local = pooled("2", { conversation_id: "local" });
    tweets.insert([ai, local]);
    enrich.registerTweets([ai, local]);
    enrich.applyEnrichment(enrichment(["1"], unitIdFor(ai), ["ai"]));
    enrich.applyEnrichment(enrichment(["2"], unitIdFor(local), ["local-models"]));

    expect(units.query({ labels: ["ai", "local-models"], labelMode: "any" }).units).toHaveLength(2);
    expect(units.query({ labels: ["ai", "local-models"], labelMode: "all" }).units).toHaveLength(0);
    tweets.close();
  });
});
