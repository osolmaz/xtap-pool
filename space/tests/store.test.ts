import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TweetStore, decodeCursor, encodeCursor } from "../src/store.js";
import { makePooled } from "./helpers.js";

let store: TweetStore;

beforeEach(() => {
  store = new TweetStore();
});

afterEach(() => {
  store.close();
});

describe("classify + insert", () => {
  it("accepts new tweets and skips exact duplicates", () => {
    const tweet = makePooled();
    store.insert([tweet]);
    const { accepted, skippedDuplicates } = store.classify([tweet, makePooled({ id: "101" })]);
    expect(accepted.map((entry) => entry.id)).toEqual(["101"]);
    expect(skippedDuplicates).toBe(1);
  });

  it("accepts re-captures with fresher captured_at and upserts them", () => {
    store.insert([makePooled({ captured_at: "2026-05-21T00:00:00.000Z", text: "old" })]);
    const fresher = makePooled({ captured_at: "2026-05-22T00:00:00.000Z", text: "new" });
    const { accepted } = store.classify([fresher]);
    expect(accepted).toHaveLength(1);
    store.insert([fresher]);
    const page = store.query({ dedup: false });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.tweet.text).toBe("new");
  });

  it("keeps the freshest capture when a batch contains the same tweet twice", () => {
    const older = makePooled({ captured_at: "2026-05-21T00:00:00.000Z", text: "older" });
    const newer = makePooled({ captured_at: "2026-05-23T00:00:00.000Z", text: "newer" });
    const { accepted, skippedDuplicates } = store.classify([older, newer]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.text).toBe("newer");
    expect(skippedDuplicates).toBe(1);
  });

  it("stale re-inserts do not overwrite fresher rows", () => {
    store.insert([makePooled({ captured_at: "2026-05-22T00:00:00.000Z", text: "fresh" })]);
    store.insert([makePooled({ captured_at: "2026-05-21T00:00:00.000Z", text: "stale" })]);
    expect(store.query({ dedup: false }).records[0]?.tweet.text).toBe("fresh");
  });

  it("tracks the same tweet separately per contributor", () => {
    store.insert([makePooled(), makePooled({ contributed_by: "alice" })]);
    expect(store.count()).toBe(2);
  });
});

describe("query", () => {
  beforeEach(() => {
    store.insert([
      makePooled({
        id: "1",
        created_at: "2026-05-01T00:00:00.000Z",
        captured_at: "2026-05-02T00:00:00.000Z",
        text: "vllm is fast",
        author: { username: "karpathy" },
      }),
      makePooled({
        id: "2",
        created_at: "2026-05-03T00:00:00.000Z",
        captured_at: "2026-05-04T00:00:00.000Z",
        text: "agents everywhere",
        author: { username: "swyx" },
        media: [{ type: "photo", url: "https://example.com/p.jpg" }],
      }),
      makePooled({
        id: "2",
        contributed_by: "alice",
        created_at: "2026-05-03T00:00:00.000Z",
        captured_at: "2026-05-05T00:00:00.000Z",
        text: "agents everywhere",
        author: { username: "swyx" },
        media: [{ type: "photo", url: "https://example.com/p.jpg" }],
      }),
      makePooled({
        id: "3",
        contributed_by: "alice",
        created_at: "2026-05-06T00:00:00.000Z",
        captured_at: "2026-05-07T00:00:00.000Z",
        text: "an article",
        is_article: true,
        author: { username: "simonw" },
      }),
    ]);
  });

  it("returns newest first without dedup", () => {
    const page = store.query({ dedup: false });
    expect(page.records.map((record) => record.tweet.id)).toEqual(["3", "2", "2", "1"]);
  });

  it("collapses cross-contributor duplicates when dedup is on", () => {
    const page = store.query({ dedup: true });
    expect(page.records.map((record) => record.tweet.id)).toEqual(["3", "2", "1"]);
    const duplicated = page.records.find((record) => record.tweet.id === "2");
    expect(duplicated?.contributors).toEqual(["alice", "osolmaz"]);
    expect(duplicated?.tweet.captured_at).toBe("2026-05-05T00:00:00.000Z");
  });

  it("filters by contributor, author, text, media, article and date range", () => {
    expect(
      store.query({ contributors: ["alice"], dedup: false }).records.map((r) => r.tweet.id),
    ).toEqual(["3", "2"]);
    expect(store.query({ author: "KARPATHY" }).records.map((r) => r.tweet.id)).toEqual(["1"]);
    expect(store.query({ q: "vllm" }).records.map((r) => r.tweet.id)).toEqual(["1"]);
    expect(store.query({ q: "simonw" }).records.map((r) => r.tweet.id)).toEqual(["3"]);
    expect(store.query({ hasMedia: true, dedup: true }).records.map((r) => r.tweet.id)).toEqual([
      "2",
    ]);
    expect(store.query({ isArticle: true }).records.map((r) => r.tweet.id)).toEqual(["3"]);
    expect(
      store
        .query({
          since: "2026-05-02T00:00:00.000Z",
          until: "2026-05-04T00:00:00.000Z",
          dedup: true,
        })
        .records.map((r) => r.tweet.id),
    ).toEqual(["2"]);
  });

  it("paginates with a keyset cursor", () => {
    const first = store.query({ dedup: true, limit: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = store.query({ dedup: true, limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.records.map((record) => record.tweet.id)).toEqual(["1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("ignores an invalid cursor", () => {
    expect(store.query({ cursor: "!!not-a-cursor!!" }).records.length).toBeGreaterThan(0);
  });

  it("keeps every contributor copy across page boundaries when dedup is off", () => {
    const first = store.query({ dedup: false, limit: 2 });
    expect(first.records).toHaveLength(2);
    const second = store.query({ dedup: false, limit: 2, cursor: first.nextCursor ?? "" });
    const all = [...first.records, ...second.records].map(
      (record) => `${record.tweet.id}:${record.tweet.contributed_by}`,
    );
    expect(all).toEqual(["3:alice", "2:osolmaz", "2:alice", "1:osolmaz"]);
  });
});

describe("contributors + cursors", () => {
  it("reports per-contributor stats", () => {
    store.insert([
      makePooled({ id: "1", pooled_at: "2026-07-01T00:00:00.000Z" }),
      makePooled({ id: "2", pooled_at: "2026-07-02T00:00:00.000Z" }),
      makePooled({ id: "3", contributed_by: "alice", pooled_at: "2026-07-03T00:00:00.000Z" }),
    ]);
    expect(store.contributors()).toEqual([
      { username: "osolmaz", tweetCount: 2, lastPooledAt: "2026-07-02T00:00:00.000Z" },
      { username: "alice", tweetCount: 1, lastPooledAt: "2026-07-03T00:00:00.000Z" },
    ]);
  });

  it("round-trips cursors and rejects malformed ones", () => {
    const cursor = encodeCursor("2026-05-01T00:00:00.000Z", "42");
    expect(decodeCursor(cursor)).toEqual({ sortTs: "2026-05-01T00:00:00.000Z", id: "42" });
    expect(decodeCursor("zzz")).toBeUndefined();
    expect(decodeCursor(Buffer.from("[1]").toString("base64url"))).toBeUndefined();
    expect(decodeCursor(Buffer.from("[1,2]").toString("base64url"))).toBeUndefined();
  });
});
