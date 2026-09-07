import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@xtap-pool/shared";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(512);
const postId = z.string().regex(/^\d{1,20}$/u);
export const observationPositionSchema = z
  .object({ post_id: postId, observed_at: z.iso.datetime(), id: hash })
  .strict();
export type ObservationPosition = z.infer<typeof observationPositionSchema>;
const positionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }).strict(),
  z.object({ kind: z.literal("bootstrap"), after: id.optional() }).strict(),
  z.object({ kind: z.literal("content"), after: id.optional() }).strict(),
  z
    .object({
      kind: z.literal("activation"),
      unit: id,
      after: observationPositionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("observations"),
      segment_offset: z.number().int().nonnegative(),
      after: observationPositionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("history"),
      post_ids: z.array(postId).min(1).max(100),
      since: z.iso.datetime(),
      until: z.iso.datetime(),
      after: observationPositionSchema.optional(),
    })
    .strict(),
]);
export const consumerCursorSchema = z
  .object({
    schema_version: z.literal(1),
    target: hash,
    base: hash.nullable(),
    started_at: z.iso.datetime(),
    position: positionSchema,
  })
  .strict()
  .superRefine((cursor, context) => {
    const changes = ["content", "activation", "observations"].includes(cursor.position.kind);
    if (changes !== (cursor.base !== null))
      context.addIssue({
        code: "custom",
        path: ["base"],
        message: "a changes cursor requires its fixed base",
      });
    const position = cursor.position;
    if (position.kind === "history") {
      const duration = Date.parse(position.until) - Date.parse(position.since);
      if (
        duration <= 0 ||
        duration > 30 * DAY ||
        new Set(position.post_ids).size !== position.post_ids.length
      )
        context.addIssue({
          code: "custom",
          path: ["position"],
          message: "history requires distinct IDs and a positive range of at most 30 days",
        });
    }
  });
export type ConsumerCursor = z.infer<typeof consumerCursorSchema>;
const DAY = 86_400_000;
export const CURSOR_RECOVERY_MS = 30 * DAY;
export const PAGE_LEASE_MS = 2 * DAY;
const MAX_BYTES = 4096;
export class InvalidConsumerCursor extends Error {
  constructor() {
    super("invalid consumer cursor");
  }
}
export class ExpiredConsumerCursor extends Error {
  constructor() {
    super("consumer cursor expired; an explicit new bootstrap is required");
  }
}

/** The existing signing key is used in place with a separate message domain.
 * Source and selection live in checksum-addressed target/base contexts, not process memory. */
export class ConsumerCursorCodec {
  constructor(
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (secret.length < 32) throw new Error("consumer cursor signing key is too short");
  }

  encode(input: ConsumerCursor): string {
    const cursor = consumerCursorSchema.parse(input);
    this.checkAge(cursor);
    const body = Buffer.from(canonicalJson(cursor)).toString("base64url");
    const encoded = `${body}.${this.signature(body).toString("base64url")}`;
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new InvalidConsumerCursor();
    return encoded;
  }

  decode(encoded: string): ConsumerCursor {
    const body = this.verifiedBody(encoded);
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new InvalidConsumerCursor();
    }
    const cursor = consumerCursorSchema.safeParse(value);
    if (!cursor.success) throw new InvalidConsumerCursor();
    this.checkAge(cursor.data);
    return cursor.data;
  }

  private verifiedBody(encoded: string): string {
    if (
      Buffer.byteLength(encoded) > MAX_BYTES ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(encoded)
    )
      throw new InvalidConsumerCursor();
    const [body, signature] = encoded.split(".");
    if (body === undefined || signature === undefined) throw new InvalidConsumerCursor();
    const bytes = Buffer.from(signature, "base64url");
    const expected = this.signature(body);
    if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected))
      throw new InvalidConsumerCursor();
    return body;
  }

  private checkAge(cursor: ConsumerCursor): void {
    const age = this.now().getTime() - Date.parse(cursor.started_at);
    if (age < -60_000) throw new InvalidConsumerCursor();
    const lifetime = cursor.position.kind === "idle" ? CURSOR_RECOVERY_MS : PAGE_LEASE_MS;
    if (age >= lifetime) throw new ExpiredConsumerCursor();
  }

  private signature(body: string): Buffer {
    return createHmac("sha256", this.secret).update(`xtap-consumer-cursor\0${body}`).digest();
  }
}
