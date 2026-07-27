import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FreeLabelPage } from "../src/components/FreeLabelPage.js";
import { pooledTweet } from "./fixtures.js";

class FakeIntersectionObserver {
  observe(): void {
    /* noop */
  }
  unobserve(): void {
    /* noop */
  }
  disconnect(): void {
    /* noop */
  }
}

function stubApi(responses: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.split("?")[0] ?? url;
    return Promise.resolve(responses[path]?.() ?? new Response("missing", { status: 404 }));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("FreeLabelPage", () => {
  it("shows an approved label, related labels, and a feed filtered by its exact name", async () => {
    const fetchMock = stubApi({
      "/api/free-labels/vllm": () =>
        Response.json({
          name: "vllm",
          tweet_count: 3,
          related: [{ name: "sglang", shared_units: 2 }],
        }),
      "/api/tweets": () =>
        Response.json({
          records: [{ tweet: pooledTweet({ text: "served by vllm" }), contributors: [] }],
        }),
    });
    render(<FreeLabelPage slug="vllm" />);
    await screen.findByText("served by vllm");
    expect(screen.getByText("3 posts")).toBeDefined();
    const related = screen.getByText("sglang");
    expect(related.getAttribute("href")).toBe("/graph/sglang");
    fireEvent.click(related);
    expect(window.location.pathname).toBe("/graph/sglang");
    const tweetRequest = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.startsWith("/api/tweets"));
    expect(new URLSearchParams(tweetRequest?.split("?")[1] ?? "").get("free_label")).toBe("vllm");
  });

  it("surfaces missing-label errors", async () => {
    stubApi({});
    render(<FreeLabelPage slug="missing" />);
    await screen.findByText(/request failed: 404/);
  });
});
