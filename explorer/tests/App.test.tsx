import { act, cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
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
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
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

function poolResponse(members: readonly string[]): Response {
  return Response.json({
    pool: {
      version: 1,
      admins: ["osolmaz"],
      members,
      member_orgs: [],
      bootstrap_admins: ["osolmaz"],
      updated_at: "2026-07-06T00:00:00.000Z",
      source: "dataset",
    },
    viewer: { username: "osolmaz" },
  });
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
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: false }),
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
    expect(screen.getByText("Install")).toBeDefined();
    expect(screen.getByText("Captured by")).toBeDefined();
  });

  it("shows extension setup in the install tab", async () => {
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: false }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/tweets": () => Response.json({ records: [] }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText("Install"));
    await screen.findByText("Install extension");
    expect(screen.getByText("Copy command")).toBeDefined();
    expect(screen.getByText(/xtap-pool-main\/extension/)).toBeDefined();
    expect(screen.getByText("~/.local/share/xtap-pool-extension")).toBeDefined();
    expect(screen.getByText("Connect").getAttribute("href")).toBe("/connect");
  });

  it("navigates between the feed and the concept graph", async () => {
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: false }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/tweets": () =>
        Response.json({ records: [{ tweet: pooledTweet(), contributors: ["osolmaz"] }] }),
      "/api/labels": () => Response.json({ labels: [{ name: "ai", count: 2 }] }),
      "/api/concepts": () =>
        Response.json({
          concepts: [{ slug: "vllm", name: "vLLM", aliases: ["vllm"], post_count: 3 }],
        }),
      "/api/graph": () =>
        Response.json({ nodes: [{ id: "vllm", name: "vLLM", docs: 3, group: 0 }], links: [] }),
    });
    render(<App />);
    await screen.findByText("hello world");

    fireEvent.click(screen.getByText("Graph"));
    await screen.findByText("Concept graph");
    expect(window.location.pathname).toBe("/graph");
    expect(screen.getByText("All concepts")).toBeDefined();
    expect(screen.queryByText("Captured by")).toBeNull();

    fireEvent.click(screen.getByText("Feed"));
    await screen.findByText("hello world");
    expect(window.location.pathname).toBe("/");
    expect(screen.getByText("Captured by")).toBeDefined();
  });

  it("shows label chips and the concept picker once enrichment data loads", async () => {
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: false }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/tweets": () => Response.json({ records: [] }),
      "/api/labels": () => Response.json({ labels: [{ name: "ai", count: 2 }] }),
      "/api/concepts": () =>
        Response.json({
          concepts: [{ slug: "vllm", name: "vLLM", aliases: ["vllm"], post_count: 3 }],
        }),
    });
    render(<App />);
    await screen.findByText("Labels");
    expect(screen.getByRole("button", { name: /^ai/ })).toBeDefined();
    expect(screen.getByLabelText("Concept")).toBeDefined();
  });

  it("refreshes relative timestamps while the feed is visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: false }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/tweets": () =>
        Response.json({
          records: [
            {
              tweet: pooledTweet({
                created_at: "2026-07-06T11:59:01.000Z",
                captured_at: "2026-07-06T11:59:01.000Z",
              }),
              contributors: [],
            },
          ],
        }),
    });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("hello world")).toBeDefined();
    expect(screen.getByText("now")).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(screen.getByText("1m")).toBeDefined();
  });

  it("loads the next page via the load-more button", async () => {
    let call = 0;
    stubApi({
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: false }),
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
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: false }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/tweets": () => new Response("boom", { status: 500 }),
    });
    render(<App />);
    await screen.findByText(/request failed: 500/);
  });

  it("lets admins add pool members", async () => {
    const routes: Record<string, (init?: RequestInit) => Response> = {
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: true }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/tweets": () => Response.json({ records: [] }),
      "/api/admin/pool": () => poolResponse(["osolmaz"]),
      "/api/admin/members/alice": (init) =>
        init?.method === "PUT"
          ? poolResponse(["alice", "osolmaz"])
          : new Response("missing", { status: 404 }),
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.split("?")[0] ?? url;
      return Promise.resolve(routes[path]?.(init) ?? new Response("missing", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByText("Admin"));
    fireEvent.change(await screen.findByLabelText("Member username"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByText("Add member"));
    await screen.findByText("@alice");
  });

  it("lets admins set the member organization", async () => {
    const routes: Record<string, (init?: RequestInit) => Response> = {
      "/api/me": () => Response.json({ username: "osolmaz", isAdmin: true }),
      "/api/contributors": () => Response.json({ contributors: [] }),
      "/api/tweets": () => Response.json({ records: [] }),
      "/api/admin/pool": () => poolResponse(["osolmaz"]),
      "/api/admin/member-orgs/huggingface": (init) =>
        init?.method === "PUT"
          ? Response.json({
              pool: {
                version: 1,
                admins: ["osolmaz"],
                members: ["osolmaz"],
                member_orgs: [{ name: "huggingface", sub: "org-hf", display_name: "Hugging Face" }],
                bootstrap_admins: ["osolmaz"],
                updated_at: "2026-07-06T00:00:00.000Z",
                source: "dataset",
              },
              viewer: { username: "osolmaz" },
            })
          : new Response("missing", { status: 404 }),
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.split("?")[0] ?? url;
      return Promise.resolve(routes[path]?.(init) ?? new Response("missing", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByText("Admin"));
    fireEvent.change(await screen.findByLabelText("Member organization"), {
      target: { value: "huggingface" },
    });
    fireEvent.click(screen.getByText("Set org"));
    await screen.findByText("@huggingface");
  });
});
