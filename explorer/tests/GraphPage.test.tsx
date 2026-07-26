import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GraphPage } from "../src/components/GraphPage.js";

function stubApi(responses: Record<string, () => Response>): void {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.split("?")[0] ?? url;
    const responder = responses[path];
    if (responder === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
    return Promise.resolve(responder());
  });
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("GraphPage", () => {
  it("renders the graph canvas and the concept index sorted by posts", async () => {
    stubApi({
      "/api/graph": () =>
        Response.json({
          nodes: [
            { slug: "vllm", name: "vLLM", unit_count: 3 },
            { slug: "sglang", name: "SGLang", unit_count: 2 },
          ],
          links: [{ source: "vllm", target: "sglang", weight: 2 }],
        }),
      "/api/concepts": () =>
        Response.json({
          concepts: [
            { slug: "sglang", name: "SGLang", aliases: [], unit_count: 2 },
            { slug: "vllm", name: "vLLM", aliases: ["vllm"], unit_count: 3 },
          ],
        }),
    });
    render(<GraphPage />);
    await screen.findByText("All concepts");
    expect(screen.getByLabelText("Force-directed graph of concepts")).toBeDefined();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["vLLM", "SGLang"]);
    expect(links[0]?.getAttribute("href")).toBe("/graph/vllm");

    const first = links[0];
    if (first !== undefined) fireEvent.click(first);
    expect(window.location.pathname).toBe("/graph/vllm");
  });

  it("shows an empty state before any enrichment exists", async () => {
    stubApi({
      "/api/graph": () => Response.json({ nodes: [], links: [] }),
      "/api/concepts": () => Response.json({ concepts: [] }),
    });
    render(<GraphPage />);
    await screen.findByText(/No concepts yet/);
  });

  it("surfaces fetch errors", async () => {
    stubApi({});
    render(<GraphPage />);
    await screen.findByText(/request failed: 404/);
  });
});
