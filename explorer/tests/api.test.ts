/* eslint-disable complexity, @typescript-eslint/no-base-to-string */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultFilters,
  addPoolAdmin,
  addPoolMember,
  addPoolMemberOrg,
  fetchAdminEnrichment,
  fetchAdminFreeLabels,
  fetchAdminPool,
  fetchAdminServiceAccounts,
  fetchContributors,
  fetchFreeLabel,
  fetchFreeLabelGraph,
  fetchFreeLabels,
  fetchLabels,
  fetchMe,
  fetchTweets,
  issueServiceAccount,
  removePoolAdmin,
  removePoolMember,
  removePoolMemberOrg,
  repairPoolConfig,
  repairServiceAccounts,
  revokeServiceAccount,
  revokeServiceAccountKey,
  rotateServiceAccount,
  tweetsQueryString,
} from "../src/lib/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("tweetsQueryString", () => {
  it("serializes the approved free-label contract and omits empty values", () => {
    expect(tweetsQueryString(defaultFilters)).toBe("dedup=true");
    expect(
      tweetsQueryString(
        {
          ...defaultFilters,
          contributors: ["alice", "bob"],
          labels: ["ai"],
          freeLabel: "vllm",
          q: "serve",
          until: "2026-07-01",
          hasMedia: true,
        },
        "next",
      ),
    ).toBe(
      "contributors=alice%2Cbob&labels=ai&free_label=vllm&q=serve&until=2026-07-01T23%3A59%3A59.999Z&has_media=true&dedup=true&cursor=next",
    );
  });
});

describe("explorer API", () => {
  it("maps public free-label endpoints and graph communities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input).split("?")[0];
        if (path === "/api/free-labels")
          return Response.json({ free_labels: [{ name: "vllm", count: 4 }] });
        if (path === "/api/free-labels/vllm")
          return Response.json({
            name: "vllm",
            tweet_count: 4,
            related: [{ name: "sglang", shared_units: 2 }],
          });
        if (path === "/api/graph")
          return Response.json({
            nodes: [
              { name: "vllm", unit_count: 4 },
              { name: "sglang", unit_count: 2 },
            ],
            links: [{ source: "vllm", target: "sglang", weight: 2 }],
          });
        return new Response("missing", { status: 404 });
      }),
    );
    await expect(fetchFreeLabels()).resolves.toEqual([{ name: "vllm", post_count: 4 }]);
    await expect(fetchFreeLabel("vllm")).resolves.toEqual({
      name: "vllm",
      post_count: 4,
      related: [{ name: "sglang", shared: 2 }],
    });
    await expect(fetchFreeLabelGraph(300)).resolves.toEqual({
      nodes: [
        { id: "vllm", name: "vllm", docs: 4, group: 0 },
        { id: "sglang", name: "sglang", docs: 2, group: 0 },
      ],
      links: [{ source: "vllm", target: "sglang", weight: 2 }],
    });
  });

  it("maps authenticated viewer, filter, taxonomy, and contributor reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input).split("?")[0];
        if (path === "/api/me") return Response.json({ username: "alice", isAdmin: true });
        if (path === "/api/tweets") return Response.json({ records: [], nextCursor: "next" });
        if (path === "/api/contributors")
          return Response.json({
            contributors: [{ username: "alice", tweetCount: 1, lastPooledAt: "now" }],
          });
        if (path === "/api/labels")
          return Response.json({ labels: [{ name: "ai", description: "AI", count: 2 }] });
        return new Response("missing", { status: 404 });
      }),
    );
    await expect(fetchMe()).resolves.toEqual({ username: "alice", isAdmin: true });
    await expect(fetchTweets(defaultFilters)).resolves.toEqual({ records: [], nextCursor: "next" });
    await expect(fetchContributors()).resolves.toEqual([
      { username: "alice", tweetCount: 1, lastPooledAt: "now" },
    ]);
    await expect(fetchLabels()).resolves.toEqual([{ name: "ai", description: "AI", count: 2 }]);
  });

  it("turns unauthenticated reads into their documented states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("no", { status: 401 })),
    );
    await expect(fetchMe()).resolves.toBeUndefined();
    await expect(fetchFreeLabels()).rejects.toThrow("session expired");
  });

  it("uses the authenticated administration endpoints with encoded identifiers", async () => {
    const account = {
      id: "reader",
      name: "reader",
      status: "active",
      scopes: [],
      created_at: "now",
      updated_at: "now",
      keys: [],
    };
    const pool = {
      version: 1 as const,
      admins: [],
      members: [],
      member_orgs: [],
      bootstrap_admins: [],
      updated_at: "now",
      source: "bucket" as const,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/admin/pool")
          return Response.json({ pool, viewer: { username: "root" } });
        if (path === "/api/admin/enrichment")
          return Response.json({
            contract_hash: "hash",
            totals: { pending: 0, running: 0, retrying: 0, blocked: 0, completed: 0 },
            worker_recently_completed: false,
            recent_errors: [],
          });
        if (path === "/api/admin/free-labels")
          return Response.json({ registry_revision: 1, labels: [], candidates: [] });
        if (path === "/api/admin/service-accounts")
          return Response.json({
            service_accounts: { version: 1, accounts: [], source: "bucket" },
          });
        if (path === "/api/admin/service-accounts/repair")
          return Response.json({
            service_accounts: { version: 1, accounts: [], source: "bucket" },
          });
        if (path.includes("/keys") && !path.endsWith("/key%201"))
          return Response.json({ account, token: "token" });
        if (path === "/api/admin/service-accounts")
          return Response.json({ account, token: "token" });
        if (path.includes("service-accounts")) return Response.json({ account });
        return Response.json({ pool });
      }),
    );
    await Promise.all([
      fetchAdminPool(),
      fetchAdminEnrichment(),
      fetchAdminFreeLabels(),
      fetchAdminServiceAccounts(),
      repairPoolConfig(),
      repairServiceAccounts(),
      issueServiceAccount("reader", ["units:read"]),
      rotateServiceAccount("reader id"),
      revokeServiceAccount("reader id"),
      revokeServiceAccountKey("reader id", "key 1"),
      addPoolMember("alice bob"),
      removePoolMember("alice bob"),
      addPoolAdmin("alice bob"),
      removePoolAdmin("alice bob"),
      addPoolMemberOrg("my org"),
      removePoolMemberOrg("my org"),
    ]);
  });
});
