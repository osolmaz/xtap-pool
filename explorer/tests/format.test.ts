import { describe, expect, it } from "vitest";

import {
  avatarColor,
  displayName,
  formatCount,
  formatTweetDate,
  isArticleTweet,
  isRetweet,
  photoMedia,
  quotedTweetUrl,
  tokenizeTweetText,
  tweetMetrics,
} from "../src/lib/format.js";
import { pooledTweet } from "./fixtures.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");

describe("tokenizeTweetText", () => {
  it("linkifies urls, mentions and hashtags between plain text", () => {
    const segments = tokenizeTweetText("Hey @alice check https://example.com/x #ai now");
    expect(segments).toEqual([
      { kind: "text", text: "Hey " },
      { kind: "link", text: "@alice", href: "https://x.com/alice" },
      { kind: "text", text: " check " },
      { kind: "link", text: "https://example.com/x", href: "https://example.com/x" },
      { kind: "text", text: " " },
      { kind: "link", text: "#ai", href: "https://x.com/hashtag/ai" },
      { kind: "text", text: " now" },
    ]);
  });

  it("returns one plain segment for text without tokens", () => {
    expect(tokenizeTweetText("just words")).toEqual([{ kind: "text", text: "just words" }]);
    expect(tokenizeTweetText("")).toEqual([]);
  });
});

describe("formatCount", () => {
  it("formats X-style compact counts", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1K");
    expect(formatCount(1234)).toBe("1.2K");
    expect(formatCount(87845)).toBe("87.8K");
    expect(formatCount(2_500_000)).toBe("2.5M");
  });
});

describe("formatTweetDate", () => {
  it("uses relative labels within a day and dates beyond", () => {
    expect(formatTweetDate("2026-07-06T11:59:30.000Z", NOW)).toBe("now");
    expect(formatTweetDate("2026-07-06T11:15:00.000Z", NOW)).toBe("45m");
    expect(formatTweetDate("2026-07-06T02:00:00.000Z", NOW)).toBe("10h");
    expect(formatTweetDate("2026-05-21T03:04:35.954Z", NOW)).toBe("May 21");
    expect(formatTweetDate("2024-12-31T00:00:00.000Z", NOW)).toBe("Dec 31, 2024");
  });
});

describe("tweet field helpers", () => {
  it("extracts up to four photos with alt text", () => {
    const tweet = pooledTweet({
      media: [
        { type: "photo", url: "https://pbs/1.jpg", alt_text: "one" },
        { type: "video", url: "https://pbs/skip.mp4" },
        { type: "photo", url: "https://pbs/2.jpg" },
        { type: "photo", url: "https://pbs/3.jpg" },
        { type: "photo", url: "https://pbs/4.jpg" },
        { type: "photo", url: "https://pbs/5.jpg" },
      ],
    });
    const photos = photoMedia(tweet);
    expect(photos).toHaveLength(4);
    expect(photos[0]).toEqual({ url: "https://pbs/1.jpg", alt: "one" });
    expect(photos[1]).toEqual({ url: "https://pbs/2.jpg", alt: "Tweet image" });
    expect(photoMedia(pooledTweet({ media: "nope" }))).toEqual([]);
  });

  it("reads metrics with zero defaults", () => {
    expect(tweetMetrics(pooledTweet({ metrics: { likes: 7, views: null } }))).toEqual({
      replies: 0,
      retweets: 0,
      likes: 7,
      views: 0,
    });
    expect(tweetMetrics(pooledTweet({ metrics: undefined })).likes).toBe(0);
  });

  it("derives display name, flags and quote URL", () => {
    expect(displayName(pooledTweet())).toBe("Some One");
    expect(displayName(pooledTweet({ author: { username: "bare" } }))).toBe("bare");
    expect(isArticleTweet(pooledTweet({ is_article: true }))).toBe(true);
    expect(isArticleTweet(pooledTweet())).toBe(false);
    expect(isRetweet(pooledTweet({ is_retweet: true }))).toBe(true);
    expect(quotedTweetUrl(pooledTweet({ quoted_tweet_id: "42" }))).toBe(
      "https://x.com/i/status/42",
    );
    expect(quotedTweetUrl(pooledTweet())).toBeUndefined();
  });

  it("produces stable avatar colors", () => {
    expect(avatarColor("osolmaz")).toBe(avatarColor("osolmaz"));
    expect(avatarColor("osolmaz")).toMatch(/^hsl\(\d+ 55% 45%\)$/);
  });
});
