import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "xp1";

export type TokenPayload = {
  username: string;
  expiresAt: number;
};

export type TokenVerification =
  { ok: true; username: string } | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mint a stateless pool token: `xp1.<payload>.<signature>` where the payload
 * is base64url JSON `{username, expiresAt}` and the signature is
 * HMAC-SHA256 over `xp1.<payload>` with the pool signing secret.
 */
export function mintPoolToken(secret: string, username: string, expiresAt: Date): string {
  const payload = b64url(JSON.stringify({ username, expiresAt: expiresAt.getTime() }));
  return `${PREFIX}.${payload}.${sign(secret, `${PREFIX}.${payload}`)}`;
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
  return { username: candidate["username"], expiresAt: candidate["expiresAt"] };
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
  return { ok: true, username: decoded.username };
}
