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

export type CurrentPostAccess = {
  authorId: string | null;
  isSubscriberOnly: 0 | 1;
  isRetweet: 0 | 1;
};

function restrictedFlag(value: unknown): 0 | 1 {
  return value === undefined || value === false ? 0 : 1;
}

/** Scalar access fields for the deterministic current post copy. */
export function currentPostAccess(tweet: PooledTweet): CurrentPostAccess {
  return {
    authorId: tweet.author.id ?? null,
    isSubscriberOnly: restrictedFlag(tweet["is_subscriber_only"]),
    isRetweet: restrictedFlag(tweet["is_retweet"]),
  };
}

export function restrictedAccessSql(
  jsonSql: string,
  field: "is_subscriber_only" | "is_retweet",
): string {
  return `CASE WHEN json_type(${jsonSql}, '$.${field}') IS NULL
    OR json_type(${jsonSql}, '$.${field}') = 'false' THEN 0 ELSE 1 END`;
}

/** One deterministic winner for current and historical copies. Restricted copies win ties. */
export const POST_ORDER = `tweets.captured_at DESC,
  ${restrictedAccessSql("tweets.json", "is_subscriber_only")} DESC,
  ${restrictedAccessSql("tweets.json", "is_retweet")} DESC,
  tweets.content_hash DESC, tweets.contributed_by`;

/** Add rebuildable derived columns and migrate old indexes in place. */
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

  db.transaction(() => {
    const membershipColumns = new Set(
      columnsSchema
        .parse(db.prepare("PRAGMA table_info(unit_members)").all())
        .map((column) => column.name),
    );
    let needsAccessBackfill = false;
    if (!membershipColumns.has("author_id")) {
      db.exec("ALTER TABLE unit_members ADD COLUMN author_id TEXT");
      needsAccessBackfill = true;
    }
    for (const column of ["is_subscriber_only", "is_retweet"] as const) {
      if (membershipColumns.has(column)) continue;
      db.exec(
        `ALTER TABLE unit_members ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} IN (0, 1))`,
      );
      needsAccessBackfill = true;
    }
    if (needsAccessBackfill) {
      db.exec(`UPDATE unit_members AS membership SET
        author_id = (SELECT json_extract(tweets.json, '$.author.id') FROM tweets
          WHERE tweets.id = membership.tweet_id ORDER BY ${POST_ORDER} LIMIT 1),
        is_subscriber_only = COALESCE((SELECT CASE
          WHEN json_type(tweets.json, '$.is_subscriber_only') IS NULL
            OR json_type(tweets.json, '$.is_subscriber_only') = 'false' THEN 0 ELSE 1 END
          FROM tweets WHERE tweets.id = membership.tweet_id ORDER BY ${POST_ORDER} LIMIT 1), 1),
        is_retweet = COALESCE((SELECT CASE
          WHEN json_type(tweets.json, '$.is_retweet') IS NULL
            OR json_type(tweets.json, '$.is_retweet') = 'false' THEN 0 ELSE 1 END
          FROM tweets WHERE tweets.id = membership.tweet_id ORDER BY ${POST_ORDER} LIMIT 1), 1)`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_unit_members_author_unit
        ON unit_members(author_id, unit_id);
      CREATE INDEX IF NOT EXISTS idx_unit_members_current_access
        ON unit_members(unit_id, author_id, is_subscriber_only, is_retweet, tweet_id);
      DROP INDEX IF EXISTS idx_tweets_consumer_access;
    `);
  })();
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
