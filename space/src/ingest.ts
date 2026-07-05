import { stampTweet, validateTweet } from "@xtap-pool/shared";
import type { PooledTweet } from "@xtap-pool/shared";
import { z } from "zod";

import type { DatasetMirror } from "./dataset.js";
import type { TweetStore } from "./store.js";

const MAX_BATCH = 1000;

const ingestPayloadSchema = z.object({
  tweets: z.array(z.unknown()).min(1).max(MAX_BATCH),
});

export type IngestOutcome =
  | {
      ok: true;
      added: number;
      duplicates: number;
      rejected: readonly { index: number; reason: string }[];
    }
  | { ok: false; status: 400 | 500; error: string };

export type IngestDeps = {
  store: TweetStore;
  mirror: DatasetMirror;
  now: () => Date;
};

/** Serialize async critical sections (single writer to the dataset repo). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Validate, stamp, dedup and durably persist one ingest batch for a verified
 * contributor. Nothing is persisted locally unless the Hub commit succeeds.
 */
export async function ingestBatch(
  deps: IngestDeps,
  username: string,
  payload: unknown,
): Promise<IngestOutcome> {
  const parsed = ingestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: `invalid payload: expected {tweets: [1..${String(MAX_BATCH)}]}`,
    };
  }

  const rejected: { index: number; reason: string }[] = [];
  const stamped: PooledTweet[] = [];
  const now = deps.now();
  parsed.data.tweets.forEach((candidate, index) => {
    const result = validateTweet(candidate);
    if (result.ok) stamped.push(stampTweet(result.tweet, username, now));
    else rejected.push({ index, reason: result.reason });
  });

  const { accepted, skippedDuplicates } = deps.store.classify(stamped);
  if (accepted.length === 0) {
    return { ok: true, added: 0, duplicates: skippedDuplicates, rejected };
  }

  try {
    const days = [...new Set(accepted.map((tweet) => tweet.captured_at.slice(0, 10)))].sort();
    await deps.mirror.appendAndCommit(
      accepted,
      `pool: ${username} +${String(accepted.length)} tweets (${days.join(", ")})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { ok: false, status: 500, error: `failed to persist to dataset: ${message}` };
  }

  deps.store.insert(accepted);
  return { ok: true, added: accepted.length, duplicates: skippedDuplicates, rejected };
}
