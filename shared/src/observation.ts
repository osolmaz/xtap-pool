import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./hash.js";
import type { PooledTweet } from "./tweet.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const observationMetricsSchema = z
  .object({
    likes: counter,
    replies: counter,
    reposts: counter,
    views: counter,
  })
  .strict();
export const observationSchema = z
  .object({
    id: sha256,
    post_id: z.string().min(1),
    observed_at: z.iso.datetime(),
    received_at: z.iso.datetime(),
    content_hash: sha256,
    metrics: observationMetricsSchema,
  })
  .strict();
export type ObservationMetrics = z.infer<typeof observationMetricsSchema>;
export type Observation = z.infer<typeof observationSchema>;

const recordSchema = z.record(z.string(), z.unknown());
/** Only exact source counters are admitted. Rounded displays and overflow stay unknown. */
export function exactCounter(value: unknown): number | null {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)) {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function observationMetrics(value: unknown): ObservationMetrics {
  const parsed = recordSchema.safeParse(value);
  const raw = parsed.success ? parsed.data : {};
  const normalize = (value: unknown): number | null => {
    const count = exactCounter(value);
    // The old parser replaced absent counters with zero. The raw log cannot
    // recover whether those zeros were measured, so they are not baselines.
    return count === 0 && raw["format"] !== "exact-v1" ? null : count;
  };
  return {
    likes: normalize(raw["likes"]),
    replies: normalize(raw["replies"]),
    reposts: normalize(raw["retweets"]),
    views: normalize(raw["views"]),
  };
}
const OBSERVATION_ONLY_FIELDS = new Set([
  "captured_at",
  "pooled_at",
  "contributed_by",
  "metrics",
  "source_endpoint",
  "observation_id",
  "__xtap_image_backfill",
]);
/** Preserve content fields while excluding transport and sampled counters.
 * The enrichment input hash remains separately scoped to actual model input. */
export function tweetContent(tweet: PooledTweet): Record<string, unknown> {
  const content = Object.fromEntries(
    Object.entries(tweet).filter(([key]) => !OBSERVATION_ONLY_FIELDS.has(key)),
  );
  content["author"] = Object.fromEntries(
    Object.entries(tweet.author).filter(([key]) => key !== "follower_count"),
  );
  return content;
}
export function contentHash(tweet: PooledTweet): string {
  return digest(tweetContent(tweet));
}
export function normalizeObservation(tweet: PooledTweet): Observation {
  const content = contentHash(tweet);
  const observedAt = new Date(tweet.captured_at).toISOString();
  const metrics = observationMetrics(tweet["metrics"]);
  const id = digest({
    post_id: tweet.id,
    contributor: tweet.contributed_by,
    observed_at: observedAt,
    content_hash: content,
    metrics,
  });
  return observationSchema.parse({
    id,
    post_id: tweet.id,
    observed_at: observedAt,
    received_at: new Date(tweet.pooled_at).toISOString(),
    content_hash: content,
    metrics,
  });
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
