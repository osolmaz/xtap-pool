import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultFilters,
  addPoolAdmin,
  addPoolMember,
  fetchContributors,
  fetchAdminPool,
  fetchMe,
  fetchTweets,
  removePoolAdmin,
  removePoolMember,
  addPoolMemberOrg,
  removePoolMemberOrg,
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
    await expect(addPoolMember("alice")).resolves.toEqual(pool);
    await expect(removePoolMember("alice")).resolves.toEqual(pool);
    await expect(addPoolAdmin("alice")).resolves.toEqual(pool);
    await expect(removePoolAdmin("alice")).resolves.toEqual(pool);
    await expect(addPoolMemberOrg("huggingface")).resolves.toEqual(pool);
    await expect(removePoolMemberOrg("huggingface")).resolves.toEqual(pool);
  });
});
