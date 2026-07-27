import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { EnrichedUnit, LabelAssignment, PooledTweet, UnitPage } from "@xtap-pool/shared";

import { readVisibleAssignments } from "./label-visibility.js";

export type UnitQuery = {
  contributors?: readonly string[];
  author?: string;
  authorIds?: readonly string[];
  q?: string;
  since?: string;
  until?: string;
  hasMedia?: boolean;
  isArticle?: boolean;
  labels?: readonly string[];
  labelMode?: "any" | "all";
  freeLabel?: string;
  unlabeled?: boolean;
  publication?: "public-original";
  /**
   * Shared activity cutoff: only units whose latest capture is at or before
   * this timestamp participate. Consumers pass `complete_through` here so
   * the whole snapshot describes one closed window.
   */
  cutoff?: string;
  limit?: number;
  cursor?: string;
};

export class InvalidUnitCursorError extends Error {}
export class StaleUnitRevisionError extends Error {
  constructor(
    readonly requested: string,
    readonly current: string,
  ) {
    super("the unit result changed during pagination; restart from the first page");
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type OrderedUnitRow = { unit_id: string; sort_ts: string };
type UnitPostRow = { unit_id: string; json: string };
type UnitContributorsRow = { unit_id: string; contributors: string };
type UnitCursor = { revision: string; sortTs: string; unitId: string };
type Filter = { sql: string; values: readonly unknown[] };

/**
 * Revision-consistent, unit-oriented read model over the tweet and enrichment
 * cache. A boot epoch invalidates cursors across restarts; SQLite triggers
 * advance the counter whenever a field visible through this API changes.
 */
export class UnitStore {
  private readonly epoch = randomUUID();

  constructor(
    private readonly db: Database.Database,
    private readonly taxonomyVersion: number,
  ) {
    ensureResultRevision(db);
  }

  currentRevision(): string {
    const row = this.db
      .prepare("SELECT revision FROM result_revision WHERE singleton = 1")
      .get() as { revision: number };
    return `${this.epoch}:${String(row.revision)}`;
  }

  assertRevision(requested: string | undefined): string {
    const current = this.currentRevision();
    if (requested !== undefined && requested !== current) {
      throw new StaleUnitRevisionError(requested, current);
    }
    return current;
  }

  query(query: UnitQuery): UnitPage {
    const revision = this.currentRevision();
    const cursor = requestedCursor(query.cursor, revision);
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const { whereSql, params } = buildFilters(query);
    const { sql: cursorSql, params: cursorParams } = unitCursorClause(cursor);
    const rows = this.db
      .prepare(
        `WITH eligible AS (
           SELECT DISTINCT um.unit_id
           FROM tweets
           JOIN unit_members um ON um.tweet_id = tweets.id
           JOIN enrichment e ON e.unit_id = um.unit_id AND e.taxonomy_version = ?
           JOIN enrich_queue q ON q.unit_id = um.unit_id
             AND q.taxonomy_version = ? AND q.status = 'done'
           WHERE ${whereSql}
         ), ordered AS (
           SELECT um.unit_id, MAX(tweets.sort_ts) AS sort_ts
           FROM eligible
           JOIN unit_members um ON um.unit_id = eligible.unit_id
           JOIN tweets ON tweets.id = um.tweet_id
           GROUP BY um.unit_id
         )
         SELECT unit_id, sort_ts FROM ordered
         ${cursorSql}
         ORDER BY sort_ts DESC, unit_id DESC
         LIMIT ?`,
      )
      .all(
        this.taxonomyVersion,
        this.taxonomyVersion,
        ...params,
        ...cursorParams,
        limit + 1,
      ) as OrderedUnitRow[];

    return this.pageFromRows(rows, limit, revision, query.cutoff);
  }

  private pageFromRows(
    rows: readonly OrderedUnitRow[],
    limit: number,
    revision: string,
    cutoff: string | undefined,
  ): UnitPage {
    const selected = rows.slice(0, limit);
    const page: UnitPage = {
      revision,
      units: this.hydrate(selected.map((row) => row.unit_id)),
      ...(cutoff === undefined ? {} : { cutoff }),
    };
    const last = rows.length > limit ? selected[selected.length - 1] : undefined;
    if (last !== undefined) {
      page.next_cursor = encodeUnitCursor(revision, last.sort_ts, last.unit_id);
    }
    return page;
  }

  private hydrate(unitIds: readonly string[]): EnrichedUnit[] {
    if (unitIds.length === 0) return [];
    const placeholders = unitIds.map(() => "?").join(",");
    const posts = this.db
      .prepare(
        `WITH ranked AS (
           SELECT um.unit_id, tweets.json, tweets.sort_ts, tweets.id,
                  ROW_NUMBER() OVER (
                    PARTITION BY tweets.id ORDER BY tweets.captured_at DESC, tweets.contributed_by
                  ) AS rn
           FROM unit_members um
           JOIN tweets ON tweets.id = um.tweet_id
           WHERE um.unit_id IN (${placeholders})
         )
         SELECT unit_id, json FROM ranked WHERE rn = 1
         ORDER BY unit_id, sort_ts, id`,
      )
      .all(...unitIds) as UnitPostRow[];
    const contributors = this.db
      .prepare(
        `SELECT um.unit_id, GROUP_CONCAT(DISTINCT tweets.contributed_by) AS contributors
         FROM unit_members um JOIN tweets ON tweets.id = um.tweet_id
         WHERE um.unit_id IN (${placeholders}) GROUP BY um.unit_id`,
      )
      .all(...unitIds) as UnitContributorsRow[];
    const assignments = readVisibleAssignments(this.db, unitIds);
    const postsById = grouped(posts, (row) => row.unit_id);
    const contributorsById = new Map(
      contributors.map((row) => [
        row.unit_id,
        [...new Set(row.contributors.split(",").filter((value) => value.length > 0))].sort(),
      ]),
    );

    return unitIds.flatMap((unitId): EnrichedUnit[] => {
      const bucket = assignments.get(unitId) ?? {
        preset_labels: [] as LabelAssignment[],
        free_labels: [] as LabelAssignment[],
      };
      return [
        {
          id: unitId,
          posts: (postsById.get(unitId) ?? []).map((row) => JSON.parse(row.json) as PooledTweet),
          contributors: contributorsById.get(unitId) ?? [],
          preset_labels: bucket.preset_labels,
          free_labels: bucket.free_labels,
        },
      ];
    });
  }
}

export function encodeUnitCursor(revision: string, sortTs: string, unitId: string): string {
  return Buffer.from(JSON.stringify([revision, sortTs, unitId])).toString("base64url");
}

export function decodeUnitCursor(cursor: string): UnitCursor | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(candidate) ||
    candidate.length !== 3 ||
    !candidate.every((part) => typeof part === "string" && part.length > 0)
  ) {
    return undefined;
  }
  const [revision, sortTs, unitId] = candidate as [string, string, string];
  return { revision, sortTs, unitId };
}

function requestedCursor(raw: string | undefined, revision: string): UnitCursor | undefined {
  if (raw === undefined) return undefined;
  const cursor = decodeUnitCursor(raw);
  if (cursor === undefined) throw new InvalidUnitCursorError("invalid unit cursor");
  if (cursor.revision !== revision) {
    throw new StaleUnitRevisionError(cursor.revision, revision);
  }
  return cursor;
}

function unitCursorClause(cursor: UnitCursor | undefined): { sql: string; params: string[] } {
  if (cursor === undefined) return { sql: "", params: [] };
  return {
    sql: "WHERE sort_ts < ? OR (sort_ts = ? AND unit_id < ?)",
    params: [cursor.sortTs, cursor.sortTs, cursor.unitId],
  };
}

function ensureResultRevision(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS result_revision (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO result_revision (singleton, revision) VALUES (1, 0);
  `);
  for (const table of [
    "tweets",
    "unit_members",
    "enrichment",
    "enrich_queue",
    "label_assignments",
    "label_evidence",
    "free_label_registry",
  ]) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const suffix = operation.toLowerCase();
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS result_revision_${table}_${suffix}
        AFTER ${operation} ON ${table}
        BEGIN
          UPDATE result_revision SET revision = revision + 1 WHERE singleton = 1;
        END;
      `);
    }
  }
}

function buildFilters(query: UnitQuery): { whereSql: string; params: unknown[] } {
  const filters = [
    ...identityFilters(query),
    ...rangeFilters(query),
    ...labelFilters(query),
    ...freeLabelFilters(query),
    ...publicationFilters(query),
  ];
  return {
    whereSql: ["1=1", ...filters.map((filter) => filter.sql)].join(" AND "),
    params: filters.flatMap((filter) => [...filter.values]),
  };
}

function identityFilters(query: UnitQuery): Filter[] {
  const filters: Filter[] = [];
  if (query.contributors !== undefined && query.contributors.length > 0) {
    filters.push({
      sql: `tweets.contributed_by IN (${query.contributors.map(() => "?").join(",")})`,
      values: query.contributors,
    });
  }
  if (query.author !== undefined) {
    filters.push({ sql: "tweets.author_username = ?", values: [query.author.toLowerCase()] });
  }
  if (query.authorIds !== undefined && query.authorIds.length > 0) {
    const placeholders = query.authorIds.map(() => "?").join(",");
    filters.push({
      sql: `NOT EXISTS (
              SELECT 1 FROM unit_members author_um
              JOIN tweets author_tweet ON author_tweet.id = author_um.tweet_id
              WHERE author_um.unit_id = um.unit_id
                AND (
                  json_extract(author_tweet.json, '$.author.id') IS NULL
                  OR json_extract(author_tweet.json, '$.author.id') NOT IN (${placeholders})
                )
            )`,
      values: query.authorIds,
    });
  }
  if (query.q !== undefined && query.q.length > 0) {
    filters.push({
      sql: "(tweets.text LIKE ? OR tweets.author_username LIKE ?)",
      values: [`%${query.q}%`, `%${query.q}%`],
    });
  }
  return filters;
}

function rangeFilters(query: UnitQuery): Filter[] {
  const filters: Filter[] = [];
  if (query.since !== undefined)
    filters.push({ sql: "tweets.sort_ts >= ?", values: [query.since] });
  if (query.until !== undefined)
    filters.push({ sql: "tweets.sort_ts <= ?", values: [query.until] });
  if (query.hasMedia !== undefined) {
    filters.push({ sql: "tweets.has_media = ?", values: [query.hasMedia ? 1 : 0] });
  }
  if (query.isArticle !== undefined) {
    filters.push({ sql: "tweets.is_article = ?", values: [query.isArticle ? 1 : 0] });
  }
  if (query.cutoff !== undefined) {
    filters.push({
      sql: `(SELECT MAX(t.captured_at) FROM tweets t
             JOIN unit_members u ON u.tweet_id = t.id
             WHERE u.unit_id = um.unit_id) <= ?`,
      values: [query.cutoff],
    });
  }
  return filters;
}

function labelFilters(query: UnitQuery): Filter[] {
  const filters = presetLabelFilters(query);
  if (query.unlabeled === true) {
    filters.push({
      sql: `um.unit_id NOT IN (SELECT unit_id FROM label_assignments WHERE kind = 'preset')`,
      values: [],
    });
  }
  return filters;
}

function presetLabelFilters(query: UnitQuery): Filter[] {
  const labels = query.labels;
  if (labels === undefined || labels.length === 0) return [];
  if (query.labelMode !== "all") {
    return [
      {
        sql: `um.unit_id IN (SELECT unit_id FROM label_assignments
              WHERE kind = 'preset' AND name IN (${labels.map(() => "?").join(",")}))`,
        values: labels,
      },
    ];
  }
  return labels.map((label) => ({
    sql: `EXISTS (SELECT 1 FROM label_assignments la
          WHERE la.unit_id = um.unit_id AND la.kind = 'preset' AND la.name = ?)`,
    values: [label],
  }));
}

function freeLabelFilters(query: UnitQuery): Filter[] {
  const filters: Filter[] = [];
  if (query.freeLabel !== undefined) {
    filters.push({
      sql: `um.unit_id IN (
              SELECT a.unit_id FROM label_assignments a
              JOIN free_label_registry r ON r.name = a.name AND r.status = 'approved'
              WHERE a.kind = 'free' AND a.name = ?
            )`,
      values: [query.freeLabel],
    });
  }
  return filters;
}

function publicationFilters(query: UnitQuery): Filter[] {
  if (query.publication !== "public-original") return [];
  return [
    {
      sql: `NOT EXISTS (
              SELECT 1 FROM unit_members private_um
              JOIN tweets private_tweet ON private_tweet.id = private_um.tweet_id
              WHERE private_um.unit_id = um.unit_id
                AND json_extract(private_tweet.json, '$.is_subscriber_only') = 1
            )
            AND EXISTS (
              SELECT 1 FROM unit_members original_um
              JOIN tweets original_tweet ON original_tweet.id = original_um.tweet_id
              WHERE original_um.unit_id = um.unit_id
                AND COALESCE(json_extract(original_tweet.json, '$.is_retweet'), 0) != 1
            )`,
      values: [],
    },
  ];
}

function grouped<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const bucket = result.get(groupKey);
    if (bucket === undefined) result.set(groupKey, [row]);
    else bucket.push(row);
  }
  return result;
}
