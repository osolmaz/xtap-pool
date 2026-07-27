import type Database from "better-sqlite3";

import { mergeConceptEntry, slugifyConcept, unitIdFor } from "@xtap-pool/shared";
import type {
  Concept,
  ConceptCount,
  ConceptGraph,
  ConceptSummary,
  EnrichmentRow,
  FreeLabelCount,
  GraphLink,
  GraphNode,
  LabelConfig,
  LabelsSummary,
  PooledTweet,
  QueueDepth,
  RelatedConcept,
  VocabularyEntry,
} from "@xtap-pool/shared";

/** Queue entries are retried this many times before landing in `failed`. */
export const MAX_ATTEMPTS = 3;

const FREE_LABEL_LIMIT = 50;
const RELATED_LIMIT = 50;

export type QueueItem = {
  unitId: string;
  tweetIds: readonly string[];
  attempts: number;
};

type VocabularyRow = { slug: string; name: string; aliases: string; unit_count: number };

/**
 * Enrichment tables live beside the tweet index in the same database so label
 * and concept filters compose with tweet queries in one SQL statement. Like
 * the tweet tables, everything here is a cache rebuilt from the dataset.
 */
export function ensureEnrichmentTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_members (
      tweet_id TEXT PRIMARY KEY,
      unit_id TEXT NOT NULL,
      captured_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_unit_members_unit ON unit_members(unit_id, tweet_id);
    CREATE TABLE IF NOT EXISTS enrich_queue (
      unit_id TEXT PRIMARY KEY,
      tweet_ids TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      taxonomy_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_enrich_queue_status
      ON enrich_queue(status, updated_at, unit_id);
    CREATE TABLE IF NOT EXISTS enrichment (
      unit_id TEXT NOT NULL,
      taxonomy_version INTEGER NOT NULL,
      tweet_ids TEXT NOT NULL,
      labels TEXT NOT NULL,
      free_labels TEXT NOT NULL,
      concepts TEXT NOT NULL,
      model TEXT NOT NULL,
      enriched_at TEXT NOT NULL,
      PRIMARY KEY (unit_id)
    );
    CREATE TABLE IF NOT EXISTS tweet_labels (
      tweet_id TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (tweet_id, label, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_tweet_labels_label ON tweet_labels(kind, label, tweet_id);
    CREATE TABLE IF NOT EXISTS concept_vocabulary (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      aliases TEXT NOT NULL,
      unit_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS concept_assignments (
      unit_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      PRIMARY KEY (unit_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_concept_assignments_slug
      ON concept_assignments(slug, unit_id);
    CREATE TABLE IF NOT EXISTS concept_edges (
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      weight INTEGER NOT NULL,
      PRIMARY KEY (a, b)
    );
      CREATE INDEX IF NOT EXISTS idx_concept_edges_b ON concept_edges(b);
  `);
}

/** SQLite layer for the enrichment pipeline: queue, labels, concepts, edges. */
export class EnrichStore {
  constructor(
    private readonly db: Database.Database,
    private readonly taxonomyVersion: number,
    private readonly now: () => Date = (): Date => new Date(),
  ) {
    ensureEnrichmentTables(db);
  }

  /** Clear all derived enrichment state before replaying a complete dataset snapshot. */
  clearForRebuild(): void {
    const clear = this.db.transaction(() => {
      for (const table of [
        "tweet_labels",
        "concept_assignments",
        "concept_edges",
        "enrichment",
        "enrich_queue",
        "unit_members",
        "concept_vocabulary",
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
    });
    clear();
  }

  /**
   * Record unit membership for ingested tweets and enqueue affected units.
   * A unit is (re-)enqueued when a tweet newly joins it — including tweets
   * joining an already-enriched unit — or when a known tweet is re-captured
   * for a unit that has neither a current enrichment nor a queue entry.
   */
  registerTweets(tweets: readonly PooledTweet[]): string[] {
    const register = this.db.transaction((batch: readonly PooledTweet[]): string[] => {
      const toEnqueue = new Set<string>();
      for (const tweet of batch) {
        const unitId = unitIdFor(tweet);
        const result = this.registerMembership(tweet, unitId);
        if (result.enqueue) toEnqueue.add(unitId);
        if (result.previousUnitId !== undefined) {
          // a tweet moved between units (e.g. a later capture supplied its
          // conversation_id): the old unit's enrichment is now stale
          this.clearUnitEnrichment(result.previousUnitId);
          if (this.unitMemberIds(result.previousUnitId).length > 0) {
            toEnqueue.add(result.previousUnitId);
          }
        }
      }
      // a batch can empty a unit after it was marked for enqueueing
      for (const unitId of [...toEnqueue]) {
        if (this.unitMemberIds(unitId).length === 0) {
          toEnqueue.delete(unitId);
          this.clearUnitEnrichment(unitId);
        }
      }
      for (const unitId of toEnqueue) this.enqueueUnit(unitId);
      return [...toEnqueue].sort();
    });
    return register(tweets);
  }

  private registerMembership(
    tweet: PooledTweet,
    unitId: string,
  ): { enqueue: boolean; previousUnitId?: string } {
    const tweetId = tweet.id;
    const capturedAt = tweet.captured_at;
    const existing = this.db
      .prepare("SELECT unit_id, captured_at FROM unit_members WHERE tweet_id = ?")
      .get(tweetId) as { unit_id: string; captured_at: string } | undefined;
    if (existing === undefined) {
      this.db
        .prepare("INSERT INTO unit_members (tweet_id, unit_id, captured_at) VALUES (?, ?, ?)")
        .run(tweetId, unitId, capturedAt);
      return { enqueue: true };
    }
    // rebuilds replay historical copies in arbitrary order: only a fresher
    // capture may change a tweet's unit
    if (existing.captured_at > capturedAt) return { enqueue: false };
    if (existing.unit_id !== unitId) {
      this.db
        .prepare("UPDATE unit_members SET unit_id = ?, captured_at = ? WHERE tweet_id = ?")
        .run(unitId, capturedAt, tweetId);
      return { enqueue: true, previousUnitId: existing.unit_id };
    }
    this.db
      .prepare("UPDATE unit_members SET captured_at = ? WHERE tweet_id = ?")
      .run(capturedAt, tweetId);
    return {
      enqueue: !this.hasCurrentEnrichment(unitId) && !this.hasQueueEntry(unitId),
    };
  }

  /** Remove a unit's indexed enrichment (labels, concepts, edges, row, queue). */
  private clearUnitEnrichment(unitId: string): void {
    const removeLabel = this.db.prepare("DELETE FROM tweet_labels WHERE tweet_id = ?");
    for (const tweetId of this.previousTweetIds(unitId)) removeLabel.run(tweetId);
    const slugs = this.assignedSlugs(unitId);
    this.adjustEdges(slugs, -1);
    this.adjustUnitCounts(slugs, -1);
    this.db.prepare("DELETE FROM concept_assignments WHERE unit_id = ?").run(unitId);
    this.db.prepare("DELETE FROM concept_edges WHERE weight <= 0").run();
    this.db.prepare("DELETE FROM enrichment WHERE unit_id = ?").run(unitId);
    this.db.prepare("DELETE FROM enrich_queue WHERE unit_id = ?").run(unitId);
  }

  private hasCurrentEnrichment(unitId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM enrichment WHERE unit_id = ? AND taxonomy_version = ?")
      .get(unitId, this.taxonomyVersion);
    return row !== undefined;
  }

  private hasQueueEntry(unitId: string): boolean {
    // Queue work is keyed (unit, taxonomy_version): rows from another
    // taxonomy never block re-enqueueing under the current one.
    const row = this.db
      .prepare("SELECT 1 AS x FROM enrich_queue WHERE unit_id = ? AND taxonomy_version = ?")
      .get(unitId, this.taxonomyVersion);
    return row !== undefined;
  }

  private enqueueUnit(unitId: string): void {
    this.db
      .prepare(
        `INSERT INTO enrich_queue
           (unit_id, tweet_ids, status, attempts, last_error, taxonomy_version, updated_at)
         VALUES (?, ?, 'queued', 0, NULL, ?, ?)
         ON CONFLICT (unit_id) DO UPDATE SET
           tweet_ids = excluded.tweet_ids,
           status = 'queued',
           attempts = 0,
           last_error = NULL,
           taxonomy_version = excluded.taxonomy_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        unitId,
        JSON.stringify(this.unitMemberIds(unitId)),
        this.taxonomyVersion,
        this.now().toISOString(),
      );
  }

  /** Tweet ids currently belonging to a unit, sorted for determinism. */
  unitMemberIds(unitId: string): string[] {
    const rows = this.db
      .prepare("SELECT tweet_id FROM unit_members WHERE unit_id = ? ORDER BY tweet_id")
      .all(unitId) as { tweet_id: string }[];
    return rows.map((row) => row.tweet_id);
  }

  /** The unit's tweet texts, oldest first, joined and truncated for prompting. */
  unitText(unitId: string, maxChars: number): string {
    const rows = this.db
      .prepare(
        `SELECT text FROM (
           SELECT id, sort_ts AS ts, text,
                  ROW_NUMBER() OVER (PARTITION BY id ORDER BY captured_at DESC) AS rn
           FROM tweets
           WHERE id IN (SELECT tweet_id FROM unit_members WHERE unit_id = ?)
         ) WHERE rn = 1 ORDER BY ts, id`,
      )
      .all(unitId) as { text: string }[];
    return rows
      .map((row) => row.text)
      .join("\n\n")
      .slice(0, maxChars);
  }

  /** Oldest queued units first, up to `limit`. */
  claimQueued(limit: number): QueueItem[] {
    // atomically flip queued -> claimed so overlapping drains (interval
    // tick vs manual /api/enrich/run) never pay the router twice for the
    // same unit; settle/markFailed release the claim
    const rows = this.db
      .prepare(
        `UPDATE enrich_queue SET status = 'claimed', updated_at = ?
         WHERE unit_id IN (
           SELECT unit_id FROM enrich_queue
           WHERE status = 'queued' ORDER BY updated_at, unit_id LIMIT ?
         )
         RETURNING unit_id, tweet_ids, attempts`,
      )
      .all(this.now().toISOString(), limit) as {
      unit_id: string;
      tweet_ids: string;
      attempts: number;
    }[];
    return rows.map((row) => ({
      unitId: row.unit_id,
      tweetIds: JSON.parse(row.tweet_ids) as string[],
      attempts: row.attempts,
    }));
  }

  /** Recover claims left behind by an interrupted process (boot only). */
  releaseClaims(): void {
    this.db.prepare("UPDATE enrich_queue SET status = 'queued' WHERE status = 'claimed'").run();
  }

  /** Count one failed attempt; the unit stays queued until MAX_ATTEMPTS. */
  markFailed(unitId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE enrich_queue SET
           attempts = attempts + 1,
           last_error = ?,
           status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'queued' END,
           updated_at = ?
         WHERE unit_id = ?`,
      )
      .run(error, MAX_ATTEMPTS, this.now().toISOString(), unitId);
  }

  /** Queue row for one unit (tests and diagnostics). */
  queueEntry(
    unitId: string,
  ): { status: string; attempts: number; lastError: string | null } | undefined {
    const row = this.db
      .prepare("SELECT status, attempts, last_error FROM enrich_queue WHERE unit_id = ?")
      .get(unitId) as { status: string; attempts: number; last_error: string | null } | undefined;
    if (row === undefined) return undefined;
    return { status: row.status, attempts: row.attempts, lastError: row.last_error };
  }

  /**
   * Upsert one enrichment result: rewrite the unit's tweet labels, concept
   * assignments, vocabulary counts and co-occurrence edges, then settle the
   * queue entry when the row covers the unit's current membership.
   */
  applyEnrichment(row: EnrichmentRow): void {
    const apply = this.db.transaction((enrichment: EnrichmentRow) => {
      if (this.unitMemberIds(enrichment.unit_id).length === 0) {
        // append-only shards can replay rows for units whose members all
        // moved away; applying them would resurrect orphaned concepts
        this.clearUnitEnrichment(enrichment.unit_id);
        return;
      }
      // preset labels are defined by the taxonomy: rows from an older
      // taxonomy version keep their concepts and free labels (which are
      // taxonomy-independent) but must not serve stale preset labels
      const stale = enrichment.taxonomy_version !== this.taxonomyVersion;
      this.rewriteTweetLabels(stale ? { ...enrichment, labels: [] } : enrichment);
      this.rewriteConcepts(enrichment);
      this.upsertEnrichmentRow(enrichment);
      this.settleQueue(enrichment);
    });
    apply(row);
  }

  private previousTweetIds(unitId: string): string[] {
    const row = this.db
      .prepare("SELECT tweet_ids FROM enrichment WHERE unit_id = ?")
      .get(unitId) as { tweet_ids: string } | undefined;
    return row === undefined ? [] : (JSON.parse(row.tweet_ids) as string[]);
  }

  private rewriteTweetLabels(row: EnrichmentRow): void {
    const remove = this.db.prepare("DELETE FROM tweet_labels WHERE tweet_id = ?");
    for (const tweetId of new Set([...this.previousTweetIds(row.unit_id), ...row.tweet_ids])) {
      remove.run(tweetId);
    }
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO tweet_labels (tweet_id, label, kind) VALUES (?, ?, ?)",
    );
    for (const tweetId of row.tweet_ids) {
      for (const label of row.labels) insert.run(tweetId, label, "preset");
      for (const label of row.free_labels) insert.run(tweetId, label, "free");
    }
  }

  private rewriteConcepts(row: EnrichmentRow): void {
    const oldSlugs = this.assignedSlugs(row.unit_id);
    this.adjustEdges(oldSlugs, -1);
    this.adjustUnitCounts(oldSlugs, -1);
    this.db.prepare("DELETE FROM concept_assignments WHERE unit_id = ?").run(row.unit_id);
    const newSlugs = this.mergeConcepts(row.concepts);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO concept_assignments (unit_id, slug) VALUES (?, ?)",
    );
    for (const slug of newSlugs) insert.run(row.unit_id, slug);
    this.adjustUnitCounts(newSlugs, 1);
    this.adjustEdges(newSlugs, 1);
    this.db.prepare("DELETE FROM concept_edges WHERE weight <= 0").run();
  }

  private assignedSlugs(unitId: string): string[] {
    const rows = this.db
      .prepare("SELECT slug FROM concept_assignments WHERE unit_id = ? ORDER BY slug")
      .all(unitId) as { slug: string }[];
    return rows.map((row) => row.slug);
  }

  private mergeConcepts(concepts: readonly Concept[]): string[] {
    const slugs = new Set<string>();
    for (const concept of concepts) {
      const slug = slugifyConcept(concept.name);
      if (slug.length === 0 || slugs.has(slug)) continue;
      slugs.add(slug);
      this.mergeVocabularyEntry(slug, concept);
    }
    return [...slugs].sort();
  }

  private mergeVocabularyEntry(slug: string, concept: Concept): void {
    const existing = this.db
      .prepare("SELECT name, aliases FROM concept_vocabulary WHERE slug = ?")
      .get(slug) as { name: string; aliases: string } | undefined;
    const merged = mergeConceptEntry(
      existing === undefined
        ? undefined
        : { name: existing.name, aliases: JSON.parse(existing.aliases) as string[] },
      concept,
    );
    this.db
      .prepare(
        `INSERT INTO concept_vocabulary (slug, name, aliases, unit_count) VALUES (?, ?, ?, 0)
         ON CONFLICT (slug) DO UPDATE SET name = excluded.name, aliases = excluded.aliases`,
      )
      .run(slug, merged.name, JSON.stringify(merged.aliases));
  }

  private adjustUnitCounts(slugs: readonly string[], delta: number): void {
    const update = this.db.prepare(
      "UPDATE concept_vocabulary SET unit_count = MAX(0, unit_count + ?) WHERE slug = ?",
    );
    for (const slug of slugs) update.run(delta, slug);
  }

  private adjustEdges(slugs: readonly string[], delta: number): void {
    const sorted = [...new Set(slugs)].sort();
    const increment = this.db.prepare(
      `INSERT INTO concept_edges (a, b, weight) VALUES (?, ?, 1)
       ON CONFLICT (a, b) DO UPDATE SET weight = weight + 1`,
    );
    const decrement = this.db.prepare(
      "UPDATE concept_edges SET weight = weight - 1 WHERE a = ? AND b = ?",
    );
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        if (delta > 0) increment.run(sorted[i], sorted[j]);
        else decrement.run(sorted[i], sorted[j]);
      }
    }
  }

  private upsertEnrichmentRow(row: EnrichmentRow): void {
    this.db
      .prepare(
        `INSERT INTO enrichment
           (unit_id, taxonomy_version, tweet_ids, labels, free_labels, concepts, model, enriched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (unit_id) DO UPDATE SET
           taxonomy_version = excluded.taxonomy_version,
           tweet_ids = excluded.tweet_ids,
           labels = excluded.labels,
           free_labels = excluded.free_labels,
           concepts = excluded.concepts,
           model = excluded.model,
           enriched_at = excluded.enriched_at`,
      )
      .run(
        row.unit_id,
        row.taxonomy_version,
        JSON.stringify(row.tweet_ids),
        JSON.stringify(row.labels),
        JSON.stringify(row.free_labels),
        JSON.stringify(row.concepts),
        row.model,
        row.enriched_at,
      );
  }

  private settleQueue(row: EnrichmentRow): void {
    if (row.taxonomy_version !== this.taxonomyVersion) return;
    const covered = new Set(row.tweet_ids);
    if (!this.unitMemberIds(row.unit_id).every((id) => covered.has(id))) return;
    this.db
      .prepare(
        `INSERT INTO enrich_queue
           (unit_id, tweet_ids, status, attempts, last_error, taxonomy_version, updated_at)
         VALUES (?, ?, 'done', 0, NULL, ?, ?)
         ON CONFLICT (unit_id) DO UPDATE SET
           status = 'done',
           last_error = NULL,
           taxonomy_version = excluded.taxonomy_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.unit_id,
        JSON.stringify(row.tweet_ids),
        row.taxonomy_version,
        this.now().toISOString(),
      );
  }

  /** Seed vocabulary names and aliases from the dataset's vocabulary.json. */
  seedVocabulary(entries: readonly VocabularyEntry[]): void {
    const seed = this.db.transaction((batch: readonly VocabularyEntry[]) => {
      for (const entry of batch) {
        this.mergeVocabularyEntry(entry.slug, { name: entry.name, aliases: [...entry.aliases] });
      }
    });
    seed(entries);
  }

  /** Full vocabulary with unit counts, most-used first. */
  vocabularyEntries(): ConceptCount[] {
    const rows = this.db
      .prepare(
        "SELECT slug, name, aliases, unit_count FROM concept_vocabulary ORDER BY unit_count DESC, slug",
      )
      .all() as VocabularyRow[];
    return rows.map(toConceptCount);
  }

  /** `GET /api/labels` domain logic: taxonomy counts, free labels, queue, coverage. */
  labelsSummary(taxonomy: readonly LabelConfig[]): Omit<LabelsSummary, "revision"> {
    const eligible = eligibleUnits({ taxonomyVersion: this.taxonomyVersion });
    const presetRows = this.db
      .prepare(
        `SELECT tl.label, COUNT(*) AS n FROM tweet_labels tl
         JOIN unit_members um ON um.tweet_id = tl.tweet_id
         WHERE tl.kind = 'preset' AND um.unit_id IN (${eligible.sql}) GROUP BY tl.label`,
      )
      .all(...eligible.params) as { label: string; n: number }[];
    const presetCounts = new Map(presetRows.map((row) => [row.label, row.n]));
    const freeLabels = this.db
      .prepare(
        `SELECT tl.label AS name, COUNT(*) AS count FROM tweet_labels tl
         JOIN unit_members um ON um.tweet_id = tl.tweet_id
         WHERE tl.kind = 'free' AND um.unit_id IN (${eligible.sql})
         GROUP BY tl.label ORDER BY count DESC, tl.label LIMIT ?`,
      )
      .all(...eligible.params, FREE_LABEL_LIMIT) as FreeLabelCount[];
    return {
      taxonomy_version: this.taxonomyVersion,
      labels: taxonomy.map((label) => ({ ...label, count: presetCounts.get(label.name) ?? 0 })),
      free_labels: freeLabels,
      queue: this.queueDepth(),
      coverage: this.coverage(),
    };
  }

  private queueDepth(): QueueDepth {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM enrich_queue GROUP BY status")
      .all() as { status: string; n: number }[];
    const byStatus = new Map(rows.map((row) => [row.status, row.n]));
    return {
      queued: byStatus.get("queued") ?? 0,
      failed: byStatus.get("failed") ?? 0,
      done: byStatus.get("done") ?? 0,
    };
  }

  private coverage(): { units_total: number; units_enriched: number } {
    const total = this.db
      .prepare("SELECT COUNT(DISTINCT unit_id) AS n FROM unit_members")
      .get() as { n: number };
    const enriched = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM enrichment e
         JOIN enrich_queue q ON q.unit_id = e.unit_id
           AND q.taxonomy_version = e.taxonomy_version AND q.status = 'done'
         WHERE e.taxonomy_version = ?`,
      )
      .get(this.taxonomyVersion) as { n: number };
    return { units_total: total.n, units_enriched: enriched.n };
  }

  /** `GET /api/concepts` domain logic: vocabulary sorted by finalized-unit usage. */
  concepts(options: UnitSelection = {}): ConceptCount[] {
    const eligible = eligibleUnits({ ...options, taxonomyVersion: this.taxonomyVersion });
    const filtered = hasSelectionFilter(options);
    const rows = this.db
      .prepare(
        `SELECT v.slug, v.name, v.aliases, COUNT(DISTINCT ca.unit_id) AS unit_count
         FROM concept_vocabulary v
         LEFT JOIN concept_assignments ca ON ca.slug = v.slug
           AND ca.unit_id IN (${eligible.sql})
         GROUP BY v.slug ${filtered ? "HAVING COUNT(DISTINCT ca.unit_id) > 0" : ""}
         ORDER BY unit_count DESC, v.name COLLATE NOCASE, v.slug`,
      )
      .all(...eligible.params) as VocabularyRow[];
    return rows.map(toConceptCount);
  }

  /** `GET /api/concepts/:slug` domain logic; undefined for unknown or filtered slugs. */
  concept(slug: string, options: UnitSelection = {}): Omit<ConceptSummary, "revision"> | undefined {
    const eligible = eligibleUnits({ ...options, taxonomyVersion: this.taxonomyVersion });
    const row = this.db
      .prepare(
        `SELECT v.slug, v.name, v.aliases, COUNT(DISTINCT ca.unit_id) AS unit_count
         FROM concept_vocabulary v
         LEFT JOIN concept_assignments ca ON ca.slug = v.slug
           AND ca.unit_id IN (${eligible.sql})
         WHERE v.slug = ? GROUP BY v.slug`,
      )
      .get(...eligible.params, slug) as VocabularyRow | undefined;
    if (row === undefined || (hasSelectionFilter(options) && row.unit_count === 0))
      return undefined;
    const related = this.db
      .prepare(
        `SELECT b.slug, v.name, COUNT(DISTINCT a.unit_id) AS shared_units
         FROM concept_assignments a
         JOIN concept_assignments b ON b.unit_id = a.unit_id AND b.slug != a.slug
         JOIN concept_vocabulary v ON v.slug = b.slug
         WHERE a.slug = ? AND a.unit_id IN (${eligible.sql})
         GROUP BY b.slug ORDER BY shared_units DESC, b.slug LIMIT ?`,
      )
      .all(slug, ...eligible.params, RELATED_LIMIT) as RelatedConcept[];
    const tweets = this.db
      .prepare(
        `SELECT COUNT(DISTINCT um.tweet_id) AS n FROM concept_assignments ca
         JOIN unit_members um ON um.unit_id = ca.unit_id
         WHERE ca.slug = ? AND ca.unit_id IN (${eligible.sql})`,
      )
      .get(slug, ...eligible.params) as { n: number };
    return { ...toConceptCount(row), tweet_count: tweets.n, related };
  }

  /**
   * Bounded co-occurrence subgraph: the top concepts by unit count (optionally
   * restricted to units carrying a preset label), plus the strongest edges
   * between them.
   */
  graph(options: UnitSelection & { top: number }): Omit<ConceptGraph, "revision"> {
    return this.finalizedGraph(options, options.top);
  }

  private finalizedGraph(options: UnitSelection, top: number): Omit<ConceptGraph, "revision"> {
    const eligible = eligibleUnits({ ...options, taxonomyVersion: this.taxonomyVersion });
    const nodes = this.db
      .prepare(
        `SELECT v.slug AS slug, v.name AS name, COUNT(DISTINCT ca.unit_id) AS unit_count
         FROM concept_vocabulary v
         JOIN concept_assignments ca ON ca.slug = v.slug
         WHERE ca.unit_id IN (${eligible.sql})
         GROUP BY v.slug ORDER BY unit_count DESC, v.slug LIMIT ?`,
      )
      .all(...eligible.params, top) as GraphNode[];
    if (nodes.length === 0) return { nodes: [], links: [] };
    const slugs = nodes.map((node) => node.slug);
    const placeholders = slugs.map(() => "?").join(",");
    const links = this.db
      .prepare(
        `SELECT a.slug AS source, b.slug AS target, COUNT(DISTINCT a.unit_id) AS weight
         FROM concept_assignments a
         JOIN concept_assignments b ON b.unit_id = a.unit_id AND a.slug < b.slug
         WHERE a.unit_id IN (${eligible.sql})
           AND a.slug IN (${placeholders}) AND b.slug IN (${placeholders})
         GROUP BY a.slug, b.slug ORDER BY weight DESC, source, target LIMIT ?`,
      )
      .all(...eligible.params, ...slugs, ...slugs, top * 4) as GraphLink[];
    return { nodes, links };
  }
}

type UnitSelection = {
  authorIds?: readonly string[] | undefined;
  labels?: readonly string[] | undefined;
  labelMode?: "any" | "all" | undefined;
  publication?: "public-original" | undefined;
};

type EligibleUnitOptions = UnitSelection & { taxonomyVersion: number };

function eligibleUnits(options: EligibleUnitOptions): { sql: string; params: unknown[] } {
  const labels = options.labels ?? [];
  const labelPlaceholders = labels.map(() => "?").join(",");
  const finalizedJoins = `JOIN enrichment e ON e.unit_id = um.unit_id AND e.taxonomy_version = ?
            JOIN enrich_queue q ON q.unit_id = um.unit_id
              AND q.taxonomy_version = ? AND q.status = 'done'`;
  const selection = `${publicationWhere(options.publication, "um.unit_id")}${authorWhere(
    options.authorIds,
    "um.unit_id",
  )}`;
  const authorParams = options.authorIds ?? [];
  if (labels.length === 0) {
    return {
      sql: `SELECT DISTINCT um.unit_id FROM unit_members um
            ${finalizedJoins}
            WHERE 1 = 1${selection}`,
      params: [options.taxonomyVersion, options.taxonomyVersion, ...authorParams],
    };
  }
  if (options.labelMode !== "all") {
    return {
      sql: `SELECT DISTINCT um.unit_id FROM unit_members um
            ${finalizedJoins}
            JOIN tweet_labels tl ON tl.tweet_id = um.tweet_id
            WHERE tl.kind = 'preset' AND tl.label IN (${labelPlaceholders})${selection}`,
      params: [options.taxonomyVersion, options.taxonomyVersion, ...labels, ...authorParams],
    };
  }
  return {
    sql: `SELECT um.unit_id FROM unit_members um
          ${finalizedJoins}
          JOIN tweet_labels tl ON tl.tweet_id = um.tweet_id
          WHERE tl.kind = 'preset' AND tl.label IN (${labelPlaceholders})${selection}
          GROUP BY um.unit_id HAVING COUNT(DISTINCT tl.label) = ?`,
    params: [
      options.taxonomyVersion,
      options.taxonomyVersion,
      ...labels,
      ...authorParams,
      labels.length,
    ],
  };
}

function authorWhere(authorIds: readonly string[] | undefined, unitIdSql: string): string {
  if (authorIds === undefined || authorIds.length === 0) return "";
  return ` AND EXISTS (
             SELECT 1 FROM unit_members author_um
             JOIN tweets author_tweet ON author_tweet.id = author_um.tweet_id
             WHERE author_um.unit_id = ${unitIdSql}
               AND json_extract(author_tweet.json, '$.author.id') IN (${authorIds
                 .map(() => "?")
                 .join(",")})
           )`;
}

function publicationWhere(publication: UnitSelection["publication"], unitIdSql: string): string {
  if (publication !== "public-original") return "";
  return ` AND NOT EXISTS (
             SELECT 1 FROM unit_members private_um
             JOIN tweets private_tweet ON private_tweet.id = private_um.tweet_id
             WHERE private_um.unit_id = ${unitIdSql}
               AND json_extract(private_tweet.json, '$.is_subscriber_only') = 1
           )
           AND EXISTS (
             SELECT 1 FROM unit_members original_um
             JOIN tweets original_tweet ON original_tweet.id = original_um.tweet_id
             WHERE original_um.unit_id = ${unitIdSql}
               AND COALESCE(json_extract(original_tweet.json, '$.is_retweet'), 0) != 1
           )`;
}

function hasSelectionFilter(options: UnitSelection): boolean {
  return (
    (options.authorIds?.length ?? 0) > 0 ||
    (options.labels?.length ?? 0) > 0 ||
    options.publication !== undefined
  );
}

function toConceptCount(row: VocabularyRow): ConceptCount {
  return {
    slug: row.slug,
    name: row.name,
    aliases: JSON.parse(row.aliases) as string[],
    unit_count: row.unit_count,
  };
}
