import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "xp1";

export type TokenPayload = {
  username: string;
  expiresAt: number;
  orgs?: readonly TokenOrg[];
};

export type TokenOrg = {
  sub: string;
  name?: string;
};

export type TokenVerification =
  | { ok: true; username: string; orgs: readonly TokenOrg[] }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mint a stateless pool token: `xp1.<payload>.<signature>` where the payload
 * is base64url JSON `{username, expiresAt, orgs?}` and the signature is
 * HMAC-SHA256 over `xp1.<payload>` with the pool signing secret.
 */
export function mintPoolToken(
  secret: string,
  subject: string | { username: string; orgs?: readonly TokenOrg[] },
  expiresAt: Date,
): string {
  const identity = typeof subject === "string" ? { username: subject } : subject;
  const payload = b64url(
    JSON.stringify({
      username: identity.username,
      expiresAt: expiresAt.getTime(),
      ...(identity.orgs === undefined || identity.orgs.length === 0
        ? {}
        : { orgs: normalizeTokenOrgs(identity.orgs) }),
    }),
  );
  return `${PREFIX}.${payload}.${sign(secret, `${PREFIX}.${payload}`)}`;
}

function normalizeTokenOrgs(orgs: readonly TokenOrg[]): TokenOrg[] {
  const bySub = new Map<string, TokenOrg>();
  for (const org of orgs) {
    const sub = org.sub.trim();
    if (sub.length === 0) continue;
    const normalized: TokenOrg = { sub };
    const name = org.name?.trim();
    if (name !== undefined && name.length > 0) normalized.name = name;
    bySub.set(sub, normalized);
  }
  return [...bySub.values()];
}

function decodePayload(payload: string): TokenPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate["username"] !== "string" || candidate["username"].length === 0) {
    return undefined;
  }
  if (typeof candidate["expiresAt"] !== "number") return undefined;
  const orgs = decodeOrgs(candidate["orgs"]);
  if (orgs === undefined) return undefined;
  return { username: candidate["username"], expiresAt: candidate["expiresAt"], orgs };
}

function decodeOrgs(raw: unknown): readonly TokenOrg[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return undefined;
  const orgs: TokenOrg[] = [];
  for (const item of raw) {
    const org = decodeOrg(item);
    if (org === undefined) return undefined;
    orgs.push(org);
  }
  return normalizeTokenOrgs(orgs);
}

function decodeOrg(raw: unknown): TokenOrg | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate["sub"] !== "string" || candidate["sub"].length === 0) return undefined;
  const org: TokenOrg = { sub: candidate["sub"] };
  const name = decodeOptionalName(candidate["name"]);
  if (name === undefined && candidate["name"] !== undefined) return undefined;
  if (name !== undefined) org.name = name;
  return org;
}

function decodeOptionalName(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function splitToken(token: string): [string, string, string] | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || parts[1] === "" || parts[2] === "") {
    return undefined;
  }
  return parts as [string, string, string];
}

/** Verify a pool token's signature and expiry; never throws. */
export function verifyPoolToken(secret: string, token: string, now: Date): TokenVerification {
  const parts = splitToken(token);
  if (parts === undefined) return { ok: false, reason: "malformed" };
  const [prefix, payload, signature] = parts;
  const expected = Buffer.from(sign(secret, `${prefix}.${payload}`));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "bad-signature" };
  }
  const decoded = decodePayload(payload);
  if (decoded === undefined) return { ok: false, reason: "malformed" };
  if (decoded.expiresAt <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, username: decoded.username, orgs: decoded.orgs ?? [] };
}
