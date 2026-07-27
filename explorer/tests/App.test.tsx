import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App.js";
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

function stubApi(responses: Record<string, () => Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.split("?")[0] ?? url;
      const response = responses[path];
      return Promise.resolve(response?.() ?? new Response("missing", { status: 404 }));
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("App", () => {
  it("shows the sign-in screen when unauthenticated", async () => {
    stubApi({ "/api/me": () => new Response("no", { status: 401 }) });
    render(<App />);
    const signIn = await screen.findByText("Sign in with Hugging Face");
    expect(signIn.getAttribute("href")).toBe("/oauth/login?next=/");
  });

  it("renders the approved free-label filters and switches between feed, graph, and install", async () => {
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: false }),
      "/api/contributors": () =>
        Response.json({
          contributors: [{ username: "osolmaz", tweetCount: 1, lastPooledAt: "now" }],
        }),
      "/api/labels": () => Response.json({ labels: [{ name: "ai", count: 2 }] }),
      "/api/free-labels": () => Response.json({ free_labels: [{ name: "vllm", count: 3 }] }),
      "/api/tweets": () =>
        Response.json({ records: [{ tweet: pooledTweet(), contributors: ["osolmaz"] }] }),
      "/api/graph": () => Response.json({ nodes: [], links: [] }),
    });
    render(<App />);
    await screen.findByText("hello world");
    expect(screen.getByLabelText("Free label")).toBeDefined();
    fireEvent.click(screen.getByText("Graph"));
    await screen.findByText("All approved free labels");
    expect(window.location.pathname).toBe("/graph");
    fireEvent.click(screen.getByText("Install"));
    await screen.findByText("Install extension");
    fireEvent.click(screen.getByText("Feed"));
    await screen.findByText("hello world");
  });

  it("loads subsequent feed pages and reports request failures", async () => {
    let reads = 0;
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: false }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/labels": () => Response.json({ labels: [] }),
      "/api/free-labels": () => Response.json({ free_labels: [] }),
      "/api/tweets": () => {
        reads += 1;
        if (reads === 1)
          return Response.json({
            records: [{ tweet: pooledTweet({ id: "1", text: "first" }), contributors: [] }],
            nextCursor: "next",
          });
        if (reads === 2)
          return Response.json({
            records: [{ tweet: pooledTweet({ id: "2", text: "second" }), contributors: [] }],
          });
        return new Response("boom", { status: 500 });
      },
    });
    render(<App />);
    await screen.findByText("first");
    fireEvent.click(screen.getByText("Load more"));
    await screen.findByText("second");
  });

  it("surfaces feed request errors without hiding the signed-in shell", async () => {
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: false }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/labels": () => Response.json({ labels: [] }),
      "/api/free-labels": () => Response.json({ free_labels: [] }),
      "/api/tweets": () => new Response("boom", { status: 500 }),
    });
    render(<App />);
    await screen.findByText(/request failed: 500/);
    expect(screen.getByText("signed in as @osolmaz")).toBeDefined();
  });
});
