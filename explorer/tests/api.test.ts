import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultFilters,
  addPoolAdmin,
  addPoolMember,
  fetchConcept,
  fetchConceptGraph,
  fetchConcepts,
  fetchContributors,
  fetchAdminPool,
  fetchLabels,
  fetchMe,
  fetchTweets,
  removePoolAdmin,
  removePoolMember,
  addPoolMemberOrg,
  removePoolMemberOrg,
  repairPoolConfig,
  tweetsQueryString,
} from "../src/lib/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tweetsQueryString", () => {
  it("serializes default filters to just dedup", () => {
    expect(tweetsQueryString(defaultFilters)).toBe("dedup=true");
  });

  it("serializes all active filters and the cursor", () => {
    const query = tweetsQueryString(
      {
        contributors: ["osolmaz", "alice"],
        labels: ["ai", "agents"],
        concept: "vllm",
        q: "vllm",
        since: "2026-05-01",
        until: "2026-05-31",
        hasMedia: true,
        isArticle: true,
        dedup: false,
      },
      "CURSOR",
    );
    const params = new URLSearchParams(query);
    expect(params.get("contributors")).toBe("osolmaz,alice");
    expect(params.get("labels")).toBe("ai,agents");
    expect(params.get("concept")).toBe("vllm");
    expect(params.get("q")).toBe("vllm");
    expect(params.get("since")).toBe("2026-05-01");
    expect(params.get("until")).toBe("2026-05-31T23:59:59.999Z");
    expect(params.get("has_media")).toBe("true");
    expect(params.get("is_article")).toBe("true");
    expect(params.get("dedup")).toBe("false");
    expect(params.get("cursor")).toBe("CURSOR");
  });
});

describe("api client", () => {
  it("fetchMe returns the user or undefined on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ username: "osolmaz", isAdmin: true })),
    );
    await expect(fetchMe()).resolves.toEqual({ username: "osolmaz", isAdmin: true });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 401 })));
    await expect(fetchMe()).resolves.toBeUndefined();
  });

  it("fetchTweets returns pages and throws on expiry or server errors", async () => {
    const page = { records: [], nextCursor: "abc" };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(page));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchTweets(defaultFilters)).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith("/api/tweets?dedup=true", expect.anything());

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 401 })));
    await expect(fetchTweets(defaultFilters)).rejects.toThrow("session expired");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await expect(fetchTweets(defaultFilters)).rejects.toThrow("request failed: 500");
  });

  it("fetchContributors unwraps the contributors list", async () => {
    const contributors = [{ username: "osolmaz", tweetCount: 2, lastPooledAt: "2026-07-06" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ contributors })));
    await expect(fetchContributors()).resolves.toEqual(contributors);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 401 })));
    await expect(fetchContributors()).rejects.toThrow("session expired");
  });

  it("fetches labels, concepts, one concept and the graph", async () => {
    const labels = [{ name: "ai", description: "AI posts", count: 12 }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ labels })));
    await expect(fetchLabels()).resolves.toEqual(labels);

    const apiConcepts = [{ slug: "vllm", name: "vLLM", aliases: ["vllm"], unit_count: 3 }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ concepts: apiConcepts })));
    await expect(fetchConcepts()).resolves.toEqual([
      { slug: "vllm", name: "vLLM", aliases: ["vllm"], post_count: 3 },
    ]);

    const apiDetail = {
      slug: "vllm",
      name: "vLLM",
      aliases: ["vllm"],
      unit_count: 3,
      tweet_count: 3,
      related: [{ slug: "sglang", name: "SGLang", shared_units: 2 }],
    };
    const detailMock = vi.fn().mockResolvedValue(Response.json(apiDetail));
    vi.stubGlobal("fetch", detailMock);
    await expect(fetchConcept("vllm")).resolves.toEqual({
      name: "vLLM",
      aliases: ["vllm"],
      related: [{ slug: "sglang", name: "SGLang", shared: 2 }],
      post_count: 3,
    });
    expect(detailMock).toHaveBeenCalledWith("/api/concepts/vllm", expect.anything());

    const apiGraph = {
      nodes: [
        { slug: "vllm", name: "vLLM", unit_count: 3 },
        { slug: "sglang", name: "SGLang", unit_count: 2 },
      ],
      links: [{ source: "vllm", target: "sglang", weight: 2 }],
    };
    const graphMock = vi.fn().mockResolvedValue(Response.json(apiGraph));
    vi.stubGlobal("fetch", graphMock);
    await expect(fetchConceptGraph(300)).resolves.toEqual({
      nodes: [
        { id: "vllm", name: "vLLM", docs: 3, group: 0 },
        { id: "sglang", name: "SGLang", docs: 2, group: 0 },
      ],
      links: [{ source: "vllm", target: "sglang", weight: 2 }],
    });
    expect(graphMock).toHaveBeenCalledWith("/api/graph?top=300", expect.anything());
  });

  it("throws session expired for enrichment endpoints on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 401 })));
    await expect(fetchLabels()).rejects.toThrow("session expired");
    await expect(fetchConcepts()).rejects.toThrow("session expired");
    await expect(fetchConcept("vllm")).rejects.toThrow("session expired");
    await expect(fetchConceptGraph(300)).rejects.toThrow("session expired");
  });

  it("manages pool membership through admin endpoints", async () => {
    const pool = {
      version: 1,
      admins: ["osolmaz"],
      members: ["osolmaz"],
      member_orgs: [{ name: "huggingface", sub: "org-hf", display_name: "Hugging Face" }],
      bootstrap_admins: ["osolmaz"],
      updated_at: "2026-07-06T00:00:00.000Z",
      source: "dataset",
    };
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ pool, viewer: { username: "osolmaz" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAdminPool()).resolves.toEqual({ pool, viewer: { username: "osolmaz" } });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(Response.json({ pool }))),
    );
    await expect(repairPoolConfig()).resolves.toEqual(pool);
    await expect(addPoolMember("alice")).resolves.toEqual(pool);
    await expect(removePoolMember("alice")).resolves.toEqual(pool);
    await expect(addPoolAdmin("alice")).resolves.toEqual(pool);
    await expect(removePoolAdmin("alice")).resolves.toEqual(pool);
    await expect(addPoolMemberOrg("huggingface")).resolves.toEqual(pool);
    await expect(removePoolMemberOrg("huggingface")).resolves.toEqual(pool);
  });
});
