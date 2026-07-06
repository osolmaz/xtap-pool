import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { mintPoolToken, verifyPoolToken } from "../src/pool-token.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-07-06T00:00:00.000Z");
const FUTURE = new Date("2026-12-31T00:00:00.000Z");

describe("pool tokens", () => {
  it("round-trips a valid token", () => {
    const token = mintPoolToken(SECRET, "osolmaz", FUTURE);
    expect(token.startsWith("xp1.")).toBe(true);
    const verified = verifyPoolToken(SECRET, token, NOW);
    expect(verified).toEqual({ ok: true, username: "osolmaz", orgs: [] });
  });

  it("round-trips organization identities", () => {
    const token = mintPoolToken(
      SECRET,
      { username: "dana", orgs: [{ sub: "org-hf", name: "huggingface" }] },
      FUTURE,
    );
    expect(verifyPoolToken(SECRET, token, NOW)).toEqual({
      ok: true,
      username: "dana",
      orgs: [{ sub: "org-hf", name: "huggingface" }],
    });
  });

  it("rejects an expired token", () => {
    const token = mintPoolToken(SECRET, "osolmaz", NOW);
    expect(verifyPoolToken(SECRET, token, NOW)).toEqual({ ok: false, reason: "expired" });
    const justBefore = mintPoolToken(SECRET, "osolmaz", new Date(NOW.getTime() - 1));
    expect(verifyPoolToken(SECRET, justBefore, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a token expiring in the future only until it expires", () => {
    const token = mintPoolToken(SECRET, "osolmaz", FUTURE);
    expect(verifyPoolToken(SECRET, token, new Date(FUTURE.getTime() + 1)).ok).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintPoolToken("another-secret-another-secret-12", "osolmaz", FUTURE);
    expect(verifyPoolToken(SECRET, token, NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects tampered payloads", () => {
    const token = mintPoolToken(SECRET, "osolmaz", FUTURE);
    const [prefix, , signature] = token.split(".") as [string, string, string];
    const forgedPayload = Buffer.from(
      JSON.stringify({ username: "mallory", expiresAt: FUTURE.getTime() }),
    ).toString("base64url");
    const forged = `${prefix}.${forgedPayload}.${signature}`;
    expect(verifyPoolToken(SECRET, forged, NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it.each([
    ["empty", ""],
    ["garbage", "not-a-token"],
    ["wrong prefix", "xp2.abc.def"],
    ["missing parts", "xp1.abc"],
    ["empty payload", "xp1..sig"],
    ["extra parts", "xp1.a.b.c"],
  ])("rejects malformed token: %s", (_label, token) => {
    expect(verifyPoolToken(SECRET, token, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects structurally invalid payloads that are correctly signed", () => {
    const badPayloads = [
      JSON.stringify({ expiresAt: FUTURE.getTime() }),
      JSON.stringify({ username: "", expiresAt: FUTURE.getTime() }),
      JSON.stringify({ username: "osolmaz", expiresAt: "soon" }),
      JSON.stringify({ username: "osolmaz", expiresAt: FUTURE.getTime(), orgs: "huggingface" }),
      JSON.stringify({
        username: "osolmaz",
        expiresAt: FUTURE.getTime(),
        orgs: [{ name: "huggingface" }],
      }),
      JSON.stringify("just-a-string"),
      "not json at all",
    ];
    for (const rawPayload of badPayloads) {
      const payload = Buffer.from(rawPayload).toString("base64url");
      const signature = createHmac("sha256", SECRET).update(`xp1.${payload}`).digest("base64url");
      const token = `xp1.${payload}.${signature}`;
      expect(verifyPoolToken(SECRET, token, NOW)).toEqual({ ok: false, reason: "malformed" });
    }
  });
});
