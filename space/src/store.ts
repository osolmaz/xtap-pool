import Database from "better-sqlite3";

import type { PooledTweet } from "@xtap-pool/shared";

export type TweetQuery = {
  contributors?: readonly string[];
  author?: string;
  q?: string;
  since?: string;
  until?: string;
  hasMedia?: boolean;
  isArticle?: boolean;
  dedup?: boolean;
  limit?: number;
  cursor?: string;
};

export type TweetRecord = {
  tweet: PooledTweet;
  contributors: readonly string[];
};

export type TweetPage = {
  records: readonly TweetRecord[];
  nextCursor?: string;
};

export type ContributorStats = {
  username: string;
  tweetCount: number;
  lastPooledAt: string;
};

export type ClassifiedBatch = {
  accepted: readonly PooledTweet[];
  skippedDuplicates: number;
};

type TweetRow = {
  json: string;
  sort_ts: string;
  id: string;
  contributed_by: string;
  contributors: string;
};

type ExistingRow = { captured_at: string };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Cursor = { sortTs: string; id: string; contributedBy?: string };

/**
 * Keyset cursor. Deduped pages are keyed by (sort_ts, id); non-deduped pages
 * additionally carry contributed_by, since several contributors can hold the
 * same tweet id and a page boundary must not skip the remaining copies.
 */
export function encodeCursor(sortTs: string, id: string, contributedBy?: string): string {
  const parts = contributedBy === undefined ? [sortTs, id] : [sortTs, id, contributedBy];
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

export function decodeCursor(cursor: string): Cursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 3) return undefined;
  if (!parsed.every((part) => typeof part === "string")) return undefined;
  const [sortTs, id, contributedBy] = parsed as [string, string, string?];
  return contributedBy === undefined ? { sortTs, id } : { sortTs, id, contributedBy };
}

/** In-process index over the pooled tweets; a cache of the dataset repo, rebuilt on boot. */
export class TweetStore {
  private readonly db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tweets (
        id TEXT NOT NULL,
        contributed_by TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        pooled_at TEXT NOT NULL,
        sort_ts TEXT NOT NULL,
        author_username TEXT NOT NULL,
        text TEXT NOT NULL,
        has_media INTEGER NOT NULL,
        is_article INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (id, contributed_by)
      );
      CREATE INDEX IF NOT EXISTS idx_tweets_sort ON tweets(sort_ts DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_tweets_contributor ON tweets(contributed_by);
      CREATE INDEX IF NOT EXISTS idx_tweets_author ON tweets(author_username);
    `);
  }

  /** Split a stamped batch into tweets worth storing vs. exact/stale duplicates. */
  classify(tweets: readonly PooledTweet[]): ClassifiedBatch {
    const existingStmt = this.db.prepare(
      "SELECT captured_at FROM tweets WHERE id = ? AND contributed_by = ?",
    );
    let skippedDuplicates = 0;
    const seenInBatch = new Map<string, PooledTweet>();
    for (const tweet of tweets) {
      const batchKey = `${tweet.id}\u0000${tweet.contributed_by}`;
      const inBatch = seenInBatch.get(batchKey);
      if (inBatch !== undefined) {
        if (tweet.captured_at > inBatch.captured_at) seenInBatch.set(batchKey, tweet);
        skippedDuplicates += 1;
        continue;
      }
      const existing = existingStmt.get(tweet.id, tweet.contributed_by) as ExistingRow | undefined;
      if (existing !== undefined && existing.captured_at >= tweet.captured_at) {
        skippedDuplicates += 1;
        continue;
      }
      seenInBatch.set(batchKey, tweet);
    }
    return { accepted: [...seenInBatch.values()], skippedDuplicates };
  }

  /** Upsert stamped tweets, keeping the freshest capture per (id, contributor). */
  insert(tweets: readonly PooledTweet[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO tweets
        (id, contributed_by, captured_at, pooled_at, sort_ts, author_username, text,
         has_media, is_article, json)
      VALUES
        (@id, @contributedBy, @capturedAt, @pooledAt, @sortTs, @authorUsername, @text,
         @hasMedia, @isArticle, @json)
      ON CONFLICT (id, contributed_by) DO UPDATE SET
        captured_at = excluded.captured_at,
        pooled_at = excluded.pooled_at,
        sort_ts = excluded.sort_ts,
        author_username = excluded.author_username,
        text = excluded.text,
        has_media = excluded.has_media,
        is_article = excluded.is_article,
        json = excluded.json
      WHERE excluded.captured_at > tweets.captured_at
    `);
    const insertAll = this.db.transaction((batch: readonly PooledTweet[]) => {
      for (const tweet of batch) {
        stmt.run(toParams(tweet));
      }
    });
    insertAll(tweets);
  }

  query(query: TweetQuery): TweetPage {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const dedup = query.dedup === true;
    const { whereSql, params } = buildFilters(query);
    const rows = dedup
      ? this.queryDeduped(whereSql, params, query.cursor, limit)
      : this.queryPlain(whereSql, params, query.cursor, limit);
    const records = rows.slice(0, limit).map((row): TweetRecord => ({
      tweet: JSON.parse(row.json) as PooledTweet,
      contributors: [...new Set(row.contributors.split(","))].sort(),
    }));
    const page: TweetPage = { records };
    const lastRow = rows.length > limit ? rows[limit - 1] : undefined;
    if (lastRow !== undefined) {
      page.nextCursor = dedup
        ? encodeCursor(lastRow.sort_ts, lastRow.id)
        : encodeCursor(lastRow.sort_ts, lastRow.id, lastRow.contributed_by);
    }
    return page;
  }

  private queryPlain(
    whereSql: string,
    params: readonly unknown[],
    cursor: string | undefined,
    limit: number,
  ): TweetRow[] {
    const { cursorSql, cursorParams } = cursorClause(cursor, true);
    const sql = `
      SELECT json, sort_ts, id, contributed_by, contributed_by AS contributors
      FROM tweets
      WHERE ${whereSql} ${cursorSql}
      ORDER BY sort_ts DESC, id DESC, contributed_by DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...params, ...cursorParams, limit + 1) as TweetRow[];
  }

  private queryDeduped(
    whereSql: string,
    params: readonly unknown[],
    cursor: string | undefined,
    limit: number,
  ): TweetRow[] {
    const { cursorSql, cursorParams } = cursorClause(cursor, false);
    const sql = `
      SELECT json, sort_ts, id, '' AS contributed_by, contributors
      FROM (
        SELECT
          json, sort_ts, id,
          ROW_NUMBER() OVER (PARTITION BY id ORDER BY captured_at DESC) AS rn,
          GROUP_CONCAT(contributed_by) OVER (PARTITION BY id) AS contributors
        FROM tweets
        WHERE ${whereSql}
      )
      WHERE rn = 1 ${cursorSql}
      ORDER BY sort_ts DESC, id DESC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...params, ...cursorParams, limit + 1) as TweetRow[];
  }

  contributors(): ContributorStats[] {
    const rows = this.db
      .prepare(
        `SELECT contributed_by AS username, COUNT(*) AS tweetCount,
                MAX(pooled_at) AS lastPooledAt
         FROM tweets GROUP BY contributed_by ORDER BY tweetCount DESC`,
      )
      .all() as ContributorStats[];
    return rows;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM tweets").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

function toParams(tweet: PooledTweet): Record<string, unknown> {
  const createdAt = typeof tweet.created_at === "string" ? tweet.created_at : undefined;
  const media = tweet["media"];
  return {
    id: tweet.id,
    contributedBy: tweet.contributed_by,
    capturedAt: tweet.captured_at,
    pooledAt: tweet.pooled_at,
    sortTs: createdAt ?? tweet.captured_at,
    authorUsername: tweet.author.username.toLowerCase(),
    text: tweet.text,
    hasMedia: Array.isArray(media) && media.length > 0 ? 1 : 0,
    isArticle: tweet["is_article"] === true ? 1 : 0,
    json: JSON.stringify(tweet),
  };
}

type Filter = { sql: string; values: readonly unknown[] };

function textFilters(query: TweetQuery): Filter[] {
  const filters: Filter[] = [];
  if (query.contributors !== undefined && query.contributors.length > 0) {
    filters.push({
      sql: `contributed_by IN (${query.contributors.map(() => "?").join(",")})`,
      values: query.contributors,
    });
  }
  if (query.author !== undefined) {
    filters.push({ sql: "author_username = ?", values: [query.author.toLowerCase()] });
  }
  if (query.q !== undefined && query.q.length > 0) {
    const like = `%${query.q}%`;
    filters.push({ sql: "(text LIKE ? OR author_username LIKE ?)", values: [like, like] });
  }
  return filters;
}

function rangeAndFlagFilters(query: TweetQuery): Filter[] {
  const filters: Filter[] = [];
  if (query.since !== undefined) filters.push({ sql: "sort_ts >= ?", values: [query.since] });
  if (query.until !== undefined) filters.push({ sql: "sort_ts <= ?", values: [query.until] });
  if (query.hasMedia !== undefined) {
    filters.push({ sql: "has_media = ?", values: [query.hasMedia ? 1 : 0] });
  }
  if (query.isArticle !== undefined) {
    filters.push({ sql: "is_article = ?", values: [query.isArticle ? 1 : 0] });
  }
  return filters;
}

function buildFilters(query: TweetQuery): { whereSql: string; params: unknown[] } {
  const filters = [...textFilters(query), ...rangeAndFlagFilters(query)];
  const whereSql = ["1=1", ...filters.map((filter) => filter.sql)].join(" AND ");
  return { whereSql, params: filters.flatMap((filter) => [...filter.values]) };
}

function cursorClause(
  cursor: string | undefined,
  perContributor: boolean,
): {
  cursorSql: string;
  cursorParams: unknown[];
} {
  if (cursor === undefined) return { cursorSql: "", cursorParams: [] };
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return { cursorSql: "", cursorParams: [] };
  if (!perContributor || decoded.contributedBy === undefined) {
    return {
      cursorSql: "AND (sort_ts < ? OR (sort_ts = ? AND id < ?))",
      cursorParams: [decoded.sortTs, decoded.sortTs, decoded.id],
    };
  }
  return {
    cursorSql:
      "AND (sort_ts < ? OR (sort_ts = ? AND id < ?) OR (sort_ts = ? AND id = ? AND contributed_by < ?))",
    cursorParams: [
      decoded.sortTs,
      decoded.sortTs,
      decoded.id,
      decoded.sortTs,
      decoded.id,
      decoded.contributedBy,
    ],
  };
}
