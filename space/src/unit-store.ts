import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { EnrichedUnit, PooledTweet, UnitConcept, UnitPage } from "@xtap-pool/shared";

export type UnitQuery = {
  contributors?: readonly string[];
  author?: string;
  q?: string;
  since?: string;
  until?: string;
  hasMedia?: boolean;
  isArticle?: boolean;
  labels?: readonly string[];
  labelMode?: "any" | "all";
  freeLabel?: string;
  concept?: string;
  unlabeled?: boolean;
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
type UnitEnrichmentRow = {
  unit_id: string;
  labels: string;
  free_labels: string;
};
type UnitPostRow = { unit_id: string; json: string };
type UnitContributorsRow = { unit_id: string; contributors: string };
type UnitConceptRow = {
  unit_id: string;
  slug: string;
  name: string;
  aliases: string;
};
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

    return this.pageFromRows(rows, limit, revision);
  }

  private pageFromRows(rows: readonly OrderedUnitRow[], limit: number, revision: string): UnitPage {
    const selected = rows.slice(0, limit);
    const page: UnitPage = {
      revision,
      units: this.hydrate(selected.map((row) => row.unit_id)),
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
    const enrichments = this.db
      .prepare(
        `SELECT unit_id, labels, free_labels FROM enrichment
         WHERE taxonomy_version = ? AND unit_id IN (${placeholders})`,
      )
      .all(this.taxonomyVersion, ...unitIds) as UnitEnrichmentRow[];
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
    const concepts = this.db
      .prepare(
        `SELECT ca.unit_id, v.slug, v.name, v.aliases
         FROM concept_assignments ca
         JOIN concept_vocabulary v ON v.slug = ca.slug
         WHERE ca.unit_id IN (${placeholders}) ORDER BY ca.unit_id, v.slug`,
      )
      .all(...unitIds) as UnitConceptRow[];

    const enrichmentById = new Map(enrichments.map((row) => [row.unit_id, row]));
    const postsById = grouped(posts, (row) => row.unit_id);
    const contributorsById = new Map(
      contributors.map((row) => [
        row.unit_id,
        [...new Set(row.contributors.split(",").filter((value) => value.length > 0))].sort(),
      ]),
    );
    const conceptsById = grouped(concepts, (row) => row.unit_id);

    return unitIds.flatMap((unitId): EnrichedUnit[] => {
      const enrichment = enrichmentById.get(unitId);
      if (enrichment === undefined) return [];
      return [
        {
          id: unitId,
          posts: (postsById.get(unitId) ?? []).map((row) => JSON.parse(row.json) as PooledTweet),
          contributors: contributorsById.get(unitId) ?? [],
          preset_labels: parseStringArray(enrichment.labels),
          free_labels: parseStringArray(enrichment.free_labels),
          concepts: (conceptsById.get(unitId) ?? []).map((row): UnitConcept => ({
            slug: row.slug,
            name: row.name,
            aliases: parseStringArray(row.aliases),
          })),
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
    "tweet_labels",
    "concept_vocabulary",
    "concept_assignments",
    "concept_edges",
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
    ...conceptFilters(query),
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
  return filters;
}

function labelFilters(query: UnitQuery): Filter[] {
  const filters = presetLabelFilters(query);
  if (query.unlabeled === true) {
    filters.push({
      sql: "tweets.id NOT IN (SELECT tweet_id FROM tweet_labels WHERE kind = 'preset')",
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
        sql: `tweets.id IN (SELECT tweet_id FROM tweet_labels
              WHERE kind = 'preset' AND label IN (${labels.map(() => "?").join(",")}))`,
        values: labels,
      },
    ];
  }
  return labels.map((label) => ({
    sql: `EXISTS (SELECT 1 FROM tweet_labels tl
          WHERE tl.tweet_id = tweets.id AND tl.kind = 'preset' AND tl.label = ?)`,
    values: [label],
  }));
}

function conceptFilters(query: UnitQuery): Filter[] {
  const filters: Filter[] = [];
  if (query.freeLabel !== undefined) {
    filters.push({
      sql: "tweets.id IN (SELECT tweet_id FROM tweet_labels WHERE kind = 'free' AND label = ?)",
      values: [query.freeLabel],
    });
  }
  if (query.concept !== undefined) {
    filters.push({
      sql: `um.unit_id IN (SELECT unit_id FROM concept_assignments WHERE slug = ?)`,
      values: [query.concept],
    });
  }
  return filters;
}

function parseStringArray(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("invalid string-array value in enrichment index");
  }
  return [...new Set(parsed)].sort();
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
