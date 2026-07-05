import { describe, expect, it } from "vitest";

import { datasetPathFor, dayKey, stampTweet, validateTweet } from "../src/index.js";

const sample = {
  id: "2022409507826213048",
  url: "https://x.com/xdotli/status/2022409507826213048",
  created_at: "2026-02-13T20:36:15.000Z",
  captured_at: "2026-05-21T03:04:35.954Z",
  text: "Agent Skills are everywhere.",
  lang: "en",
  author: {
    id: "1484803981050200067",
    username: "xdotli",
    display_name: "Xiangyi Li",
    verified: false,
    is_blue_verified: true,
    follower_count: 4787,
  },
  metrics: { likes: 713, retweets: 97, replies: 30, views: 87845, bookmarks: 1000, quotes: 18 },
  media: [{ type: "photo", url: "https://pbs.twimg.com/media/HBEKuqobUAApJck.jpg:orig" }],
  hashtags: [],
  mentions: [],
  in_reply_to: null,
  is_retweet: false,
  source_endpoint: "UserTimeline",
};

describe("validateTweet", () => {
  it("accepts a full xTap tweet and preserves unknown fields", () => {
    const result = validateTweet(sample);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tweet.id).toBe(sample.id);
    expect(result.tweet["metrics"]).toEqual(sample.metrics);
    expect(result.tweet["source_endpoint"]).toBe("UserTimeline");
  });

  it("accepts a minimal tweet with only required fields", () => {
    const result = validateTweet({
      id: "1",
      url: "https://x.com/a/status/1",
      text: "",
      captured_at: "2026-01-01T00:00:00.000Z",
      author: { username: "a" },
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["missing id", { ...sample, id: undefined }],
    ["empty id", { ...sample, id: "" }],
    ["missing author", { ...sample, author: undefined }],
    ["empty author username", { ...sample, author: { username: "" } }],
    ["bad captured_at", { ...sample, captured_at: "yesterday" }],
    ["missing text", { ...sample, text: undefined }],
    ["not an object", "tweet"],
    ["null", null],
  ])("rejects %s with a reason", (_label, candidate) => {
    const result = validateTweet(candidate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("stampTweet", () => {
  it("stamps attribution and pooled_at", () => {
    const valid = validateTweet(sample);
    if (!valid.ok) throw new Error("fixture must validate");
    const stamped = stampTweet(valid.tweet, "osolmaz", new Date("2026-07-06T10:00:00.000Z"));
    expect(stamped.contributed_by).toBe("osolmaz");
    expect(stamped.pooled_at).toBe("2026-07-06T10:00:00.000Z");
  });

  it("overwrites client-supplied attribution", () => {
    const forged = { ...sample, contributed_by: "someone-else", pooled_at: "1970-01-01" };
    const valid = validateTweet(forged);
    if (!valid.ok) throw new Error("fixture must validate");
    const stamped = stampTweet(valid.tweet, "osolmaz", new Date("2026-07-06T10:00:00.000Z"));
    expect(stamped.contributed_by).toBe("osolmaz");
    expect(stamped.pooled_at).toBe("2026-07-06T10:00:00.000Z");
  });
});

describe("day bucketing", () => {
  it("uses the UTC day of capture", () => {
    expect(dayKey("2026-05-21T03:04:35.954Z")).toBe("2026-05-21");
    expect(dayKey("2026-05-21T23:59:59.999-02:00")).toBe("2026-05-22");
  });

  it("builds xtap-store compatible paths", () => {
    expect(datasetPathFor("osolmaz", "2026-05-21T03:04:35.954Z")).toBe(
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
    );
    expect(datasetPathFor("alice", "2026-12-31T23:00:00.000Z")).toBe(
      "data/alice/2026/12/tweets-2026-12-31.jsonl",
    );
  });
});
