import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App.js";
import { pooledTweet } from "./fixtures.js";

class FakeIntersectionObserver {
  observe(): void {
    /* noop: load-more is exercised via the button */
  }
  unobserve(): void {
    /* noop */
  }
  disconnect(): void {
    /* noop */
  }
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubApi(responses: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.split("?")[0] ?? url;
    const responder = responses[path];
    if (responder === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
    return Promise.resolve(responder());
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("App", () => {
  it("shows the sign-in screen when unauthenticated", async () => {
    stubApi({ "/api/me": () => new Response("no", { status: 401 }) });
    render(<App />);
    const link = await screen.findByText("Sign in with Hugging Face");
    expect(link.getAttribute("href")).toBe("/oauth/login?next=/");
  });

  it("renders the feed and filters when signed in", async () => {
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz" }),
      "/api/contributors": () =>
        Response.json({
          contributors: [
            { username: "osolmaz", tweetCount: 1, lastPooledAt: "2026-07-06T00:00:00.000Z" },
          ],
        }),
      "/api/tweets": () =>
        Response.json({
          records: [{ tweet: pooledTweet(), contributors: ["osolmaz"] }],
        }),
    });
    render(<App />);
    await screen.findByText("hello world");
    expect(screen.getByText("signed in as @osolmaz")).toBeDefined();
    expect(screen.getByText("Captured by")).toBeDefined();
  });

  it("loads the next page via the load-more button", async () => {
    let call = 0;
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz" }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/tweets": () => {
        call += 1;
        return call === 1
          ? Response.json({
              records: [{ tweet: pooledTweet({ id: "1", text: "first page" }), contributors: [] }],
              nextCursor: "next",
            })
          : Response.json({
              records: [{ tweet: pooledTweet({ id: "2", text: "second page" }), contributors: [] }],
            });
      },
    });
    render(<App />);
    await screen.findByText("first page");
    fireEvent.click(screen.getByText("Load more"));
    await screen.findByText("second page");
    expect(screen.getByText("first page")).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText("Load more")).toBeNull();
    });
  });

  it("surfaces feed errors", async () => {
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz" }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/tweets": () => new Response("boom", { status: 500 }),
    });
    render(<App />);
    await screen.findByText(/request failed: 500/);
  });
});
