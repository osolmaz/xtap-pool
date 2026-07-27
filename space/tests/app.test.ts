import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeContractHash, PROCESSOR_VERSION } from "@xtap-pool/shared";
import type { EnrichReceipt } from "@xtap-pool/shared";

import { createApp } from "../src/app.js";
import type { EnrichDeps } from "../src/app.js";
import { DatasetMirror } from "../src/dataset.js";
import { DEFAULT_TAXONOMY } from "../src/enrich-config.js";
import { EnrichStore } from "../src/enrich-store.js";
import {
  contractHashFor,
  NORMALIZATION_ID,
  OUTPUT_SCHEMA_ID,
  PROMPT_TEMPLATE_ID,
} from "../src/enrich-worker.js";
import { Mutex, ingestBatch } from "../src/ingest.js";
import { PoolMembership } from "../src/membership.js";
import { mintPoolToken } from "../src/pool-token.js";
import { ServiceAccountRegistry } from "../src/service-accounts.js";
import { TweetStore } from "../src/store.js";
import { UnitStore } from "../src/unit-store.js";
import { FakeHub, makeTweet, testConfig } from "./helpers.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const CONTRACT_HASH = contractHashFor({
  taxonomy: { labels: DEFAULT_TAXONOMY, version: 1, source: "default" },
  model: "m",
});

const EMPTY_RECEIPT: EnrichReceipt = {
  started_at: NOW.toISOString(),
  finished_at: NOW.toISOString(),
  units: 0,
  calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  failures: 0,
  retries: 0,
  blocked: 0,
  contract_hash: CONTRACT_HASH,
  worker_id: "test-worker",
  discarded_assignments: 0,
  new_candidates: 0,
  new_approvals: 0,
  new_rejections: 0,
};

// Verifies PROCESSOR_VERSION participates: contract hash changes when the
// processor version changes, even if all other inputs are identical.
void computeContractHash({
  taxonomy_version: 1,
  labels: [],
  model: "x",
  processor_version: PROCESSOR_VERSION,
  prompt_template_id: PROMPT_TEMPLATE_ID,
  output_schema_id: OUTPUT_SCHEMA_ID,
  normalization_id: NORMALIZATION_ID,
});

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
    store: new EnrichStore(store.database, 1, () => NOW, CONTRACT_HASH),
    taxonomy: { labels: DEFAULT_TAXONOMY, version: 1, source: "default" },
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
    const semantic = enrich.store.unitSemanticMembers("1:someone");
    const { computeInputHash } = await import("@xtap-pool/shared");
    enrich.store.applyEnrichment({
      unit_id: "1:someone",
      tweet_ids: ["1"],
      input_hash: computeInputHash("1:someone", semantic),
      contract_hash: CONTRACT_HASH,
      preset_labels: [
        { name: "ai", evidence: [{ tweet_id: "1", quote: "vllm ships fp8" }] },
        { name: "inference-performance", evidence: [{ tweet_id: "1", quote: "fp8" }] },
      ],
      free_labels: [{ name: "fp8", evidence: [{ tweet_id: "1", quote: "fp8" }] }],
      model: "m",
      taxonomy_version: 1,
      enriched_at: NOW.toISOString(),
    });
    // Approve the seeded free label so consumer reads surface it.
    const candidate = enrich.store.candidateEventIfNew("fp8").event;
    if (candidate === undefined) throw new Error("expected fp8 candidate");
    enrich.store.applyRegistryEvent(candidate);
    enrich.store.promoteName("fp8", "test-approved");
  }

  it("rejects unauthenticated enrichment reads", async () => {
    expect((await app.request("/api/labels")).status).toBe(401);
    expect((await app.request("/api/free-labels")).status).toBe(401);
    expect((await app.request("/api/free-labels/fp8")).status).toBe(401);
    expect((await app.request("/api/graph")).status).toBe(401);
  });

  it("filters /api/tweets by labels, free labels, and unlabeled", async () => {
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

    expect((await app.request("/api/free-labels", { headers: authorization })).status).toBe(401);
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

  it("serves free-label endpoints to taxonomy-scoped credentials", async () => {
    await seedEnrichedTweets();
    const issued = await serviceAccounts.issue("osolmaz", "taxonomy-reader", ["taxonomy:read"]);
    const headers = { authorization: `Bearer ${issued.token}` };
    const freeLabels = await app.request("/api/free-labels?author_ids=author-allowed", { headers });
    expect(freeLabels.status).toBe(200);
    const body = (await freeLabels.json()) as {
      revision: string;
      contract_hash: string;
      free_label_registry_revision: number;
      free_labels: { name: string; count: number }[];
    };
    expect(body.contract_hash.length).toBeGreaterThan(10);
    expect(body.free_label_registry_revision).toBeGreaterThan(1);
    expect(body.free_labels.map((entry) => entry.name)).toEqual(["fp8"]);
    const graph = await app.request(
      `/api/graph?author_ids=author-allowed&revision=${encodeURIComponent(body.revision)}`,
      { headers },
    );
    expect(graph.status).toBe(200);
    const excluded = await app.request("/api/free-labels?author_ids=author-excluded", { headers });
    await expect(excluded.json()).resolves.toMatchObject({ free_labels: [] });
    expect((await app.request("/api/units", { headers })).status).toBe(401);
  });

  it("serves the labels summary with counts, queue depth and coverage", async () => {
    await seedEnrichedTweets();
    const summary = (await (await app.request("/api/labels", { headers })).json()) as {
      contract_hash: string;
      free_label_registry_revision: number;
      taxonomy_version: number;
      labels: { name: string; count: number }[];
      free_labels: { name: string; count: number }[];
      queue: { pending: number; running: number; retrying: number; blocked: number; done: number };
      coverage: { units_total: number; units_enriched: number };
    };
    expect(summary.contract_hash.length).toBeGreaterThan(10);
    expect(summary.free_label_registry_revision).toBeGreaterThan(1);
    expect(summary.taxonomy_version).toBe(1);
    expect(summary.labels.find((label) => label.name === "ai")?.count).toBe(1);
    expect(summary.free_labels).toEqual([{ name: "fp8", count: 1 }]);
    expect(summary.queue).toMatchObject({ pending: 1, done: 1 });
    expect(summary.coverage).toEqual({ units_total: 2, units_enriched: 1 });
  });

  it("serves approved free-labels, one detail, and 404 for unknown names", async () => {
    await seedEnrichedTweets();
    const list = (await (await app.request("/api/free-labels", { headers })).json()) as {
      free_labels: { name: string }[];
    };
    expect(list.free_labels.map((entry) => entry.name)).toEqual(["fp8"]);

    const detail = (await (
      await app.request("/api/free-labels/fp8", { headers })
    ).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({ name: "fp8", unit_count: 1, tweet_count: 1 });
    expect((await app.request("/api/free-labels/nope", { headers })).status).toBe(404);
  });

  it("serves a bounded free-label graph with an optional label filter", async () => {
    await seedEnrichedTweets();
    const graph = (await (await app.request("/api/graph", { headers })).json()) as {
      nodes: { name: string }[];
      links: { source: string; target: string; weight: number }[];
    };
    expect(graph.nodes.map((node) => node.name).sort()).toEqual(["fp8"]);
    expect(graph.links).toEqual([]);

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

  it("does not expose an in-process enrichment writer", async () => {
    expect((await app.request("/api/enrich/run", { method: "POST" })).status).toBe(404);
  });

  it("serves /api/enrichment/status with author-filtered counts", async () => {
    await seedEnrichedTweets();
    const issued = await serviceAccounts.issue("osolmaz", "taxonomy-reader", ["taxonomy:read"]);
    const headers = { authorization: `Bearer ${issued.token}` };
    const response = await app.request("/api/enrichment/status?author_ids=author-allowed", {
      headers,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      revision: string;
      author_ids: string[];
      contract_hash: string;
      free_label_registry_revision: number;
      taxonomy_version: number;
      complete_through?: string;
      totals: {
        total: number;
        pending: number;
        blocked: number;
        completed: number;
        retrying: number;
        running: number;
      };
      worker_recently_completed: boolean;
      recent_errors: unknown[];
    };
    expect(body.author_ids).toEqual(["author-allowed"]);
    expect(body.taxonomy_version).toBe(1);
    expect(body.contract_hash.length).toBeGreaterThan(10);
    expect(body.free_label_registry_revision).toBeGreaterThan(1);
    expect(body.complete_through).toBeDefined();
    expect(body.totals.total).toBe(1);
    expect(body.totals.completed).toBe(1);
    expect(body.worker_recently_completed).toBe(false);
    expect(Array.isArray(body.recent_errors)).toBe(true);
    // No selection filter given → the endpoint sees the whole pool
    const wide = await app.request("/api/enrichment/status", { headers });
    const wideBody = (await wide.json()) as { totals: { total: number } };
    expect(wideBody.totals.total).toBe(2);
    // 409 on stale revision
    const stale = await app.request(
      `/api/enrichment/status?revision=${encodeURIComponent("old")}`,
      { headers },
    );
    expect(stale.status).toBe(409);
  });

  it("uses the newest durable receipt for the recent-completion signal", async () => {
    enrich.lastReceipt = () => EMPTY_RECEIPT;
    const issued = await serviceAccounts.issue("osolmaz", "taxonomy-reader", ["taxonomy:read"]);
    const response = await app.request("/api/enrichment/status", {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ worker_recently_completed: true });
  });

  it("applies a cutoff to /api/free-labels", async () => {
    await seedEnrichedTweets();
    // The seeded unit's tweet was captured at 2026-05-21; a cutoff before
    // that produces no free labels.
    const before = await app.request("/api/free-labels?cutoff=2020-01-01T00:00:00.000Z", {
      headers,
    });
    const beforeBody = (await before.json()) as { free_labels: unknown[] };
    expect(beforeBody.free_labels).toEqual([]);
    const after = await app.request("/api/free-labels?cutoff=2030-01-01T00:00:00.000Z", {
      headers,
    });
    const afterBody = (await after.json()) as { free_labels: { name: string }[] };
    expect(afterBody.free_labels.map((entry) => entry.name)).toEqual(["fp8"]);
  });

  it("serves the admin enrichment surface with counts and contract hash", async () => {
    await seedEnrichedTweets();
    const response = await app.request("/api/admin/enrichment", { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      viewer: { username: string };
      contract_hash: string;
      totals: { total: number };
      worker_recently_completed: boolean;
    };
    expect(body.viewer.username).toBe("osolmaz");
    expect(body.contract_hash.length).toBeGreaterThan(10);
    expect(body.totals.total).toBeGreaterThan(0);
    expect(body.worker_recently_completed).toBe(false);
    // Non-admins are rejected
    const nonAdmin = await app.request("/api/admin/enrichment", {
      headers: { cookie: sessionCookie("alice") },
    });
    expect(nonAdmin.status).toBe(403);
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
