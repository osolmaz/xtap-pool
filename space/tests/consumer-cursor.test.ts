import { describe, expect, it } from "vitest";
import {
  ConsumerCursorCodec,
  consumerCursorSchema,
  CURSOR_RECOVERY_MS,
  PAGE_LEASE_MS,
} from "../src/consumer-cursor.js";
import type { ConsumerCursor } from "../src/consumer-cursor.js";

const instant = Date.parse("2026-09-07T00:00:00.000Z");
const codec = (delta = 0, secret = "test-key-".repeat(8)) =>
  new ConsumerCursorCodec(secret, () => new Date(instant + delta));
const cursor = (position: ConsumerCursor["position"] = { kind: "idle" }): ConsumerCursor => ({
  schema_version: 1,
  target: "a".repeat(64),
  base: ["content", "activation", "observations"].includes(position.kind) ? "b".repeat(64) : null,
  started_at: new Date(instant).toISOString(),
  position,
});

describe("durable consumer cursor", () => {
  it("survives process recreation and binds the exact base, target, and position", () => {
    const value = cursor({ kind: "content", after: "thread:author" });
    const token = codec().encode(value);
    expect(codec().decode(token)).toEqual(value);
    expect(codec().encode(value)).toBe(token);
    const changed = cursor({ kind: "content", after: "other:author" });
    expect(codec().encode(changed)).not.toBe(token);
  });

  it("rejects forged, malformed, oversized, and wrong-key tokens", () => {
    const token = codec().encode(cursor());
    const [body, signature] = token.split(".");
    const altered = Buffer.from(JSON.stringify({ ...cursor(), target: "c".repeat(64) })).toString(
      "base64url",
    );
    for (const candidate of [
      "",
      "x".repeat(4097),
      `${String(body)}.bad`,
      `${altered}.${String(signature)}`,
      token + "=",
      "." + String(signature),
    ])
      expect(() => codec().decode(candidate)).toThrow(/invalid/);
    expect(() => codec(0, "other-key-".repeat(8)).decode(token)).toThrow(/invalid/);
    expect(() => new ConsumerCursorCodec("short")).toThrow(/too short/);
  });

  it("allows 30 days of source recovery but only 48 hours for a pinned sequence", () => {
    const idle = codec().encode(cursor());
    expect(codec(CURSOR_RECOVERY_MS - 1).decode(idle).position.kind).toBe("idle");
    expect(() => codec(CURSOR_RECOVERY_MS).decode(idle)).toThrow(/expired/);
    const page = codec().encode(cursor({ kind: "bootstrap" }));
    expect(codec(PAGE_LEASE_MS - 1).decode(page).position.kind).toBe("bootstrap");
    expect(() => codec(PAGE_LEASE_MS).decode(page)).toThrow(/expired/);
    expect(() => codec(-60_001).decode(idle)).toThrow(/invalid/);
    expect(() => codec(PAGE_LEASE_MS).encode(cursor({ kind: "bootstrap" }))).toThrow(/expired/);
  });

  it("rejects a missing base, extra fields, or a page position that changes the history selection", () => {
    expect(
      consumerCursorSchema.safeParse({ ...cursor({ kind: "content" }), base: null }).success,
    ).toBe(false);
    expect(consumerCursorSchema.safeParse({ ...cursor(), base: "b".repeat(64) }).success).toBe(
      false,
    );
    expect(consumerCursorSchema.safeParse({ ...cursor(), extra: true }).success).toBe(false);
    const history = cursor({
      kind: "history",
      post_ids: ["123"],
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-07T00:00:00.000Z",
    });
    expect(codec().decode(codec().encode(history))).toEqual(history);
    for (const position of [
      { ...history.position, post_ids: ["123", "123"] },
      { ...history.position, until: "2026-09-01T00:00:00.000Z" },
      { ...history.position, until: "2026-10-07T00:00:00.000Z" },
    ])
      expect(consumerCursorSchema.safeParse({ ...history, position }).success).toBe(false);
  });

  it("admits the maximum history ID list without an unbounded token", () => {
    const value = cursor({
      kind: "history",
      post_ids: Array.from({ length: 100 }, (_, i) => String(10n ** 19n + BigInt(i))),
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-07T00:00:00.000Z",
      after: {
        post_id: "10000000000000000000",
        observed_at: "2026-09-05T00:00:00.000Z",
        id: "c".repeat(64),
      },
    });
    const token = codec().encode(value);
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(4096);
    expect(codec().decode(token)).toEqual(value);
  });
});
