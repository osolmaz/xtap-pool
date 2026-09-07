import type Database from "better-sqlite3";
import { z } from "zod";
import { normalizeObservation, tweetSchema } from "@xtap-pool/shared";
import type { PooledTweet } from "@xtap-pool/shared";

const rowSchema = z.object({ json: z.string() });
const pooledTweetSchema = tweetSchema.extend({
  contributed_by: z.string().min(1),
  pooled_at: z.iso.datetime({ offset: true }),
});
const timeSchema = z.object({ at: z.string().nullable() });
const columnsSchema = z.array(z.object({ name: z.string() }));

/** One deterministic winner for current and historical copies. Privacy wins ties. */
export const POST_ORDER = `tweets.captured_at DESC,
  COALESCE(json_extract(tweets.json, '$.is_subscriber_only'), 0) DESC,
  tweets.content_hash DESC, tweets.contributed_by`;

/** Add empty derived columns only. An old database still needs explicit history bootstrap. */
export function ensureContentColumns(db: Database.Database): void {
  for (const [table, columns] of [
    ["tweets", ["content_hash"]],
    ["unit_members", ["content_hash", "content_at"]],
    ["enrichment", ["result_hash"]],
  ] as const) {
    const existing = new Set(
      columnsSchema
        .parse(db.prepare(`PRAGMA table_info(${table})`).all())
        .map((column) => column.name),
    );
    for (const column of columns) {
      if (!existing.has(column))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
  }
}

export function latestPost(db: Database.Database, postId: string): PooledTweet | undefined {
  const row = db
    .prepare(`SELECT tweets.json FROM tweets WHERE tweets.id = ? ORDER BY ${POST_ORDER} LIMIT 1`)
    .get(postId);
  return row === undefined
    ? undefined
    : pooledTweetSchema.parse(JSON.parse(rowSchema.parse(row).json));
}

/** Start of the current content run, not the latest observation of that content.
 * A late intervening edit can move this clock forward; a metric revisit cannot. */
export function contentActivityAt(
  db: Database.Database,
  tweet: PooledTweet,
  previous: { content_hash: string; content_at: string } | undefined,
): { hash: string; at: string } {
  const observation = normalizeObservation(tweet);
  const params = { post: tweet.id, hash: observation.content_hash, until: observation.observed_at };
  const different = timeSchema.parse(
    db
      .prepare(
        `SELECT MAX(observed_at) AS at FROM post_observations
    WHERE post_id = @post AND content_hash <> @hash AND observed_at <= @until`,
      )
      .get(params),
  ).at;
  const same = timeSchema.parse(
    db
      .prepare(
        `SELECT MIN(observed_at) AS at FROM post_observations
    WHERE post_id = @post AND content_hash = @hash AND observed_at <= @until
      AND (@different IS NULL OR observed_at >= @different)`,
      )
      .get({ ...params, different }),
  ).at;
  const times = [observation.observed_at];
  if (same !== null) times.push(same);
  if (
    previous?.content_hash === observation.content_hash &&
    previous.content_at !== "" &&
    (different === null || previous.content_at > different)
  )
    times.push(previous.content_at);
  return { hash: observation.content_hash, at: times.sort()[0] ?? observation.observed_at };
}
