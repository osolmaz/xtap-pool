import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { z } from "zod";

import { renderConnectPage } from "./connect-page.js";
import type { SpaceConfig } from "./config.js";
import { authorizeUrl, exchangeCodeForUsername } from "./oauth.js";
import type { IngestOutcome } from "./ingest.js";
import { mintPoolToken, verifyPoolToken } from "./pool-token.js";
import type { TweetStore, TweetQuery } from "./store.js";

const SESSION_COOKIE = "xtap_pool_session";
const OAUTH_STATE_COOKIE = "xtap_pool_oauth";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POOL_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export type AppDeps = {
  config: SpaceConfig;
  store: TweetStore;
  ingest: (username: string, payload: unknown) => Promise<IngestOutcome>;
  now?: () => Date;
  oauthFetch?: typeof fetch;
};

const tweetsQuerySchema = z.object({
  contributors: z.string().optional(),
  author: z.string().optional(),
  q: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  has_media: z.enum(["true", "false"]).optional(),
  is_article: z.enum(["true", "false"]).optional(),
  dedup: z.enum(["true", "false"]).default("true"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

function parseFlag(value: "true" | "false" | undefined): boolean | undefined {
  return value === undefined ? undefined : value === "true";
}

function toTweetQuery(raw: z.infer<typeof tweetsQuerySchema>): TweetQuery {
  const candidate = {
    dedup: raw.dedup === "true",
    limit: raw.limit,
    contributors: raw.contributors
      ?.split(",")
      .map((user) => user.trim())
      .filter((user) => user.length > 0),
    author: raw.author,
    q: raw.q,
    since: raw.since,
    until: raw.until,
    hasMedia: parseFlag(raw.has_media),
    isArticle: parseFlag(raw.is_article),
    cursor: raw.cursor,
  };
  return Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined));
}

export function createApp(deps: AppDeps): Hono {
  const { config, store } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const isAllowed = (username: string): boolean =>
    config.allowedUsers.some((user) => user.toLowerCase() === username.toLowerCase());

  const sessionUser = (c: Context): string | undefined => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie === undefined) return undefined;
    const verified = verifyPoolToken(config.sessionSecret, cookie, now());
    return verified.ok && isAllowed(verified.username) ? verified.username : undefined;
  };

  const bearerUser = (c: Context): string | undefined => {
    const header = c.req.header("authorization");
    if (header?.toLowerCase().startsWith("bearer ") !== true) return undefined;
    const verified = verifyPoolToken(config.poolSigningSecret, header.slice(7).trim(), now());
    return verified.ok && isAllowed(verified.username) ? verified.username : undefined;
  };

  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, tweets: store.count() }));

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
    return c.redirect(
      authorizeUrl(
        {
          clientId: config.oauthClientId,
          clientSecret: config.oauthClientSecret,
          providerUrl: config.openidProviderUrl,
          redirectUri: `${config.publicUrl}/oauth/callback`,
        },
        state,
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
    const username = await exchangeCodeForUsername(settings, code);
    if (username === undefined) return c.text("oauth exchange failed", 401);
    if (!isAllowed(username)) {
      return c.text(`@${username} is not on this pool's allowlist`, 403);
    }
    const session = mintPoolToken(
      config.sessionSecret,
      username,
      new Date(now().getTime() + SESSION_TTL_MS),
    );
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.redirect(next);
  });

  app.get("/connect", (c) => {
    const username = sessionUser(c);
    if (username === undefined) return c.redirect("/oauth/login?next=/connect");
    const token = mintPoolToken(
      config.poolSigningSecret,
      username,
      new Date(now().getTime() + POOL_TOKEN_TTL_MS),
    );
    return c.html(renderConnectPage(username, token));
  });

  app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type"] }));

  app.post("/api/ingest", async (c) => {
    const username = bearerUser(c);
    if (username === undefined) return c.json({ error: "invalid or missing pool token" }, 401);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const outcome = await deps.ingest(username, payload);
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    return c.json({
      added: outcome.added,
      duplicates: outcome.duplicates,
      rejected: outcome.rejected,
    });
  });

  app.get("/api/me", (c) => {
    const username = bearerUser(c) ?? sessionUser(c);
    if (username === undefined) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ username });
  });

  app.get("/api/tweets", (c) => {
    const username = sessionUser(c);
    if (username === undefined) return c.json({ error: "unauthenticated" }, 401);
    const parsed = tweetsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query parameters" }, 400);
    const page = store.query(toTweetQuery(parsed.data));
    return c.json(page);
  });

  app.get("/api/contributors", (c) => {
    const username = sessionUser(c);
    if (username === undefined) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ contributors: store.contributors() });
  });

  return app;
}

function splitStateCookie(cookie: string): [string, string] {
  const separator = cookie.indexOf("|");
  if (separator === -1) return [cookie, "/"];
  const next = cookie.slice(separator + 1);
  return [cookie.slice(0, separator), next.startsWith("/") ? next : "/"];
}
