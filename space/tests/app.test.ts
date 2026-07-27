import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EnrichReceipt } from "@xtap-pool/shared";

import { createApp } from "../src/app.js";
import type { EnrichDeps } from "../src/app.js";
import { DatasetMirror } from "../src/dataset.js";
import { DEFAULT_TAXONOMY } from "../src/enrich-config.js";
import { EnrichStore } from "../src/enrich-store.js";
import { Mutex, ingestBatch } from "../src/ingest.js";
import { PoolMembership } from "../src/membership.js";
import { mintPoolToken } from "../src/pool-token.js";
import { ServiceAccountRegistry } from "../src/service-accounts.js";
import { TweetStore } from "../src/store.js";
import { UnitStore } from "../src/unit-store.js";
import { FakeHub, makeTweet, testConfig } from "./helpers.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");

const EMPTY_RECEIPT: EnrichReceipt = {
  started_at: NOW.toISOString(),
  finished_at: NOW.toISOString(),
  units: 0,
  calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  failures: 0,
};

let dir: string;
let hub: FakeHub;
let store: TweetStore;
let app: Hono;
let membership: PoolMembership;
let serviceAccounts: ServiceAccountRegistry;
let unitStore: UnitStore;
let enrich: EnrichDeps;

function sessionCookie(
  username: string,
  orgs: readonly { sub: string; name?: string }[] = [],
): string {
  return `xtap_pool_session=${mintPoolToken(testConfig.sessionSecret, { username, orgs }, FUTURE)}`;
}

function bearer(username: string, orgs: readonly { sub: string; name?: string }[] = []): string {
  return `Bearer ${mintPoolToken(testConfig.poolSigningSecret, { username, orgs }, FUTURE)}`;
}

function sessionCookieFrom(setCookie: string | null): string {
  return /xtap_pool_session=[^;,]+/.exec(setCookie ?? "")?.[0] ?? "";
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "xtap-pool-app-"));
  hub = new FakeHub();
  store = new TweetStore();
  const mirror = new DatasetMirror(hub, dir);
  membership = await PoolMembership.load({
    mirror,
    bootstrapMembers: testConfig.allowedUsers,
    bootstrapAdmins: testConfig.poolAdmins,
    now: () => NOW,
  });
  serviceAccounts = await ServiceAccountRegistry.load({ mirror, now: () => NOW });
  const mutex = new Mutex();
  enrich = {
    store: new EnrichStore(store.database, 1, () => NOW),
    taxonomy: { labels: DEFAULT_TAXONOMY, version: 1, source: "default" },
    run: () => Promise.resolve(EMPTY_RECEIPT),
  };
  unitStore = new UnitStore(store.database, 1);
  app = createApp({
    config: testConfig,
    store,
    membership,
    serviceAccounts,
    unitStore,
    enrich,
    now: () => NOW,
    ingest: (username, payload) =>
      mutex.run(() =>
        ingestBatch({ store, mirror, enrich: enrich.store, now: () => NOW }, username, payload),
      ),
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("health", () => {
  it("reports ok with the tweet count", async () => {
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, tweets: 0 });
  });

  it("reports structured readiness when provided", async () => {
    const readyApp = createApp({
      config: testConfig,
      store,
      membership,
      serviceAccounts,
      unitStore,
      enrich,
      ingest: () => Promise.resolve({ ok: true, added: 0, duplicates: 0, rejected: [] }),
      readiness: () => ({
        ok: false,
        dataset: {
          indexed_files: 1,
          indexed_tweets: 0,
          enrichment_rows: 0,
          credential: "ok",
          state: "ready",
        },
        enrichment: {
          enabled: true,
          model: "zai-org/GLM-5.2",
          credential: "invalid",
          credential_error: "INFERENCE_TOKEN must include inference.serverless.write.",
          state: "ready",
        },
      }),
    });
    const healthResponse = await readyApp.request("/healthz");
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({ ok: true, tweets: 0 });
    expect((await readyApp.request("/api/tweets")).status).toBe(503);
    expect((await readyApp.request("/oauth/login")).status).toBe(503);

    const response = await readyApp.request("/readyz");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      tweets: 0,
      readiness: { dataset: { indexed_files: 1, indexed_tweets: 0 } },
    });
  });

  it("lets a bootstrap admin authenticate and repair malformed membership", async () => {
    hub.files.set("config/pool.json", "not json");
    const brokenMembership = await PoolMembership.load({
      mirror: new DatasetMirror(hub, dir),
      bootstrapMembers: testConfig.allowedUsers,
      bootstrapAdmins: testConfig.poolAdmins,
      now: () => NOW,
    });
    const recoveryApp = createApp({
      config: testConfig,
      store,
      membership: brokenMembership,
      serviceAccounts,
      unitStore,
      enrich,
      now: () => NOW,
      ingest: () => Promise.resolve({ ok: true, added: 0, duplicates: 0, rejected: [] }),
      readiness: () => ({
        ok: !brokenMembership.hasConfigError(),
        dataset: {
          indexed_files: 1,
          indexed_tweets: 0,
          enrichment_rows: 0,
          credential: "ok",
          state: brokenMembership.hasConfigError() ? "invalid" : "ready",
        },
        enrichment: {
          enabled: false,
          model: testConfig.llmModel,
          credential: "not_required",
          state: "disabled",
        },
      }),
    });
    const headers = { cookie: sessionCookie("osolmaz") };

    expect((await recoveryApp.request("/oauth/login")).status).toBe(302);
    expect((await recoveryApp.request("/api/me", { headers })).status).toBe(200);
    expect((await recoveryApp.request("/api/admin/pool", { headers })).status).toBe(200);
    expect((await recoveryApp.request("/api/tweets", { headers })).status).toBe(503);
    expect((await recoveryApp.request("/api/admin/pool/repair", { method: "POST" })).status).toBe(
      401,
    );

    const repaired = await recoveryApp.request("/api/admin/pool/repair", {
      method: "POST",
      headers,
    });
    expect(repaired.status).toBe(200);
    await expect(repaired.json()).resolves.toMatchObject({
      pool: { source: "dataset", members: ["alice", "osolmaz"] },
    });
    expect((await recoveryApp.request("/api/tweets", { headers })).status).toBe(200);
  });
});

describe("/api/ingest", () => {
  it("rejects missing, malformed and disallowed tokens", async () => {
    const body = JSON.stringify({ tweets: [makeTweet()] });
    const post = async (headers: Record<string, string>): Promise<Response> =>
      app.request("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer garbage" })).status).toBe(401);
    expect((await post({ authorization: bearer("mallory") })).status).toBe(401);
    const sessionSigned = mintPoolToken(testConfig.sessionSecret, "osolmaz", FUTURE);
    expect((await post({ authorization: `Bearer ${sessionSigned}` })).status).toBe(401);
  });

  it("ingests a batch for a valid pool token", async () => {
    const response = await app.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearer("osolmaz") },
      body: JSON.stringify({ tweets: [makeTweet()] }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ added: 1, duplicates: 0, rejected: [] });
    expect(hub.commits).toHaveLength(1);
  });

  it("rejects non-JSON bodies and surfaces persistence failures", async () => {
    const bad = await app.request("/api/ingest", {
      method: "POST",
      headers: { authorization: bearer("osolmaz") },
      body: "not json",
    });
    expect(bad.status).toBe(400);
    hub.failNextCommit = true;
    const failed = await app.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearer("osolmaz") },
      body: JSON.stringify({ tweets: [makeTweet()] }),
    });
    expect(failed.status).toBe(500);
  });
});

describe("session-guarded reads", () => {
  it("rejects unauthenticated tweet queries", async () => {
    expect((await app.request("/api/tweets")).status).toBe(401);
    expect((await app.request("/api/contributors")).status).toBe(401);
    expect((await app.request("/api/me")).status).toBe(401);
  });

  it("serves tweets, contributors and identity for a valid session", async () => {
    await app.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearer("alice") },
      body: JSON.stringify({ tweets: [makeTweet()] }),
    });
    const headers = { cookie: sessionCookie("osolmaz") };
    const tweets = (await (await app.request("/api/tweets", { headers })).json()) as {
      records: { tweet: { id: string }; contributors: string[] }[];
    };
    expect(tweets.records).toHaveLength(1);
    expect(tweets.records[0]?.contributors).toEqual(["alice"]);

    const contributors = await (await app.request("/api/contributors", { headers })).json();
    expect(contributors).toEqual({
      contributors: [{ username: "alice", tweetCount: 1, lastPooledAt: NOW.toISOString() }],
    });

    await expect((await app.request("/api/me", { headers })).json()).resolves.toEqual({
      username: "osolmaz",
      isAdmin: true,
    });
    const viaBearer = await app.request("/api/me", {
      headers: { authorization: bearer("alice") },
    });
    await expect(viaBearer.json()).resolves.toEqual({ username: "alice", isAdmin: false });
  });

  it("rejects invalid query parameters", async () => {
    const response = await app.request("/api/tweets?limit=99999", {
      headers: { cookie: sessionCookie("osolmaz") },
    });
    expect(response.status).toBe(400);
  });
});

describe("enrichment endpoints", () => {
  const headers = { cookie: sessionCookie("osolmaz") };

  async function seedEnrichedTweets(): Promise<void> {
    await app.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearer("alice") },
      body: JSON.stringify({
        tweets: [
          makeTweet({
            id: "1",
            text: "vllm ships fp8",
            author: { id: "author-allowed", username: "someone" },
          }),
          makeTweet({
            id: "2",
            text: "agents!",
            author: { id: "author-excluded", username: "swyx" },
          }),
        ],
      }),
    });
    enrich.store.applyEnrichment({
      unit_id: "1:someone",
      tweet_ids: ["1"],
      labels: ["ai", "inference-performance"],
      free_labels: ["fp8"],
      concepts: [
        { name: "vLLM", aliases: ["vllm engine"] },
        { name: "FP8", aliases: [] },
      ],
      model: "m",
      taxonomy_version: 1,
      enriched_at: NOW.toISOString(),
    });
  }

  it("rejects unauthenticated enrichment reads", async () => {
    expect((await app.request("/api/labels")).status).toBe(401);
    expect((await app.request("/api/concepts")).status).toBe(401);
    expect((await app.request("/api/concepts/vllm")).status).toBe(401);
    expect((await app.request("/api/graph")).status).toBe(401);
  });

  it("filters /api/tweets by labels, free labels, concepts and unlabeled", async () => {
    await seedEnrichedTweets();
    const ids = async (query: string): Promise<string[]> => {
      const response = await app.request(`/api/tweets?${query}`, { headers });
      const page = (await response.json()) as { records: { tweet: { id: string } }[] };
      return page.records.map((record) => record.tweet.id).sort();
    };
    await expect(ids("labels=ai")).resolves.toEqual(["1"]);
    await expect(ids("labels=ai,agents&label_mode=all")).resolves.toEqual([]);
    await expect(ids("labels=ai,inference-performance&label_mode=all")).resolves.toEqual(["1"]);
    await expect(ids("free_label=fp8")).resolves.toEqual(["1"]);
    await expect(ids("concept=vllm")).resolves.toEqual(["1"]);
    await expect(ids("author_ids=author-allowed")).resolves.toEqual(["1"]);
    await expect(ids("unlabeled=true")).resolves.toEqual(["2"]);
    await expect(ids("labels=ai&q=vllm")).resolves.toEqual(["1"]);
  });

  it("serves whole enriched units to scoped machine credentials", async () => {
    await seedEnrichedTweets();
    const issued = await serviceAccounts.issue("osolmaz", "local-frontier", ["units:read"]);
    const authorization = { authorization: `Bearer ${issued.token}` };

    const response = await app.request("/api/units?labels=ai,local-models&label_mode=any", {
      headers: authorization,
    });
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      revision: string;
      units: { id: string; posts: { id: string }[]; preset_labels: string[] }[];
    };
    expect(page.units).toEqual([
      expect.objectContaining({ id: "1:someone", posts: [expect.objectContaining({ id: "1" })] }),
    ]);
    const excluded = await app.request("/api/units?author_ids=author-excluded", {
      headers: authorization,
    });
    await expect(excluded.json()).resolves.toMatchObject({ units: [] });
    const allowed = await app.request("/api/units?author_ids=author-allowed", {
      headers: authorization,
    });
    await expect(allowed.json()).resolves.toMatchObject({
      units: [expect.objectContaining({ id: "1:someone" })],
    });

    expect((await app.request("/api/concepts", { headers: authorization })).status).toBe(401);
    expect(
      (
        await app.request("/api/ingest", {
          method: "POST",
          headers: { ...authorization, "content-type": "application/json" },
          body: JSON.stringify({ tweets: [makeTweet()] }),
        })
      ).status,
    ).toBe(401);

    const stale = await app.request(`/api/graph?revision=${encodeURIComponent("old")}`, {
      headers: { cookie: sessionCookie("osolmaz") },
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ current_revision: page.revision });
  });

  it("serves taxonomy endpoints to taxonomy-scoped credentials", async () => {
    await seedEnrichedTweets();
    const issued = await serviceAccounts.issue("osolmaz", "taxonomy-reader", ["taxonomy:read"]);
    const headers = { authorization: `Bearer ${issued.token}` };
    const concepts = await app.request("/api/concepts?author_ids=author-allowed", { headers });
    expect(concepts.status).toBe(200);
    const body = (await concepts.json()) as { revision: string; concepts: { slug: string }[] };
    expect(body.concepts.map((concept) => concept.slug)).toEqual(["fp8", "vllm"]);
    const graph = await app.request(
      `/api/graph?author_ids=author-allowed&revision=${encodeURIComponent(body.revision)}`,
      { headers },
    );
    expect(graph.status).toBe(200);
    const excluded = await app.request("/api/concepts?author_ids=author-excluded", { headers });
    await expect(excluded.json()).resolves.toMatchObject({ concepts: [] });
    expect((await app.request("/api/units", { headers })).status).toBe(401);
  });

  it("serves the labels summary with counts, queue depth and coverage", async () => {
    await seedEnrichedTweets();
    const summary = (await (await app.request("/api/labels", { headers })).json()) as {
      taxonomy_version: number;
      labels: { name: string; count: number }[];
      free_labels: { name: string; count: number }[];
      queue: { queued: number; done: number };
      coverage: { units_total: number; units_enriched: number };
    };
    expect(summary.taxonomy_version).toBe(1);
    expect(summary.labels.find((label) => label.name === "ai")?.count).toBe(1);
    expect(summary.free_labels).toEqual([{ name: "fp8", count: 1 }]);
    expect(summary.queue).toMatchObject({ queued: 1, done: 1 });
    expect(summary.coverage).toEqual({ units_total: 2, units_enriched: 1 });
  });

  it("serves concepts, one concept with relations, and 404 for unknown slugs", async () => {
    await seedEnrichedTweets();
    const list = (await (await app.request("/api/concepts", { headers })).json()) as {
      concepts: { slug: string }[];
    };
    expect(list.concepts.map((concept) => concept.slug)).toEqual(["fp8", "vllm"]);

    const detail = (await (await app.request("/api/concepts/vllm", { headers })).json()) as Record<
      string,
      unknown
    >;
    expect(detail).toMatchObject({
      slug: "vllm",
      name: "vLLM",
      aliases: ["vllm engine"],
      unit_count: 1,
      tweet_count: 1,
      related: [{ slug: "fp8", name: "FP8", shared_units: 1 }],
    });
    expect((await app.request("/api/concepts/nope", { headers })).status).toBe(404);
  });

  it("serves a bounded concept graph with an optional label filter", async () => {
    await seedEnrichedTweets();
    const graph = (await (await app.request("/api/graph", { headers })).json()) as {
      nodes: { slug: string }[];
      links: { source: string; target: string; weight: number }[];
    };
    expect(graph.nodes.map((node) => node.slug).sort()).toEqual(["fp8", "vllm"]);
    expect(graph.links).toEqual([{ source: "fp8", target: "vllm", weight: 1 }]);

    const bounded = (await (await app.request("/api/graph?top=1", { headers })).json()) as {
      nodes: unknown[];
      links: unknown[];
    };
    expect(bounded.nodes).toHaveLength(1);
    expect(bounded.links).toHaveLength(0);

    const labeled = (await (await app.request("/api/graph?labels=agents", { headers })).json()) as {
      nodes: unknown[];
    };
    expect(labeled.nodes).toHaveLength(0);

    expect((await app.request("/api/graph?top=0", { headers })).status).toBe(400);
    expect((await app.request("/api/graph?top=5000", { headers })).status).toBe(400);
  });

  it("gates manual enrichment runs to pool tokens and admin sessions", async () => {
    const run = async (init: RequestInit = {}): Promise<Response> =>
      app.request("/api/enrich/run", { method: "POST", ...init });
    expect((await run()).status).toBe(401);
    expect((await run({ headers: { cookie: sessionCookie("alice") } })).status).toBe(403);

    const viaAdmin = await run({ headers: { cookie: sessionCookie("osolmaz") } });
    expect(viaAdmin.status).toBe(200);
    await expect(viaAdmin.json()).resolves.toEqual(EMPTY_RECEIPT);

    const viaToken = await run({ headers: { authorization: bearer("alice") } });
    expect(viaToken.status).toBe(200);
  });

  it("returns 500 with the error message when a manual run fails", async () => {
    const failingApp = createApp({
      config: testConfig,
      store,
      membership,
      serviceAccounts,
      unitStore,
      enrich: { ...enrich, run: () => Promise.reject(new Error("router down")) },
      now: () => NOW,
      ingest: () => Promise.resolve({ ok: true, added: 0, duplicates: 0, rejected: [] }),
    });
    const response = await failingApp.request("/api/enrich/run", {
      method: "POST",
      headers: { cookie: sessionCookie("osolmaz") },
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "router down" });
  });
});

describe("oauth + connect flow", () => {
  it("redirects /connect to login without a session", async () => {
    const response = await app.request("/connect");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/oauth/login?next=/connect");
  });

  it("login sets a state cookie and redirects to the HF authorize page", async () => {
    const response = await app.request("/oauth/login?next=/connect");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://huggingface.co");
    expect(location.pathname).toBe("/oauth/authorize");
    expect(response.headers.get("set-cookie")).toContain("xtap_pool_oauth=");
  });

  it("callback verifies state, enforces the allowlist and establishes a session", async () => {
    const oauthFetch: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/oauth/token"))
        return Promise.resolve(Response.json({ access_token: "t" }));
      return Promise.resolve(Response.json({ preferred_username: "osolmaz" }));
    };
    const oauthApp = createApp({
      config: testConfig,
      store,
      membership,
      serviceAccounts,
      unitStore,
      enrich,
      now: () => NOW,
      ingest: () => Promise.resolve({ ok: true, added: 0, duplicates: 0, rejected: [] }),
      oauthFetch,
    });

    const mismatch = await oauthApp.request("/oauth/callback?code=c&state=slate", {
      headers: { cookie: "xtap_pool_oauth=state-1|/connect" },
    });
    expect(mismatch.status).toBe(400);

    const missing = await oauthApp.request("/oauth/callback?code=c&state=s");
    expect(missing.status).toBe(400);

    const success = await oauthApp.request("/oauth/callback?code=c&state=state-1", {
      headers: { cookie: "xtap_pool_oauth=state-1|/connect" },
    });
    expect(success.status).toBe(302);
    expect(success.headers.get("location")).toBe("/connect");
    expect(success.headers.get("set-cookie")).toContain("xtap_pool_session=");
  });

  it("callback rejects users missing from the allowlist", async () => {
    const oauthFetch: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/oauth/token"))
        return Promise.resolve(Response.json({ access_token: "t" }));
      return Promise.resolve(Response.json({ preferred_username: "mallory" }));
    };
    const oauthApp = createApp({
      config: testConfig,
      store,
      membership,
      serviceAccounts,
      unitStore,
      enrich,
      now: () => NOW,
      ingest: () => Promise.resolve({ ok: true, added: 0, duplicates: 0, rejected: [] }),
      oauthFetch,
    });
    const response = await oauthApp.request("/oauth/callback?code=c&state=s1", {
      headers: { cookie: "xtap_pool_oauth=s1|/" },
    });
    expect(response.status).toBe(403);
  });

  it("callback accepts member organization users and mints usable pool tokens", async () => {
    await membership.addMemberOrg("osolmaz", {
      name: "huggingface",
      sub: "org-hf",
      display_name: "Hugging Face",
    });
    const oauthFetch: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/oauth/token"))
        return Promise.resolve(Response.json({ access_token: "t" }));
      return Promise.resolve(
        Response.json({
          preferred_username: "dana",
          orgs: [{ sub: "org-hf", preferred_username: "huggingface" }],
        }),
      );
    };
    const oauthApp = createApp({
      config: testConfig,
      store,
      membership,
      serviceAccounts,
      unitStore,
      enrich,
      now: () => NOW,
      ingest: (username, payload) =>
        new Mutex().run(() =>
          ingestBatch(
            { store, mirror: new DatasetMirror(hub, dir), now: () => NOW },
            username,
            payload,
          ),
        ),
      oauthFetch,
    });

    const success = await oauthApp.request("/oauth/callback?code=c&state=s1", {
      headers: { cookie: "xtap_pool_oauth=s1|/connect" },
    });
    expect(success.status).toBe(302);
    const cookie = sessionCookieFrom(success.headers.get("set-cookie"));
    expect(cookie).toContain("xtap_pool_session=");
    const connect = await oauthApp.request("/connect", { headers: { cookie } });
    const html = await connect.text();
    const match = /data-token="([^"]+)"/.exec(html);
    expect(match).not.toBeNull();

    const ingestResponse = await oauthApp.request("/api/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${match?.[1] ?? ""}`,
      },
      body: JSON.stringify({ tweets: [makeTweet()] }),
    });
    expect(ingestResponse.status).toBe(200);
  });

  it("does not carry org claims into explicit member tokens", async () => {
    await membership.addMemberOrg("osolmaz", {
      name: "huggingface",
      sub: "org-hf",
      display_name: "Hugging Face",
    });
    const oauthFetch: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/oauth/token"))
        return Promise.resolve(Response.json({ access_token: "t" }));
      return Promise.resolve(
        Response.json({
          preferred_username: "alice",
          orgs: [{ sub: "org-hf", preferred_username: "huggingface" }],
        }),
      );
    };
    const oauthApp = createApp({
      config: testConfig,
      store,
      membership,
      serviceAccounts,
      unitStore,
      enrich,
      now: () => NOW,
      ingest: () => Promise.resolve({ ok: true, added: 0, duplicates: 0, rejected: [] }),
      oauthFetch,
    });

    const success = await oauthApp.request("/oauth/callback?code=c&state=s1", {
      headers: { cookie: "xtap_pool_oauth=s1|/connect" },
    });
    const cookie = sessionCookieFrom(success.headers.get("set-cookie"));
    const connect = await oauthApp.request("/connect", { headers: { cookie } });
    const html = await connect.text();
    const match = /data-token="([^"]+)"/.exec(html);
    expect(match).not.toBeNull();

    await membership.removeMember("osolmaz", "alice");
    const ingestResponse = await oauthApp.request("/api/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${match?.[1] ?? ""}`,
      },
      body: JSON.stringify({ tweets: [makeTweet()] }),
    });
    expect(ingestResponse.status).toBe(401);
  });

  it("renders the connect page with a working pool token for a session", async () => {
    const response = await app.request("/connect", {
      headers: { cookie: sessionCookie("osolmaz") },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const match = /data-token="([^"]+)"/.exec(html);
    expect(match).not.toBeNull();
    const ingestResponse = await app.request("/api/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${match?.[1] ?? ""}`,
      },
      body: JSON.stringify({ tweets: [makeTweet()] }),
    });
    expect(ingestResponse.status).toBe(200);
  });
});

describe("admin pool management", () => {
  it("requires a signed-in admin", async () => {
    expect((await app.request("/api/admin/pool")).status).toBe(401);
    expect(
      (await app.request("/api/admin/pool", { headers: { cookie: sessionCookie("alice") } }))
        .status,
    ).toBe(403);
  });

  it("issues, rotates, and revokes service-account credentials", async () => {
    const adminHeaders = {
      cookie: sessionCookie("osolmaz"),
      "content-type": "application/json",
    };
    const issued = await app.request("/api/admin/service-accounts", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "local-frontier",
        scopes: ["units:read", "taxonomy:read"],
      }),
    });
    expect(issued.status).toBe(201);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const credential = (await issued.json()) as {
      token: string;
      account: { id: string; keys: { id: string }[] };
    };

    const listed = await app.request("/api/admin/service-accounts", {
      headers: { cookie: sessionCookie("osolmaz") },
    });
    expect(await listed.text()).not.toContain(credential.token);

    const rotated = await app.request(`/api/admin/service-accounts/${credential.account.id}/keys`, {
      method: "POST",
      headers: { cookie: sessionCookie("osolmaz") },
    });
    expect(rotated.status).toBe(201);
    const rotatedCredential = (await rotated.json()) as { token: string };
    expect(rotatedCredential.token).not.toBe(credential.token);

    const revoked = await app.request(`/api/admin/service-accounts/${credential.account.id}`, {
      method: "DELETE",
      headers: { cookie: sessionCookie("osolmaz") },
    });
    expect(revoked.status).toBe(200);
    expect(
      (
        await app.request("/api/units", {
          headers: { authorization: `Bearer ${rotatedCredential.token}` },
        })
      ).status,
    ).toBe(401);
  });

  it("adds and removes members without a Space restart", async () => {
    const adminHeaders = { cookie: sessionCookie("osolmaz") };
    const added = await app.request("/api/admin/members/mallory", {
      method: "PUT",
      headers: adminHeaders,
    });
    expect(added.status).toBe(200);
    expect(hub.files.get("config/pool.json")).toContain("mallory");
    expect(
      (
        await app.request("/api/ingest", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: bearer("mallory") },
          body: JSON.stringify({ tweets: [makeTweet()] }),
        })
      ).status,
    ).toBe(200);

    const removed = await app.request("/api/admin/members/mallory", {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(removed.status).toBe(200);
    expect(
      (
        await app.request("/api/ingest", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: bearer("mallory") },
          body: JSON.stringify({ tweets: [makeTweet({ id: "2" })] }),
        })
      ).status,
    ).toBe(401);
  });

  it("promotes and demotes admins with lockout protection", async () => {
    const adminHeaders = { cookie: sessionCookie("osolmaz") };
    const promoted = await app.request("/api/admin/admins/alice", {
      method: "PUT",
      headers: adminHeaders,
    });
    expect(promoted.status).toBe(200);
    await expect(promoted.json()).resolves.toMatchObject({
      pool: { admins: ["alice", "osolmaz"] },
    });

    const demoted = await app.request("/api/admin/admins/alice", {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(demoted.status).toBe(200);

    const bootstrapDemote = await app.request("/api/admin/admins/osolmaz", {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(bootstrapDemote.status).toBe(400);
  });

  it("sets and removes the member organization", async () => {
    const orgApp = createApp({
      config: testConfig,
      store,
      membership,
      serviceAccounts,
      unitStore,
      enrich,
      now: () => NOW,
      ingest: () => Promise.resolve({ ok: true, added: 0, duplicates: 0, rejected: [] }),
      resolveOrg: (orgName) =>
        Promise.resolve({
          name: orgName.toLowerCase(),
          sub: orgName.toLowerCase() === "dutifuldev" ? "org-dutiful" : "org-hf",
          display_name: orgName.toLowerCase() === "dutifuldev" ? "Dutiful" : "Hugging Face",
        }),
    });
    const adminHeaders = { cookie: sessionCookie("osolmaz") };
    const added = await orgApp.request("/api/admin/member-orgs/huggingface", {
      method: "PUT",
      headers: adminHeaders,
    });
    expect(added.status).toBe(200);
    await expect(added.json()).resolves.toMatchObject({
      pool: { member_orgs: [{ name: "huggingface", sub: "org-hf" }] },
    });
    expect(
      (
        await orgApp.request("/api/me", {
          headers: { authorization: bearer("dana", [{ sub: "org-hf", name: "huggingface" }]) },
        })
      ).status,
    ).toBe(200);

    const replaced = await orgApp.request("/api/admin/member-orgs/dutifuldev", {
      method: "PUT",
      headers: adminHeaders,
    });
    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toMatchObject({
      pool: { member_orgs: [{ name: "dutifuldev", sub: "org-dutiful" }] },
    });
    expect(
      (
        await orgApp.request("/api/me", {
          headers: { authorization: bearer("dana", [{ sub: "org-hf", name: "huggingface" }]) },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await orgApp.request("/api/me", {
          headers: { authorization: bearer("dana", [{ sub: "org-dutiful", name: "dutifuldev" }]) },
        })
      ).status,
    ).toBe(200);

    const removed = await orgApp.request("/api/admin/member-orgs/dutifuldev", {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(removed.status).toBe(200);
    expect(
      (
        await orgApp.request("/api/me", {
          headers: { authorization: bearer("dana", [{ sub: "org-hf", name: "huggingface" }]) },
        })
      ).status,
    ).toBe(401);
  });
});
