import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonicalJson, unitIdFor } from "@xtap-pool/shared";
import type { EnrichmentRow, PooledTweet } from "@xtap-pool/shared";
import { sourceReference } from "./observation-store.js";
import type { ObservationSource } from "./observation-store.js";

const rowSchema = z.object({ unit_id: z.string() });
const storedResultSchema = z.object({ result_hash: z.string() });
const limitSchema = z.number().int().min(1).max(500);

const TABLES = `
CREATE TABLE IF NOT EXISTS consumer_results (
  result_hash TEXT PRIMARY KEY, unit_id TEXT NOT NULL,
  input_hash TEXT NOT NULL, contract_hash TEXT NOT NULL,
  enriched_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_consumer_result_unit ON consumer_results(unit_id, contract_hash, input_hash, enriched_at DESC, result_hash DESC);
CREATE TABLE IF NOT EXISTS consumer_result_sources (
  source_ref TEXT PRIMARY KEY, result_hash TEXT NOT NULL,
  segment_key TEXT NOT NULL, operation INTEGER NOT NULL CHECK(operation >= 0),
  logical_path TEXT NOT NULL, position INTEGER NOT NULL CHECK(position >= 0),
  FOREIGN KEY(result_hash) REFERENCES consumer_results(result_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_consumer_result_source_segment ON consumer_result_sources(segment_key, result_hash);
CREATE INDEX IF NOT EXISTS idx_consumer_result_source_hash ON consumer_result_sources(result_hash, segment_key);
CREATE TABLE IF NOT EXISTS consumer_post_units (
  source_ref TEXT PRIMARY KEY, post_id TEXT NOT NULL, unit_id TEXT NOT NULL,
  FOREIGN KEY(source_ref) REFERENCES observation_sources(source_ref)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_consumer_post_units_post ON consumer_post_units(post_id, unit_id, source_ref);
CREATE INDEX IF NOT EXISTS idx_consumer_post_units_unit ON consumer_post_units(unit_id, post_id, source_ref);
CREATE TABLE IF NOT EXISTS consumer_label_units (
  result_hash TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY(result_hash, name),
  FOREIGN KEY(result_hash) REFERENCES consumer_results(result_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_consumer_label_dependency ON consumer_label_units(name, result_hash);
`;

/** Indexed raw effects, not a second mutable source or a consumer cursor counter. */
export class SourceEffectStore {
  constructor(private readonly database: Database.Database) {
    database.exec(TABLES);
  }

  recordPost(tweet: PooledTweet, source: ObservationSource): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO consumer_post_units
      (source_ref, post_id, unit_id) VALUES (?, ?, ?)`,
      )
      .run(sourceReference(source), tweet.id, unitIdFor(tweet));
  }

  recordResult(row: EnrichmentRow, source: ObservationSource): void {
    const normalized = { ...row, enriched_at: new Date(row.enriched_at).toISOString() };
    const json = canonicalJson(normalized);
    const hash = createHash("sha256").update(json).digest("hex");
    const reference = sourceReference(source);
    this.database.transaction(() => {
      const existing = this.database
        .prepare("SELECT result_hash FROM consumer_result_sources WHERE source_ref = ?")
        .get(reference);
      if (existing !== undefined && storedResultSchema.parse(existing).result_hash !== hash)
        throw new Error("consumer source reference changed its contents");
      this.database
        .prepare(
          `INSERT INTO consumer_results VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(result_hash) DO NOTHING`,
        )
        .run(hash, row.unit_id, row.input_hash, row.contract_hash, normalized.enriched_at, json);
      this.database
        .prepare(
          `INSERT INTO consumer_result_sources VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_ref) DO NOTHING`,
        )
        .run(reference, hash, source.segmentKey, source.operation, source.path, source.position);
      const insert = this.database.prepare(
        "INSERT OR IGNORE INTO consumer_label_units VALUES (?, ?)",
      );
      // Only free-label approvals can change without a new unit result.
      for (const label of row.free_labels) insert.run(hash, label.name);
    })();
  }

  /** Find candidates from an exact raw-set difference. Comparing their content is separate.
   * Target membership gates dependencies too, so later writes cannot change a pinned page.
   * Registry candidates come from changed published approvals, not arbitrary raw events. */
  affectedUnits(options: {
    changedSegments: readonly string[];
    baseSegments: readonly string[];
    targetSegments: readonly string[];
    changedLabels: readonly string[];
    contractHash: string;
    after?: string;
    limit: number;
  }): { ids: string[]; hasMore: boolean } {
    const limit = limitSchema.parse(options.limit);
    const target = new Set(options.targetSegments);
    if ([...options.changedSegments, ...options.baseSegments].some((key) => !target.has(key)))
      throw new Error("source comparison is outside the pinned target");
    const rows = this.database
      .prepare(
        `
      WITH changed(key) AS MATERIALIZED (SELECT value FROM json_each(@changed)),
           base(key) AS MATERIALIZED (SELECT value FROM json_each(@base)),
           target(key) AS MATERIALIZED (SELECT value FROM json_each(@target)),
           new_posts(post_id) AS (
             SELECT DISTINCT o.post_id FROM changed c
             JOIN observation_sources s ON s.segment_key = c.key
             JOIN post_observations o ON o.observation_id = s.observation_id
           ),
           observed AS MATERIALIZED (
             SELECT o.post_id, o.contributor, o.observed_at, o.content_hash,
               EXISTS (SELECT 1 FROM observation_sources s JOIN base b ON b.key = s.segment_key
                       WHERE s.observation_id = o.observation_id) AS in_base
             FROM new_posts p JOIN post_observations o ON o.post_id = p.post_id
             WHERE EXISTS (SELECT 1 FROM observation_sources s JOIN target t ON t.key = s.segment_key
                           WHERE s.observation_id = o.observation_id)
           ),
           base_latest AS (SELECT post_id, contributor, MAX(observed_at) AS at FROM observed WHERE in_base = 1 GROUP BY post_id, contributor),
           target_latest AS (SELECT post_id, contributor, MAX(observed_at) AS at FROM observed GROUP BY post_id, contributor),
           base_hashes AS MATERIALIZED (
             SELECT DISTINCT o.post_id, o.content_hash FROM observed o JOIN base_latest b
               ON b.post_id = o.post_id AND b.contributor = o.contributor AND b.at = o.observed_at
             WHERE o.in_base = 1
           ),
           target_hashes AS MATERIALIZED (
             SELECT DISTINCT o.post_id, o.content_hash FROM observed o JOIN target_latest t
               ON t.post_id = o.post_id AND t.contributor = o.contributor AND t.at = o.observed_at
           ),
           changed_posts(post_id) AS (
             SELECT post_id FROM new_posts p
             WHERE (SELECT COUNT(*) FROM base_hashes b WHERE b.post_id = p.post_id) <> 1
                OR (SELECT COUNT(*) FROM target_hashes t WHERE t.post_id = p.post_id) <> 1
                OR (SELECT MIN(content_hash) FROM base_hashes b WHERE b.post_id = p.post_id)
                   <> (SELECT MIN(content_hash) FROM target_hashes t WHERE t.post_id = p.post_id)
           ),
           affected(unit_id) AS (
             SELECT d.unit_id FROM changed_posts p
             JOIN consumer_post_units d ON d.post_id = p.post_id
             JOIN observation_sources s ON s.source_ref = d.source_ref
             JOIN target t ON t.key = s.segment_key
             UNION
             SELECT r.unit_id FROM changed c JOIN consumer_result_sources s ON s.segment_key = c.key
             JOIN consumer_results r ON r.result_hash = s.result_hash WHERE r.contract_hash = @contract
               AND NOT EXISTS (SELECT 1 FROM consumer_result_sources previous JOIN base b ON b.key = previous.segment_key
                               WHERE previous.result_hash = r.result_hash)
             UNION
             SELECT r.unit_id FROM consumer_label_units l
             JOIN consumer_results r ON r.result_hash = l.result_hash AND r.contract_hash = @contract
             JOIN consumer_result_sources s ON s.result_hash = r.result_hash
             JOIN target t ON t.key = s.segment_key
             WHERE l.name IN (SELECT value FROM json_each(@labels))
           )
      SELECT DISTINCT unit_id FROM affected WHERE unit_id > @after ORDER BY unit_id LIMIT @limit
    `,
      )
      .all({
        changed: JSON.stringify(options.changedSegments),
        base: JSON.stringify(options.baseSegments),
        target: JSON.stringify(options.targetSegments),
        labels: JSON.stringify(options.changedLabels),
        contract: options.contractHash,
        after: options.after ?? "",
        limit: limit + 1,
      });
    return {
      ids: rows.slice(0, limit).map((row) => rowSchema.parse(row).unit_id),
      hasMore: rows.length > limit,
    };
  }

  clearForRebuild(): void {
    this.database.exec(
      "DELETE FROM consumer_label_units; DELETE FROM consumer_post_units; DELETE FROM consumer_result_sources; DELETE FROM consumer_results;",
    );
  }
}
