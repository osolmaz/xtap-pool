import { stampTweet, validateTweet } from "@xtap-pool/shared";
import type { PooledTweet } from "@xtap-pool/shared";

const MAX_FUTURE_CAPTURE_MS = 5 * 60_000;

export type IngestRejection = { index: number; reason: string };

export type PreparedIngest = {
  stamped: PooledTweet[];
  rejected: IngestRejection[];
};

/** Serialize async critical sections (single raw Bucket writer). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Validate candidate tweets and stamp verified attribution onto the valid ones.
 * `contributor` must come from verified auth; candidate attribution is overwritten.
 */
export function prepareIngest(
  candidates: readonly unknown[],
  contributor: string,
  pooledAt: Date,
  now: Date,
): PreparedIngest {
  const rejected: IngestRejection[] = [];
  const stamped: PooledTweet[] = [];
  candidates.forEach((candidate, index) => {
    const result = validateTweet(candidate);
    if (!result.ok) rejected.push({ index, reason: result.reason });
    else if (Date.parse(result.tweet.captured_at) > now.getTime() + MAX_FUTURE_CAPTURE_MS)
      rejected.push({ index, reason: "captured_at is more than five minutes in the future" });
    else stamped.push(stampTweet(result.tweet, contributor, pooledAt));
  });
  return { stamped, rejected };
}
