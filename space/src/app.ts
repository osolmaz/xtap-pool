import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { z } from "zod";

import { serviceAccountScopeSchema } from "@xtap-pool/shared";
import type { EnrichReceipt, ServiceAccountScope } from "@xtap-pool/shared";

import { renderConnectPage } from "./connect-page.js";
import type { SpaceConfig } from "./config.js";
import type { EnrichTaxonomy } from "./enrich-config.js";
import type { EnrichStore } from "./enrich-store.js";
import { createHuggingFaceOrgResolver } from "./hf-orgs.js";
import type { OrgResolver } from "./hf-orgs.js";
import type { IngestOutcome } from "./ingest.js";
import type { PoolAccessGrant, PoolIdentity, PoolMembership, PoolSnapshot } from "./membership.js";
import { authorizeUrl, exchangeCodeForIdentity } from "./oauth.js";
import { mintPoolToken, verifyPoolToken } from "./pool-token.js";
import type { ServiceAccountRegistry } from "./service-accounts.js";
import type { TweetStore, TweetQuery } from "./store.js";
import {
  InvalidUnitCursorError,
  StaleUnitRevisionError,
  type UnitQuery,
  type UnitStore,
} from "./unit-store.js";

const SESSION_COOKIE = "xtap_pool_session";
const OAUTH_STATE_COOKIE = "xtap_pool_oauth";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POOL_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const ORG_GRANT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type EnrichDeps = {
  store: EnrichStore;
  taxonomy: EnrichTaxonomy;
  /** Drain one enrichment tick synchronously (manual runs). */
  run: () => Promise<EnrichReceipt>;
  /** Most recent worker receipt, when known. Backs the admin worker signal. */
  lastReceipt?: () => EnrichReceipt | undefined;
};

export type AppReadiness = {
  ok: boolean;
  dataset: {
    indexed_files: number;
    indexed_tweets: number;
    enrichment_rows: number;
    credential: "ok" | "invalid" | "unknown";
    credential_error?: string;
    state: "ready" | "invalid" | "unknown";
    error?: string;
  };
  enrichment: {
    enabled: boolean;
    model: string;
    credential: "ok" | "not_required" | "missing" | "invalid" | "unknown";
    credential_error?: string;
    state: "ready" | "disabled" | "invalid" | "unknown";
    error?: string;
  };
  service_accounts?: {
    state: "ready" | "invalid" | "unknown";
    accounts: number;
    error?: string;
  };
};

export type AppDeps = {
  config: SpaceConfig;
  store: TweetStore;
  membership: PoolMembership;
  serviceAccounts: ServiceAccountRegistry;
  unitStore: UnitStore;
  enrich: EnrichDeps;
  ingest: (username: string, payload: unknown) => Promise<IngestOutcome>;
  repairMembership?: (actor: string) => Promise<PoolSnapshot>;
  mutateServiceAccounts?: <T>(operation: () => Promise<T>) => Promise<T>;
  readiness?: () => AppReadiness;
  now?: () => Date;
  oauthFetch?: typeof fetch;
  resolveOrg?: OrgResolver;
};

type AuthorizedIdentity = PoolIdentity & {
  grant: PoolAccessGrant;
};

const tweetsQuerySchema = z.object({
  contributors: z.string().optional(),
  author: z.string().optional(),
  author_ids: z.string().optional(),
  q: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  has_media: z.enum(["true", "false"]).optional(),
  is_article: z.enum(["true", "false"]).optional(),
  labels: z.string().optional(),
  label_mode: z.enum(["any", "all"]).default("any"),
  free_label: z.string().optional(),
  unlabeled: z.enum(["true", "false"]).optional(),
  publication: z.enum(["public-original"]).optional(),
  cutoff: z.string().min(1).optional(),
  dedup: z.enum(["true", "false"]).default("true"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

const taxonomyQuerySchema = z.object({
  author_ids: z.string().optional(),
  labels: z.string().optional(),
  label_mode: z.enum(["any", "all"]).default("any"),
  publication: z.enum(["public-original"]).optional(),
  revision: z.string().min(1).optional(),
  cutoff: z.string().min(1).optional(),
});

const graphQuerySchema = taxonomyQuerySchema.extend({
  top: z.coerce.number().int().min(1).max(1000).default(300),
});

const statusQuerySchema = z.object({
  author_ids: z.string().optional(),
  publication: z.enum(["public-original"]).optional(),
  revision: z.string().min(1).optional(),
});

const serviceAccountCreateSchema = z.object({
  name: z.string().min(1),
  scopes: z.array(serviceAccountScopeSchema).min(1),
});

function parseFlag(value: "true" | "false" | undefined): boolean | undefined {
  return value === undefined ? undefined : value === "true";
}

function parseCsv(value: string | undefined): string[] | undefined {
  const parts = value
    ?.split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts === undefined || parts.length === 0 ? undefined : parts;
}

function taxonomySelection(raw: z.infer<typeof taxonomyQuerySchema>): {
  authorIds: string[] | undefined;
  labels: string[] | undefined;
  labelMode: "any" | "all";
  publication: "public-original" | undefined;
  cutoff: string | undefined;
} {
  return {
    authorIds: parseCsv(raw.author_ids),
    labels: parseCsv(raw.labels),
    labelMode: raw.label_mode,
    publication: raw.publication,
    cutoff: raw.cutoff,
  };
}

function toTweetQuery(raw: z.infer<typeof tweetsQuerySchema>): TweetQuery {
  return toFilteredQuery(raw);
}

function toUnitQuery(raw: z.infer<typeof tweetsQuerySchema>): UnitQuery {
  return toFilteredQuery(raw);
}

function toFilteredQuery(raw: z.infer<typeof tweetsQuerySchema>): TweetQuery {
  const labels = parseCsv(raw.labels);
  const candidate = {
    dedup: raw.dedup === "true",
    limit: raw.limit,
    contributors: parseCsv(raw.contributors),
    author: raw.author,
    authorIds: parseCsv(raw.author_ids),
    q: raw.q,
    since: raw.since,
    until: raw.until,
    hasMedia: parseFlag(raw.has_media),
    isArticle: parseFlag(raw.is_article),
    labels,
    labelMode: labels === undefined ? undefined : raw.label_mode,
    freeLabel: raw.free_label,
    unlabeled: raw.unlabeled === "true" ? true : undefined,
    publication: raw.publication,
    cutoff: raw.cutoff,
    cursor: raw.cursor,
  };
  return Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined));
}

export function createApp(deps: AppDeps): Hono {
  const { config, store, membership, serviceAccounts, unitStore } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const resolveOrg =
    deps.resolveOrg ?? createHuggingFaceOrgResolver(config.openidProviderUrl, deps.oauthFetch);
  const mutateServiceAccounts =
    deps.mutateServiceAccounts ??
    (async <T>(operation: () => Promise<T>): Promise<T> => operation());

  const authorizeIdentity = (identity: PoolIdentity): AuthorizedIdentity | undefined => {
    const grant = membership.accessFor(identity);
    if (grant === undefined) return undefined;
    return {
      username: identity.username,
      grant,
      ...(grant.type === "member_org" && identity.orgs !== undefined
        ? { orgs: identity.orgs }
        : {}),
    };
  };

  const sessionIdentity = (c: Context): AuthorizedIdentity | undefined => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie === undefined) return undefined;
    const verified = verifyPoolToken(config.sessionSecret, cookie, now());
    return verified.ok ? authorizeIdentity(verified) : undefined;
  };

  const bearerIdentity = (c: Context): AuthorizedIdentity | undefined => {
    const header = c.req.header("authorization");
    if (header?.toLowerCase().startsWith("bearer ") !== true) return undefined;
    const verified = verifyPoolToken(config.poolSigningSecret, header.slice(7).trim(), now());
    return verified.ok ? authorizeIdentity(verified) : undefined;
  };

  const serviceIdentity = (
    c: Context,
    scope: ServiceAccountScope,
  ): ReturnType<ServiceAccountRegistry["authorize"]> => {
    const header = c.req.header("authorization");
    if (header?.toLowerCase().startsWith("bearer ") !== true) return undefined;
    const identity = serviceAccounts.authorize(header.slice(7).trim(), scope);
    if (identity !== undefined) {
      console.info(
        `[xtap-pool] service account ${identity.name} (${identity.id}/${identity.keyId}) ` +
          `${c.req.method} ${c.req.path}`,
      );
    }
    return identity;
  };

  const readAuthorized = (c: Context, scope: ServiceAccountScope): boolean =>
    sessionIdentity(c) !== undefined || serviceIdentity(c, scope) !== undefined;

  const adminUser = (c: Context): string | Response => {
    const identity = sessionIdentity(c);
    if (identity === undefined) return c.json({ error: "unauthenticated" }, 401);
    if (!membership.isAdmin(identity.username))
      return c.json({ error: "admin access required" }, 403);
    return identity.username;
  };

  const app = new Hono();

  const taxonomyRequest = (
    c: Context,
  ): { revision: string; query: z.infer<typeof taxonomyQuerySchema> } | Response => {
    if (!readAuthorized(c, "taxonomy:read")) return c.json({ error: "unauthenticated" }, 401);
    const parsed = taxonomyQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query parameters" }, 400);
    const revision = checkedRevision(parsed.data.revision, unitStore);
    return revision instanceof Response ? revision : { revision, query: parsed.data };
  };

  const requireReady = async (c: Context, next: Next) => {
    const readiness = deps.readiness?.();
    const configRecovery =
      (membership.hasPermanentConfigError() || serviceAccounts.hasPermanentConfigError()) &&
      isConfigurationRecoveryRequest(c);
    if (readiness !== undefined && !readiness.ok && !configRecovery) {
      return c.json({ error: "pool is not ready", readiness }, 503);
    }
    await next();
  };
  app.use("/api/*", requireReady);
  app.use("/oauth/*", requireReady);
  app.use("/connect", requireReady);

  const health = (): { ok: true; tweets: number; readiness?: AppReadiness } => {
    const readiness = deps.readiness?.();
    return {
      ok: true,
      tweets: store.count(),
      ...(readiness === undefined ? {} : { readiness }),
    };
  };

  app.get("/healthz", (c) => c.json(health()));

  app.get("/readyz", (c) => {
    const readiness = deps.readiness?.();
    const body = {
      ok: readiness?.ok ?? true,
      tweets: store.count(),
      ...(readiness === undefined ? {} : { readiness }),
    };
    return c.json(body, body.ok ? 200 : 503);
  });

  app.get("/oauth/login", (c) => {
    const next = c.req.query("next") ?? "/";
    const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
    const state = randomUUID();
    setCookie(c, OAUTH_STATE_COOKIE, `${state}|${safeNext}`, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
    const orgId = membership.memberOrgId();
    return c.redirect(
      authorizeUrl(
        {
          clientId: config.oauthClientId,
          clientSecret: config.oauthClientSecret,
          providerUrl: config.openidProviderUrl,
          redirectUri: `${config.publicUrl}/oauth/callback`,
        },
        state,
        orgId === undefined ? {} : { orgId },
      ),
    );
  });

  app.get("/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const stateCookie = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
    if (code === undefined || state === undefined || stateCookie === undefined) {
      return c.text("missing oauth state", 400);
    }
    const [expectedState, next] = splitStateCookie(stateCookie);
    if (state !== expectedState) return c.text("oauth state mismatch", 400);

    const settings = {
      clientId: config.oauthClientId,
      clientSecret: config.oauthClientSecret,
      providerUrl: config.openidProviderUrl,
      redirectUri: `${config.publicUrl}/oauth/callback`,
      ...(deps.oauthFetch === undefined ? {} : { fetchFn: deps.oauthFetch }),
    };
    const identity = await exchangeCodeForIdentity(settings, code);
    if (identity === undefined) return c.text("oauth exchange failed", 401);
    const authorized = authorizeIdentity(identity);
    if (authorized === undefined) {
      return c.text(`@${identity.username} is not on this pool's allowlist`, 403);
    }
    const sessionTtl = tokenTtlForGrant(authorized.grant, SESSION_TTL_MS);
    const session = mintPoolToken(
      config.sessionSecret,
      authorized,
      new Date(now().getTime() + sessionTtl),
    );
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: sessionTtl / 1000,
    });
    return c.redirect(next);
  });

  app.get("/connect", (c) => {
    const identity = sessionIdentity(c);
    if (identity === undefined) return c.redirect("/oauth/login?next=/connect");
    const poolTokenTtl = tokenTtlForGrant(identity.grant, POOL_TOKEN_TTL_MS);
    const token = mintPoolToken(
      config.poolSigningSecret,
      identity,
      new Date(now().getTime() + poolTokenTtl),
    );
    return c.html(renderConnectPage(identity.username, token));
  });

  app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type"] }));

  app.post("/api/ingest", async (c) => {
    const identity = bearerIdentity(c);
    if (identity === undefined) return c.json({ error: "invalid or missing pool token" }, 401);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const outcome = await deps.ingest(identity.username, payload);
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    return c.json({
      added: outcome.added,
      duplicates: outcome.duplicates,
      rejected: outcome.rejected,
    });
  });

  app.get("/api/me", (c) => {
    const identity = bearerIdentity(c) ?? sessionIdentity(c);
    if (identity === undefined) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ username: identity.username, isAdmin: membership.isAdmin(identity.username) });
  });

  app.get("/api/tweets", (c) => {
    const identity = sessionIdentity(c);
    if (identity === undefined) return c.json({ error: "unauthenticated" }, 401);
    const parsed = tweetsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query parameters" }, 400);
    const page = store.query(toTweetQuery(parsed.data));
    return c.json(page);
  });

  app.get("/api/units", (c) => {
    if (!readAuthorized(c, "units:read")) return c.json({ error: "unauthenticated" }, 401);
    const parsed = tweetsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query parameters" }, 400);
    try {
      return c.json(unitStore.query(toUnitQuery(parsed.data)));
    } catch (error) {
      if (error instanceof InvalidUnitCursorError) return c.json({ error: error.message }, 400);
      if (error instanceof StaleUnitRevisionError) {
        return c.json({ error: error.message, current_revision: error.current }, 409);
      }
      throw error;
    }
  });

  app.get("/api/contributors", (c) => {
    const identity = sessionIdentity(c);
    if (identity === undefined) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ contributors: store.contributors() });
  });

  app.get("/api/labels", (c) => {
    const request = taxonomyRequest(c);
    if (request instanceof Response) return request;
    return c.json({
      revision: request.revision,
      ...taxonomyMetadata(deps),
      ...(request.query.cutoff === undefined ? {} : { cutoff: request.query.cutoff }),
      ...deps.enrich.store.labelsSummary(
        deps.enrich.taxonomy.labels,
        taxonomySelection(request.query),
      ),
    });
  });

  app.get("/api/free-labels", (c) => {
    const request = taxonomyRequest(c);
    if (request instanceof Response) return request;
    return c.json({
      revision: request.revision,
      ...taxonomyMetadata(deps),
      ...(request.query.cutoff === undefined ? {} : { cutoff: request.query.cutoff }),
      free_labels: deps.enrich.store.approvedFreeLabels(taxonomySelection(request.query)),
    });
  });

  app.get("/api/free-labels/:name", (c) => {
    if (!readAuthorized(c, "taxonomy:read")) return c.json({ error: "unauthenticated" }, 401);
    const parsed = taxonomyQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query parameters" }, 400);
    const revision = checkedRevision(parsed.data.revision, unitStore);
    if (revision instanceof Response) return revision;
    const detail = deps.enrich.store.freeLabelDetail(c.req.param("name"), {
      authorIds: parseCsv(parsed.data.author_ids),
      labels: parseCsv(parsed.data.labels),
      labelMode: parsed.data.label_mode,
      publication: parsed.data.publication,
      cutoff: parsed.data.cutoff,
    });
    if (detail === undefined) return c.json({ error: "unknown free label" }, 404);
    return c.json({
      revision,
      ...taxonomyMetadata(deps),
      ...(parsed.data.cutoff === undefined ? {} : { cutoff: parsed.data.cutoff }),
      ...detail,
    });
  });

  app.get("/api/graph", (c) => {
    if (!readAuthorized(c, "taxonomy:read")) return c.json({ error: "unauthenticated" }, 401);
    const parsed = graphQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query parameters" }, 400);
    const revision = checkedRevision(parsed.data.revision, unitStore);
    if (revision instanceof Response) return revision;
    return c.json({
      revision,
      ...taxonomyMetadata(deps),
      ...(parsed.data.cutoff === undefined ? {} : { cutoff: parsed.data.cutoff }),
      ...deps.enrich.store.graph({
        authorIds: parseCsv(parsed.data.author_ids),
        labels: parseCsv(parsed.data.labels),
        labelMode: parsed.data.label_mode,
        publication: parsed.data.publication,
        cutoff: parsed.data.cutoff,
        top: parsed.data.top,
      }),
    });
  });

  app.get("/api/enrichment/status", (c) => {
    if (!readAuthorized(c, "taxonomy:read")) return c.json({ error: "unauthenticated" }, 401);
    const parsed = statusQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query parameters" }, 400);
    const revision = checkedRevision(parsed.data.revision, unitStore);
    if (revision instanceof Response) return revision;
    const authorIds = parseCsv(parsed.data.author_ids);
    return c.json({
      revision,
      author_ids: [...new Set(authorIds ?? [])].sort(),
      free_label_registry_revision: deps.enrich.store.registryRevision(),
      ...buildEnrichmentSurface(deps, now, {
        authorIds,
        publication: parsed.data.publication,
      }),
    });
  });

  app.post("/api/enrich/run", async (c) => {
    // Manual drains: any valid pool token, or an admin session.
    if (bearerIdentity(c) === undefined) {
      const admin = adminUser(c);
      if (admin instanceof Response) return admin;
    }
    try {
      return c.json(await deps.enrich.run());
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.get("/api/admin/pool", (c) => {
    const username = adminUser(c);
    if (username instanceof Response) return username;
    return c.json({ pool: membership.snapshot(), viewer: { username } });
  });

  app.get("/api/admin/enrichment", (c) => {
    const username = adminUser(c);
    if (username instanceof Response) return username;
    return c.json({
      viewer: { username },
      ...buildEnrichmentSurface(deps, now, {}, true),
    });
  });

  app.get("/api/admin/free-labels", (c) => {
    const username = adminUser(c);
    if (username instanceof Response) return username;
    const labels = deps.enrich.store.registrySnapshot();
    return c.json({
      viewer: { username },
      registry_revision: deps.enrich.store.registryRevision(),
      labels,
      candidates: labels.flatMap((label) => {
        if (label.status !== "candidate") return [];
        const detail = deps.enrich.store.candidateDetail(label.name);
        return detail === undefined ? [] : [detail];
      }),
    });
  });

  app.get("/api/admin/free-labels/:name", (c) => {
    const username = adminUser(c);
    if (username instanceof Response) return username;
    const detail = deps.enrich.store.candidateDetail(c.req.param("name"));
    if (detail === undefined) return c.json({ error: "unknown free label" }, 404);
    return c.json({ viewer: { username }, label: detail });
  });

  app.post("/api/admin/pool/repair", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      const repair =
        deps.repairMembership ?? ((username: string) => membership.repairConfig(username));
      return c.json({ pool: await repair(actor) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/admin/service-accounts", (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    return c.json({ service_accounts: serviceAccounts.snapshot(), viewer: { username: actor } });
  });

  app.post("/api/admin/service-accounts", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    const body = await jsonBody(c);
    if (!body.ok) return body.response;
    const parsed = serviceAccountCreateSchema.safeParse(body.value);
    if (!parsed.success) return c.json({ error: "invalid service account" }, 400);
    try {
      const credential = await mutateServiceAccounts(() =>
        serviceAccounts.issue(actor, parsed.data.name, parsed.data.scopes),
      );
      c.header("cache-control", "no-store");
      return c.json(credential, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/admin/service-accounts/:id/keys", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      const credential = await mutateServiceAccounts(() =>
        serviceAccounts.rotate(actor, c.req.param("id")),
      );
      c.header("cache-control", "no-store");
      return c.json(credential, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/admin/service-accounts/:id/keys/:keyId", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      const account = await mutateServiceAccounts(() =>
        serviceAccounts.revokeKey(actor, c.req.param("id"), c.req.param("keyId")),
      );
      return c.json({ account });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/admin/service-accounts/:id", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      const account = await mutateServiceAccounts(() =>
        serviceAccounts.revoke(actor, c.req.param("id")),
      );
      return c.json({ account });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/admin/service-accounts/repair", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      const snapshot = await mutateServiceAccounts(() => serviceAccounts.repair(actor));
      return c.json({ service_accounts: snapshot });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.put("/api/admin/members/:username", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json({ pool: await membership.addMember(actor, c.req.param("username")) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/admin/members/:username", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json({ pool: await membership.removeMember(actor, c.req.param("username")) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.put("/api/admin/admins/:username", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json({ pool: await membership.addAdmin(actor, c.req.param("username")) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/admin/admins/:username", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json({ pool: await membership.removeAdmin(actor, c.req.param("username")) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.put("/api/admin/member-orgs/:org", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json({
        pool: await membership.addMemberOrg(actor, await resolveOrg(c.req.param("org"))),
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/admin/member-orgs/:org", async (c) => {
    const actor = adminUser(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json({ pool: await membership.removeMemberOrg(actor, c.req.param("org")) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  return app;
}

function isConfigurationRecoveryRequest(c: Context): boolean {
  const path = c.req.path;
  if (path.startsWith("/oauth/")) return true;
  if (
    c.req.method === "GET" &&
    (path === "/api/me" || path === "/api/admin/pool" || path === "/api/admin/service-accounts")
  ) {
    return true;
  }
  return (
    c.req.method === "POST" &&
    (path === "/api/admin/pool/repair" || path === "/api/admin/service-accounts/repair")
  );
}

type EnrichmentSurfaceOptions = {
  authorIds?: readonly string[] | undefined;
  publication?: "public-original" | undefined;
};

/**
 * Shared body for /api/enrichment/status and /api/admin/enrichment: pulls
 * counts, freshness lag, contract hash and recent errors from the enrichment
 * store, optionally including the last worker receipt.
 */
function buildEnrichmentSurface(
  deps: AppDeps,
  now: () => Date,
  selection: EnrichmentSurfaceOptions,
  includeReceipt = false,
): Record<string, unknown> {
  const counts = deps.enrich.store.statusCounts(selection);
  const recent = deps.enrich.store.recentErrorClasses();
  const workerReceipt = deps.enrich.lastReceipt?.();
  const workerActive =
    workerReceipt !== undefined && Date.now() - Date.parse(workerReceipt.finished_at) < 15 * 60_000;
  const freshnessLagSeconds = freshnessLag(now(), counts.newestCompletedAt);
  return {
    contract_hash: deps.enrich.store.currentContractHash(),
    taxonomy_version: deps.enrich.taxonomy.version,
    totals: counts.totals,
    ...maybe("oldest_pending_at", counts.oldestPendingAt),
    ...maybe("newest_completed_at", counts.newestCompletedAt),
    ...maybe("complete_through", counts.completeThrough),
    worker_active: workerActive,
    ...(includeReceipt && workerReceipt !== undefined ? { last_receipt: workerReceipt } : {}),
    ...maybe("freshness_lag_seconds", freshnessLagSeconds),
    recent_errors: recent,
  };
}

function taxonomyMetadata(deps: AppDeps): {
  contract_hash: string;
  free_label_registry_revision: number;
} {
  return {
    contract_hash: deps.enrich.store.currentContractHash(),
    free_label_registry_revision: deps.enrich.store.registryRevision(),
  };
}

function maybe<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

function freshnessLag(now: Date, newestCompletedAt: string | undefined): number | undefined {
  if (newestCompletedAt === undefined) return undefined;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(newestCompletedAt)) / 1000));
}

function checkedRevision(requested: string | undefined, unitStore: UnitStore): string | Response {
  try {
    return unitStore.assertRevision(requested);
  } catch (error) {
    if (error instanceof StaleUnitRevisionError) {
      return Response.json(
        { error: error.message, current_revision: error.current },
        { status: 409 },
      );
    }
    throw error;
  }
}

async function jsonBody(
  c: Context,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false, response: c.json({ error: "body must be JSON" }, 400) };
  }
}

function tokenTtlForGrant(grant: PoolAccessGrant, fallback: number): number {
  return grant.type === "member_org" ? ORG_GRANT_TOKEN_TTL_MS : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

function splitStateCookie(cookie: string): [string, string] {
  const separator = cookie.indexOf("|");
  if (separator === -1) return [cookie, "/"];
  const next = cookie.slice(separator + 1);
  return [cookie.slice(0, separator), next.startsWith("/") ? next : "/"];
}
