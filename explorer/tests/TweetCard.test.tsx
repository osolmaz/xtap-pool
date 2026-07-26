import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TweetCard } from "../src/components/TweetCard.js";
import type { LinkableConcept } from "../src/lib/concept-links.js";
import { VocabularyContext } from "../src/lib/vocabulary.js";
import { pooledTweet } from "./fixtures.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");

const VOCABULARY: LinkableConcept[] = [{ slug: "vllm", name: "vLLM", aliases: ["vllm"] }];

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("TweetCard", () => {
  it("renders identity, text, date and the view-on-X link", () => {
    render(<TweetCard tweet={pooledTweet()} contributors={["osolmaz"]} now={NOW} />);
    expect(screen.getByText("Some One")).toBeDefined();
    expect(screen.getByText("@someone")).toBeDefined();
    expect(screen.getByText("hello world")).toBeDefined();
    expect(screen.getByText("May 20")).toBeDefined();
    expect(screen.getByText("View on X").getAttribute("href")).toBe(
      "https://x.com/someone/status/100",
    );
    expect(screen.getByText("⛏ osolmaz")).toBeDefined();
  });

  it("renders linkified mentions and a media grid", () => {
    const tweet = pooledTweet({
      text: "cc @alice",
      media: [
        { type: "photo", url: "https://pbs/1.jpg" },
        { type: "photo", url: "https://pbs/2.jpg" },
      ],
    });
    render(<TweetCard tweet={tweet} contributors={[]} now={NOW} />);
    expect(screen.getByText("@alice").getAttribute("href")).toBe("https://x.com/alice");
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("renders repost marker, article chip, quote link and metrics", () => {
    const tweet = pooledTweet({
      is_retweet: true,
      is_article: true,
      quoted_tweet_id: "42",
      metrics: { likes: 1234, replies: 5, retweets: 6, views: 90000 },
    });
    render(<TweetCard tweet={tweet} contributors={["alice", "osolmaz"]} now={NOW} />);
    expect(screen.getByText("reposted")).toBeDefined();
    expect(screen.getByText("article")).toBeDefined();
    expect(screen.getByText("View quoted post on X").getAttribute("href")).toBe(
      "https://x.com/i/status/42",
    );
    expect(screen.getByText("1.2K")).toBeDefined();
    expect(screen.getByText("90K")).toBeDefined();
    expect(screen.getByText("⛏ alice")).toBeDefined();
    expect(screen.getByText("⛏ osolmaz")).toBeDefined();
  });

  it("falls back to captured_at when created_at is absent", () => {
    const tweet = pooledTweet({ created_at: undefined });
    render(<TweetCard tweet={tweet} contributors={[]} now={NOW} />);
    expect(screen.getByText("May 21")).toBeDefined();
  });

  it("escapes raw markup in tweet text", () => {
    const tweet = pooledTweet({ text: "look <b>bold</b> & fine" });
    const { container } = render(<TweetCard tweet={tweet} contributors={[]} now={NOW} />);
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("look <b>bold</b> & fine")).toBeDefined();
  });

  it("links the first concept mention and navigates on click", () => {
    const tweet = pooledTweet({ text: "vllm is fast. I benchmarked vllm twice." });
    const { container } = render(
      <VocabularyContext.Provider value={VOCABULARY}>
        <TweetCard tweet={tweet} contributors={[]} now={NOW} />
      </VocabularyContext.Provider>,
    );
    const anchors = container.querySelectorAll("a.concept-link");
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0];
    expect(anchor?.getAttribute("href")).toBe("/graph/vllm");
    expect(anchor?.textContent).toBe("vllm");
    if (anchor !== undefined) fireEvent.click(anchor);
    expect(window.location.pathname).toBe("/graph/vllm");
  });

  it("renders plain text when the vocabulary is empty", () => {
    const tweet = pooledTweet({ text: "vllm is fast" });
    const { container } = render(<TweetCard tweet={tweet} contributors={[]} now={NOW} />);
    expect(container.querySelector("a.concept-link")).toBeNull();
    expect(screen.getByText("vllm is fast")).toBeDefined();
  });
});
