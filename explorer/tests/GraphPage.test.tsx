import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GraphPage } from "../src/components/GraphPage.js";

function stubApi(responses: Record<string, () => Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.split("?")[0] ?? url;
      return Promise.resolve(responses[path]?.() ?? new Response("missing", { status: 404 }));
    }),
  );
}

beforeEach(() => {
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("GraphPage", () => {
  it("renders the reusable force graph and sorted approved free-label index", async () => {
    stubApi({
      "/api/graph": () =>
        Response.json({
          nodes: [
            { name: "vllm", unit_count: 3 },
            { name: "sglang", unit_count: 2 },
          ],
          links: [{ source: "vllm", target: "sglang", weight: 2 }],
        }),
      "/api/free-labels": () =>
        Response.json({
          free_labels: [
            { name: "sglang", count: 2 },
            { name: "vllm", count: 3 },
          ],
        }),
    });
    render(<GraphPage />);
    await screen.findByText("All approved free labels");
    expect(screen.getByLabelText("Force-directed graph of approved free labels")).toBeDefined();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["vllm", "sglang"]);
    const [firstLink] = links;
    if (firstLink === undefined) throw new Error("expected free-label link");
    fireEvent.click(firstLink);
    expect(window.location.pathname).toBe("/graph/vllm");
  });

  it("keeps candidates out of the graph by showing the empty public state", async () => {
    stubApi({
      "/api/graph": () => Response.json({ nodes: [], links: [] }),
      "/api/free-labels": () => Response.json({ free_labels: [] }),
    });
    render(<GraphPage />);
    await screen.findByText("No approved free labels yet.");
  });

  it("surfaces graph request errors", async () => {
    stubApi({});
    render(<GraphPage />);
    await screen.findByText(/request failed: 404/);
  });

  it("leaves modified index clicks to the browser", async () => {
    stubApi({
      "/api/graph": () => Response.json({ nodes: [], links: [] }),
      "/api/free-labels": () => Response.json({ free_labels: [{ name: "vllm", count: 1 }] }),
    });
    render(<GraphPage />);
    const label = await screen.findByText("vllm");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    event.preventDefault();
    label.dispatchEvent(event);
    expect(window.location.pathname).toBe("/");
  });
});
