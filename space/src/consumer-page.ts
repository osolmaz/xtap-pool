import { z } from "zod";
import { contentHash, labelAssignmentSchema, tweetSchema } from "@xtap-pool/shared";
import { consumerTaxonomySchema } from "./consumer-context.js";
import { consumerRegistrySchema } from "./consumer-registry.js";
import { consumerObservationSchema } from "./consumer-observations.js";
import { consumerCursorSchema } from "./consumer-cursor.js";

const unitSchema = z
  .object({
    id: z.string().min(1),
    posts: z
      .array(
        tweetSchema.extend({
          contributed_by: z.string().min(1),
          pooled_at: z.iso.datetime({ offset: true }),
        }),
      )
      .max(2000)
      .readonly(),
    contributors: z.array(z.string()).readonly(),
    preset_labels: z.array(labelAssignmentSchema).readonly(),
    free_labels: z.array(labelAssignmentSchema).readonly(),
  })
  .strict();
const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const consumerUnitUpsertSchema = z
  .object({
    type: z.literal("unit_upsert"),
    content_hash: contentHashSchema,
    post_content_hashes: z.array(contentHashSchema).max(2000),
    unit: unitSchema,
  })
  .strict()
  .superRefine((change, context) => {
    if (change.post_content_hashes.length !== change.unit.posts.length) {
      context.addIssue({
        code: "custom",
        path: ["post_content_hashes"],
        message: "One content hash is required for each returned post, in the same order.",
      });
      return;
    }
    change.unit.posts.forEach((post, index) => {
      if (change.post_content_hashes[index] !== contentHash(post))
        context.addIssue({
          code: "custom",
          path: ["post_content_hashes", index],
          message: "The content hash does not match the returned post body.",
        });
    });
  });
export const consumerChangeSchema = z.discriminatedUnion("type", [
  consumerUnitUpsertSchema,
  z
    .object({
      type: z.literal("unit_remove"),
      unit_id: z.string().min(1),
      reason: z.literal("not_available"),
    })
    .strict(),
  z.object({ type: z.literal("observation"), observation: consumerObservationSchema }).strict(),
  z
    .object({
      type: z.literal("metadata"),
      taxonomy: consumerTaxonomySchema,
      approved: consumerRegistrySchema.shape.approved,
    })
    .strict(),
]);
export type ConsumerChange = z.infer<typeof consumerChangeSchema>;
export const consumerStepSchema = z
  .object({ changes: z.array(consumerChangeSchema).max(500), cursor: consumerCursorSchema })
  .strict();
export type ConsumerStep = z.infer<typeof consumerStepSchema>;
export const HARD_PAGE_BYTES = 8 * 1_048_576;
const TARGET_PAGE_BYTES = 2 * 1_048_576;
export class OversizedConsumerSource extends Error {
  constructor() {
    super("a complete source item exceeds the page byte bound");
  }
}

/** Leave room for the signed cursor and source envelope. Never split an item silently. */
export class ConsumerPageBuilder {
  readonly changes: ConsumerChange[] = [];
  private bytes = 8192;
  constructor(private readonly limit: number) {
    z.number().int().min(1).max(500).parse(limit);
  }
  add(change: ConsumerChange): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(change)) + 1;
    if (bytes + 8192 > HARD_PAGE_BYTES) throw new OversizedConsumerSource();
    if (
      this.changes.length >= this.limit ||
      (this.changes.length > 0 && this.bytes + bytes > TARGET_PAGE_BYTES)
    )
      return false;
    this.changes.push(change);
    this.bytes += bytes;
    return true;
  }
}
