import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { ConceptPage } from "../src/components/ConceptPage.js";
import { pooledTweet } from "./fixtures.js";

type FetchLike = (input: RequestInfo | URL) => Promise<Response>;

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

function stubApi(responses: Record<string, () => Response>): Mock<FetchLike> {
  const fetchMock = vi.fn<FetchLike>((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.split("?")[0] ?? url;
    const responder = responses[path];
    if (responder === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
    return Promise.resolve(responder());
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("ConceptPage", () => {
  it("renders the concept header, related chips and its posts", async () => {
    const fetchMock = stubApi({
      "/api/concepts/vllm": () =>
        Response.json({
          name: "vLLM",
          aliases: ["vllm", "vLLM engine"],
          slug: "vllm",
          unit_count: 3,
          related: [{ slug: "sglang", name: "SGLang", shared_units: 2 }],
          tweet_count: 3,
        }),
      "/api/tweets": () =>
        Response.json({
          records: [
            { tweet: pooledTweet({ text: "serving with vllm" }), contributors: ["osolmaz"] },
          ],
        }),
    });
    render(<ConceptPage slug="vllm" />);
    await screen.findByText("vLLM");
    expect(screen.getByText("Also referred to as: vllm, vLLM engine")).toBeDefined();
    expect(screen.getByText("3 posts")).toBeDefined();

    const related = screen.getByText("SGLang");
    expect(related.getAttribute("href")).toBe("/graph/sglang");

    await screen.findByText("serving with vllm");
    const tweetsCall = fetchMock.mock.calls
      .map(([input]) => (typeof input === "string" ? input : ""))
      .find((url) => url.startsWith("/api/tweets"));
    expect(tweetsCall).toBeDefined();
    const params = new URLSearchParams(tweetsCall?.split("?")[1] ?? "");
    expect(params.get("concept")).toBe("vllm");
    expect(params.get("dedup")).toBe("true");

    fireEvent.click(related);
    expect(window.location.pathname).toBe("/graph/sglang");
  });

  it("surfaces fetch errors", async () => {
    stubApi({});
    render(<ConceptPage slug="missing" />);
    await screen.findByText(/request failed: 404/);
  });
});
