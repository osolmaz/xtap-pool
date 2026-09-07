import { z } from "zod";
import { canonicalJson, labelConfigSchema } from "@xtap-pool/shared";
import { canonicalBytes, sha256 } from "./bucket-log.js";
import type { BucketSnapshot } from "./bucket-log.js";
import type { DurableIndexBucketClient } from "./durable-index.js";
import { CONSUMER_PROJECTION_HASH } from "./consumer-index-state.js";
import type { ConsumerIndexBoundary } from "./consumer-index-state.js";
import { consumerRegistrySchema } from "./consumer-registry.js";
import { ConsumerSourceStore, consumerSourceSchema } from "./consumer-source.js";
import { CURSOR_RECOVERY_MS, ExpiredConsumerCursor } from "./consumer-cursor.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const names = z.array(z.string().trim().min(1).max(128)).max(100);
const sorted = (values: readonly string[]) => [...new Set(values)].sort();
export const consumerSelectionSchema = z
  .object({
    author_ids: z
      .array(z.string().regex(/^[1-9]\d{0,19}$/u))
      .min(1)
      .max(500),
    labels: names,
    label_mode: z.enum(["any", "all"]),
    free_label: z.string().trim().min(1).max(128).optional(),
    publication: z.literal("public-original"),
  })
  .strict()
  .transform((value) => ({
    ...value,
    author_ids: sorted(value.author_ids),
    labels: sorted(value.labels),
  }));
export type ConsumerSelection = z.infer<typeof consumerSelectionSchema>;
export const consumerTaxonomySchema = z
  .object({ version: z.number().int().positive(), labels: z.array(labelConfigSchema).max(100) })
  .strict();
export const consumerContextSchema = z
  .object({
    schema_version: z.literal(1),
    created_at: z.iso.datetime(),
    source: hash,
    snapshot: consumerSourceSchema,
    projection: z.literal(CONSUMER_PROJECTION_HASH),
    contract: hash,
    selection: consumerSelectionSchema,
    complete_through: z.iso.datetime().nullable(),
    observations_through: z.iso.datetime().nullable(),
    history_since: z.iso.datetime(),
    registry: consumerRegistrySchema,
    taxonomy: consumerTaxonomySchema,
  })
  .strict();
export type ConsumerContext = z.infer<typeof consumerContextSchema>;
export type ResolvedConsumerContext = {
  id: string;
  context: ConsumerContext;
  snapshot: BucketSnapshot;
};
export const CONSUMER_CONTEXT_PREFIX = "index/consumer-contexts/";
const MAX_CONTEXT_BYTES = 8 * 1_048_576;

/** Immutable read metadata only. This writer cannot replace index/current.json.
 * Pin under the same application mutex as the completed index advance and coverage read. */
export class ConsumerContextStore {
  constructor(
    private readonly sources: ConsumerSourceStore,
    private readonly bucket: Pick<DurableIndexBucketClient, "readText" | "writeText">,
    private readonly contract: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async pin(options: {
    boundary: ConsumerIndexBoundary;
    snapshot: BucketSnapshot;
    selection: ConsumerSelection;
    taxonomy: z.infer<typeof consumerTaxonomySchema>;
    completeThrough: string | null;
    observationsThrough: string | null;
  }): Promise<ResolvedConsumerContext> {
    const now = this.now();
    if (
      sha256(canonicalBytes(options.snapshot)) !== options.boundary.source ||
      options.boundary.contract !== this.contract
    )
      throw new Error("consumer metadata does not match its verified source boundary");
    const source = await this.sources.describe(options.snapshot);
    const context = consumerContextSchema.parse({
      schema_version: 1,
      created_at: now.toISOString(),
      source: source.revision,
      snapshot: source.source,
      projection: options.boundary.projection,
      contract: this.contract,
      selection: options.selection,
      complete_through: options.completeThrough,
      observations_through: options.observationsThrough,
      history_since: new Date(
        historyEnd(now.toISOString(), options.observationsThrough) - CURSOR_RECOVERY_MS,
      ).toISOString(),
      registry: options.boundary.registry,
      taxonomy: options.taxonomy,
    });
    const text = canonicalJson(context);
    if (Buffer.byteLength(text) > MAX_CONTEXT_BYTES)
      throw new Error("consumer metadata exceeds its byte bound");
    const id = sha256(Buffer.from(text));
    const path = `${CONSUMER_CONTEXT_PREFIX}${id}.json`;
    const existing = await this.bucket.readText(path);
    if (existing === undefined) await this.bucket.writeText(path, text);
    if ((await this.bucket.readText(path)) !== text)
      throw new Error("consumer metadata read-back mismatch");
    return { id, context, snapshot: options.snapshot };
  }

  async read(id: string): Promise<ResolvedConsumerContext> {
    hash.parse(id);
    const text = await this.bucket.readText(`${CONSUMER_CONTEXT_PREFIX}${id}.json`);
    if (text === undefined) throw new ExpiredConsumerCursor();
    if (Buffer.byteLength(text) > MAX_CONTEXT_BYTES || sha256(Buffer.from(text)) !== id)
      throw new Error("consumer metadata checksum or size mismatch");
    const context = consumerContextSchema.parse(JSON.parse(text));
    if (context.contract !== this.contract)
      throw new Error("consumer semantic contract changed; explicit bootstrap is required");
    const age = this.now().getTime() - Date.parse(context.created_at);
    if (age < -60_000) throw new Error("consumer context is from the future");
    if (age >= CURSOR_RECOVERY_MS) throw new ExpiredConsumerCursor();
    return { id, context, snapshot: await this.sources.resolve(context.source, context.snapshot) };
  }
}

/** Compare source metadata independently of counter/coverage movement. Consumers derive
 * selected graph counts and links from their saved unit labels, not another full source read. */
export function consumerMetadataHash(context: ConsumerContext): string {
  return sha256(
    Buffer.from(canonicalJson({ taxonomy: context.taxonomy, approved: context.registry.approved })),
  );
}

/** Exclusive upper bound includes the last reported sample, including admitted clock skew. */
export function consumerHistoryUntil(context: ConsumerContext): string {
  return new Date(historyEnd(context.created_at, context.observations_through)).toISOString();
}
function historyEnd(createdAt: string, observationsThrough: string | null): number {
  return (
    Math.max(
      Date.parse(createdAt),
      observationsThrough === null ? 0 : Date.parse(observationsThrough),
    ) + 1
  );
}
