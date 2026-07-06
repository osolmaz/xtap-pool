import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { DatasetMirror } from "../src/dataset.js";
import { Mutex, ingestBatch } from "../src/ingest.js";
import { PoolMembership } from "../src/membership.js";
import { mintPoolToken } from "../src/pool-token.js";
import { TweetStore } from "../src/store.js";
import { FakeHub, makeTweet, testConfig } from "./helpers.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");

let dir: string;
let hub: FakeHub;
let store: TweetStore;
let app: Hono;
let membership: PoolMembership;

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
  const mutex = new Mutex();
  app = createApp({
    config: testConfig,
    store,
    membership,
    now: () => NOW,
    ingest: (username, payload) =>
      mutex.run(() => ingestBatch({ store, mirror, now: () => NOW }, username, payload)),
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

  it("adds and removes member organizations", async () => {
    const orgApp = createApp({
      config: testConfig,
      store,
      membership,
      now: () => NOW,
      ingest: () => Promise.resolve({ ok: true, added: 0, duplicates: 0, rejected: [] }),
      resolveOrg: (orgName) =>
        Promise.resolve({
          name: orgName.toLowerCase(),
          sub: "org-hf",
          display_name: "Hugging Face",
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

    const removed = await orgApp.request("/api/admin/member-orgs/huggingface", {
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
