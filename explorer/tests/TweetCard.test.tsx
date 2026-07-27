import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TweetCard } from "../src/components/TweetCard.js";
import { pooledTweet } from "./fixtures.js";

const now = new Date("2026-07-06T12:00:00.000Z");

afterEach(cleanup);

describe("TweetCard", () => {
  it("renders identity, escaped text, date, and the original post link", () => {
    render(
      <TweetCard
        tweet={pooledTweet({ text: "look <b>bold</b> & fine" })}
        contributors={["osolmaz"]}
        now={now}
      />,
    );
    expect(screen.getByText("Some One")).toBeDefined();
    expect(screen.getByText("look <b>bold</b> & fine")).toBeDefined();
    expect(screen.getByText("May 20")).toBeDefined();
    expect(screen.getByText("View on X").getAttribute("href")).toBe(
      "https://x.com/someone/status/100",
    );
    expect(screen.getByText("⛏ osolmaz")).toBeDefined();
  });

  it("renders linkified content, media, state markers, quotes, and metrics", () => {
    render(
      <TweetCard
        tweet={pooledTweet({
          text: "cc @alice #ai",
          media: [{ type: "photo", url: "https://pbs/1.jpg" }],
          is_retweet: true,
          is_article: true,
          quoted_tweet_id: "42",
          metrics: { likes: 1234, views: 90000 },
        })}
        contributors={[]}
        now={now}
      />,
    );
    expect(screen.getByText("@alice").getAttribute("href")).toBe("https://x.com/alice");
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText("reposted")).toBeDefined();
    expect(screen.getByText("article")).toBeDefined();
    expect(screen.getByText("View quoted post on X").getAttribute("href")).toBe(
      "https://x.com/i/status/42",
    );
    expect(screen.getByText("1.2K")).toBeDefined();
    expect(screen.getByText("90K")).toBeDefined();
  });
});
