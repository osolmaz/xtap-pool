import { z } from "zod";

// Strict ISO-8601: the store compares these lexicographically and dayKey
// derives dataset paths from them, so loose Date.parse inputs ("1",
// "May 21 2026") must be rejected, not coerced.
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isoTimestamp = z
  .string()
  .refine((value) => ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value)), {
    error: "not an ISO timestamp",
  });

const authorSchema = z
  .looseObject({
    id: z.string().optional(),
    username: z.string().min(1),
    display_name: z.string().optional(),
  })
  .readonly();

/**
 * Structural validation for one captured tweet in the xTap output format.
 *
 * Deliberately tolerant: only the fields the pool relies on are enforced, and
 * unknown fields pass through untouched so upstream xTap format evolution
 * never breaks ingestion.
 */
export const tweetSchema = z.looseObject({
  id: z.string().min(1),
  url: z.string().min(1),
  text: z.string(),
  captured_at: isoTimestamp,
  created_at: isoTimestamp.optional(),
  author: authorSchema,
});

export type Tweet = z.infer<typeof tweetSchema>;

/** A tweet as stored in the pool dataset, with server-stamped attribution. */
export type PooledTweet = Tweet & {
  contributed_by: string;
  pooled_at: string;
};

export type TweetValidationResult = { ok: true; tweet: Tweet } | { ok: false; reason: string };

/** Validate one candidate tweet object; never throws. */
export function validateTweet(candidate: unknown): TweetValidationResult {
  const parsed = tweetSchema.safeParse(candidate);
  if (parsed.success) {
    return { ok: true, tweet: parsed.data };
  }
  const first = parsed.error.issues[0];
  const reason =
    first === undefined ? "invalid tweet" : `${first.path.join(".")}: ${first.message}`;
  return { ok: false, reason };
}

/**
 * Stamp verified attribution onto a tweet. Any client-supplied values for the
 * stamped fields are overwritten — attribution is server-controlled.
 */
export function stampTweet(tweet: Tweet, contributedBy: string, pooledAt: Date): PooledTweet {
  return { ...tweet, contributed_by: contributedBy, pooled_at: pooledAt.toISOString() };
}

/** UTC day key (`YYYY-MM-DD`) a tweet belongs to, from its capture time. */
export function dayKey(capturedAt: string): string {
  const day = new Date(capturedAt).toISOString().slice(0, 10);
  return day;
}

/**
 * Dataset-repo path of the daily JSONL file for a contributor, mirroring the
 * xtap-store layout: `data/<user>/YYYY/MM/tweets-YYYY-MM-DD.jsonl`.
 */
export function datasetPathFor(contributedBy: string, capturedAt: string): string {
  const day = dayKey(capturedAt);
  const [year, month] = [day.slice(0, 4), day.slice(5, 7)];
  return `data/${contributedBy}/${year}/${month}/tweets-${day}.jsonl`;
}
