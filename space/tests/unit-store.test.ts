import { describe, expect, it } from "vitest";

import type { EnrichmentRow, PooledTweet } from "@xtap-pool/shared";
import {
  computeContractHash,
  computeInputHashFromTweets,
  PROCESSOR_VERSION,
  unitIdFor,
} from "@xtap-pool/shared";

import { EnrichStore } from "../src/enrich-store.js";
import { TweetStore } from "../src/store.js";
import { InvalidUnitCursorError, StaleUnitRevisionError, UnitStore } from "../src/unit-store.js";
import { makePooled } from "./helpers.js";

const NOW = "2026-07-27T00:00:00.000Z";
const CONTRACT_HASH = computeContractHash({
  taxonomy_version: 1,
  labels: [],
  model: "test-model",
  processor_version: PROCESSOR_VERSION,
  prompt_template_id: "batch-v1",
  output_schema_id: "units-v1",
  normalization_id: "free-label-registry-v1",
});

function enrichment(
  tweets: readonly PooledTweet[],
  unitId: string,
  labels: string[],
): EnrichmentRow {
  const anchor = tweets[0];
  const quote = anchor?.text.slice(0, 5) ?? "hello";
  return {
    unit_id: unitId,
    tweet_ids: tweets.map((tweet) => tweet.id),
    input_hash: computeInputHashFromTweets(unitId, tweets),
    contract_hash: CONTRACT_HASH,
    preset_labels: labels.map((name) => ({
      name,
      evidence: [{ tweet_id: anchor?.id ?? tweets[0]?.id ?? "0", quote }],
    })),
    free_labels: [{ name: "gguf", evidence: [{ tweet_id: anchor?.id ?? "0", quote }] }],
    model: "test-model",
    taxonomy_version: 1,
    enriched_at: NOW,
  };
}

function newEnrich(tweets: TweetStore): EnrichStore {
  const enrich = new EnrichStore(tweets.database, 1, () => new Date(NOW), CONTRACT_HASH);
  // Approve `gguf` so it appears in visible reads. Tests that need the
  // candidate flow can call rejectName/promoteName directly.
  return enrich;
}

function approveGguf(enrich: EnrichStore): void {
  const candidate = enrich.candidateEventIfNew("gguf").event;
  if (candidate === undefined) throw new Error("missing gguf candidate");
  enrich.applyRegistryEvent(candidate);
  enrich.promoteName("gguf", "test-approved");
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

function seedTwoPostUnit(): { units: UnitStore; root: TweetStore; unitId: string } {
  const tweets = new TweetStore();
  const enrich = newEnrich(tweets);
  const units = new UnitStore(tweets.database, 1);
  const posts = [pooled("1"), pooled("2", { text: "Qwen local model" })];
  tweets.insert(posts);
  enrich.registerTweets(posts);
  const rootPost = posts[0];
  if (rootPost === undefined) throw new Error("missing test root");
  const unitId = unitIdFor(rootPost);
  enrich.applyEnrichment(enrichment(posts, unitId, ["ai", "local-models"]));
  approveGguf(enrich);
  return { units, root: tweets, unitId };
}

describe("UnitStore", () => {
  it("returns complete enriched conversation-author units", () => {
    const { units, root, unitId } = seedTwoPostUnit();
    const page = units.query({ labels: ["ai", "local-models"], labelMode: "all" });
    expect(page.units).toHaveLength(1);
    const first = page.units[0];
    expect(first?.id).toBe(unitId);
    expect(first?.contributors).toEqual(["osolmaz"]);
    expect(first?.preset_labels.map((entry) => entry.name).sort()).toEqual(["ai", "local-models"]);
    expect(first?.free_labels.map((entry) => entry.name)).toEqual(["gguf"]);
    expect(first?.free_labels[0]?.evidence.length).toBeGreaterThan(0);
    expect(first?.posts.map((post) => post.id)).toEqual(["1", "2"]);
    root.close();
  });

  it("withholds a unit until enrichment covers its current membership", () => {
    const tweets = new TweetStore();
    const enrich = newEnrich(tweets);
    const units = new UnitStore(tweets.database, 1);
    const root = pooled("1");
    tweets.insert([root]);
    enrich.registerTweets([root]);
    const unitId = unitIdFor(root);
    enrich.applyEnrichment(enrichment([root], unitId, ["ai"]));
    expect(units.query({ labels: ["ai"] }).units).toHaveLength(1);

    const reply = pooled("2");
    tweets.insert([reply]);
    enrich.registerTweets([reply]);
    expect(enrich.queueEntry(unitId)?.status).toBe("pending");
    expect(units.query({ labels: ["ai"] }).units).toHaveLength(0);

    enrich.applyEnrichment(enrichment([root, reply], unitId, ["ai"]));
    expect(units.query({ labels: ["ai"] }).units[0]?.posts).toHaveLength(2);
    tweets.close();
  });

  it("paginates whole units and rejects a cursor after visible data changes", () => {
    const tweets = new TweetStore();
    const enrich = newEnrich(tweets);
    const units = new UnitStore(tweets.database, 1);
    for (const id of ["1", "2"]) {
      const post = pooled(id, { conversation_id: `conversation-${id}` });
      tweets.insert([post]);
      enrich.registerTweets([post]);
      enrich.applyEnrichment(enrichment([post], unitIdFor(post), ["ai"]));
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
    enrich.applyEnrichment(enrichment([newPost], unitIdFor(newPost), ["ai"]));
    expect(() => units.query({ cursor })).toThrow(StaleUnitRevisionError);
    expect(() => units.query({ cursor: "not-a-cursor" })).toThrow(InvalidUnitCursorError);
    tweets.close();
  });

  it("advances the result revision when queue status changes", () => {
    const tweets = new TweetStore();
    const enrich = newEnrich(tweets);
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
    const enrich = newEnrich(tweets);
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
    enrich.applyEnrichment(enrichment([publicPost], unitIdFor(publicPost), ["ai"]));
    enrich.applyEnrichment(enrichment([privateRoot, privateReply], unitIdFor(privateRoot), ["ai"]));
    enrich.applyEnrichment(enrichment([retweet], unitIdFor(retweet), ["ai"]));

    expect(units.query({ labels: ["ai"] }).units).toHaveLength(3);
    expect(
      units.query({ labels: ["ai"], publication: "public-original" }).units.map((unit) => unit.id),
    ).toEqual([unitIdFor(publicPost)]);
    tweets.close();
  });

  it("restricts units by exact author IDs", () => {
    const tweets = new TweetStore();
    const enrich = newEnrich(tweets);
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
    enrich.applyEnrichment(enrichment([allowed], unitIdFor(allowed), ["ai"]));
    enrich.applyEnrichment(enrichment([excluded], unitIdFor(excluded), ["ai"]));

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
    enrich.applyEnrichment(
      enrichment([mixedAllowed, mixedExcluded], unitIdFor(mixedAllowed), ["ai"]),
    );
    expect(
      units.query({ labels: ["ai"], authorIds: ["author-allowed"] }).units.map((unit) => unit.id),
    ).toEqual([unitIdFor(allowed)]);
    tweets.close();
  });

  it("uses any and all label semantics explicitly", () => {
    const tweets = new TweetStore();
    const enrich = newEnrich(tweets);
    const units = new UnitStore(tweets.database, 1);
    const ai = pooled("1", { conversation_id: "ai" });
    const local = pooled("2", { conversation_id: "local" });
    tweets.insert([ai, local]);
    enrich.registerTweets([ai, local]);
    enrich.applyEnrichment(enrichment([ai], unitIdFor(ai), ["ai"]));
    enrich.applyEnrichment(enrichment([local], unitIdFor(local), ["local-models"]));

    expect(units.query({ labels: ["ai", "local-models"], labelMode: "any" }).units).toHaveLength(2);
    expect(units.query({ labels: ["ai", "local-models"], labelMode: "all" }).units).toHaveLength(0);
    tweets.close();
  });

  it("applies a shared activity cutoff to the unit read", () => {
    const tweets = new TweetStore();
    const enrich = newEnrich(tweets);
    const units = new UnitStore(tweets.database, 1);
    const older = pooled("1", { conversation_id: "one" });
    const newer = pooled("2", { conversation_id: "two" });
    tweets.insert([older, newer]);
    enrich.registerTweets([older, newer]);
    enrich.applyEnrichment(enrichment([older], unitIdFor(older), ["ai"]));
    enrich.applyEnrichment(enrichment([newer], unitIdFor(newer), ["ai"]));

    // Cutoff at older.captured_at excludes newer and produces a distinct
    // snapshot identity from a later cutoff.
    const capped = units.query({ labels: ["ai"], cutoff: older.captured_at });
    expect(capped.units.map((unit) => unit.id)).toEqual([unitIdFor(older)]);
    const later = units.query({ labels: ["ai"], cutoff: newer.captured_at, limit: 1 });
    expect(later.revision).not.toBe(capped.revision);
    const laterCursor = later.next_cursor;
    if (laterCursor === undefined) throw new Error("missing later cursor");
    expect(() =>
      units.query({ labels: ["ai"], cutoff: older.captured_at, cursor: laterCursor }),
    ).toThrow(StaleUnitRevisionError);
    tweets.close();
  });
});
