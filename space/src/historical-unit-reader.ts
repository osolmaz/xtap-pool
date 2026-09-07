import type Database from "better-sqlite3";
import { z } from "zod";
import { computeInputHash, enrichmentRowSchema, tweetSchema } from "@xtap-pool/shared";
import type { EnrichedUnit, PooledTweet } from "@xtap-pool/shared";
import { TweetStore } from "./store.js";
import { EnrichStore } from "./enrich-store.js";
import { UnitStore } from "./unit-store.js";
import type { UnitQuery } from "./unit-store.js";
import { consumerRegistrySchema } from "./consumer-registry.js";
import type { ConsumerRegistry } from "./consumer-registry.js";

const MAX_POSTS = 2000;
const unitIdsSchema = z.array(z.string().min(1)).max(200);
const postIdRow = z.object({ post_id: z.string() });
const payloadRow = z.object({ payload_json: z.string() });
const tweetRow = z.object({
  payload_json: z.string(),
  contributor: z.string(),
  observed_at: z.string(),
  received_at: z.string(),
});
export type HistoricalSelection = Pick<
  UnitQuery,
  "authorIds" | "labels" | "labelMode" | "freeLabel" | "publication"
>;
export type HistoricalBoundary = {
  /** Exact membership from a checksum-verified raw snapshot, not a key watermark. */
  segments: readonly string[];
  /** Frozen published approvals from the same indexed-source boundary. */
  registry: ConsumerRegistry;
};

/** Reconstruct only requested units, not an old copy of the complete database. */
export class HistoricalUnitReader {
  constructor(
    private readonly database: Database.Database,
    private readonly taxonomyVersion: number,
    private readonly contractHash: string,
  ) {}

  read(
    unitIds: readonly string[],
    boundary: HistoricalBoundary,
    selection: HistoricalSelection,
  ): readonly EnrichedUnit[] {
    const ids = unitIdsSchema.parse(unitIds);
    const registry = consumerRegistrySchema.parse(boundary.registry);
    if (ids.length === 0) return [];
    const keys = JSON.stringify(boundary.segments);
    const posts = this.postsFor(ids, keys);
    const slice = new TweetStore();
    try {
      const enrich = new EnrichStore(
        slice.database,
        this.taxonomyVersion,
        () => new Date(0),
        this.contractHash,
      );
      slice.insert(posts);
      enrich.registerTweets(posts);
      for (const id of ids) this.applyResult(id, enrich, keys);
      this.applyRegistry(slice.database, registry);
      // Coverage timestamps are reported separately. A later metric observation
      // must not hide an otherwise complete unit behind the old capture cutoff.
      return new UnitStore(slice.database, this.taxonomyVersion).query({
        ...selection,
        unitIds: ids,
        limit: ids.length,
      }).units;
    } finally {
      slice.close();
    }
  }

  private postsFor(ids: readonly string[], keys: string): PooledTweet[] {
    const postRows = this.database
      .prepare(
        `
      SELECT DISTINCT d.post_id FROM consumer_post_units d
      JOIN observation_sources s ON s.source_ref = d.source_ref
      WHERE d.unit_id IN (SELECT value FROM json_each(@units))
        AND s.segment_key IN (SELECT value FROM json_each(@keys))
      ORDER BY d.post_id LIMIT @limit
    `,
      )
      .all({ units: JSON.stringify(ids), keys, limit: MAX_POSTS + 1 });
    if (postRows.length > MAX_POSTS) throw new Error("historical unit read exceeds the post bound");
    const postIds = postRows.map((row) => postIdRow.parse(row).post_id);
    if (postIds.length === 0) return [];
    const rows = this.database
      .prepare(
        `
      WITH candidates AS (
        SELECT o.observation_id, o.post_id, o.contributor, o.observed_at, o.content_hash,
               c.payload_json,
               (SELECT MIN(s.received_at) FROM observation_sources s
                WHERE s.observation_id = o.observation_id AND s.segment_key IN (SELECT value FROM json_each(@keys))) AS received_at
        FROM post_observations o JOIN post_content_versions c ON c.content_hash = o.content_hash
        WHERE o.post_id IN (SELECT value FROM json_each(@posts))
          AND EXISTS (SELECT 1 FROM observation_sources s WHERE s.observation_id = o.observation_id
                      AND s.segment_key IN (SELECT value FROM json_each(@keys)))
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY post_id, contributor ORDER BY observed_at DESC,
          COALESCE(json_extract(payload_json, '$.is_subscriber_only'), 0) DESC,
          content_hash DESC, observation_id DESC
        ) AS position FROM candidates
      )
      SELECT payload_json, contributor, observed_at, received_at FROM ranked
      WHERE position = 1 ORDER BY post_id, contributor LIMIT @limit
    `,
      )
      .all({ posts: JSON.stringify(postIds), keys, limit: MAX_POSTS + 1 });
    if (rows.length > MAX_POSTS)
      throw new Error("historical unit read exceeds the contributor-copy bound");
    return rows.map((row) => {
      const parsed = tweetRow.parse(row);
      const content: unknown = JSON.parse(parsed.payload_json);
      const fields = z.record(z.string(), z.unknown()).parse(content);
      const tweet = tweetSchema.parse({ ...fields, captured_at: parsed.observed_at });
      return { ...tweet, contributed_by: parsed.contributor, pooled_at: parsed.received_at };
    });
  }

  private applyResult(unitId: string, enrich: EnrichStore, keys: string): void {
    const members = enrich.unitSemanticMembers(unitId);
    if (members.length === 0) return;
    const hash = computeInputHash(unitId, members);
    const row = this.database
      .prepare(
        `
      SELECT r.payload_json FROM consumer_results r
      WHERE r.unit_id = @unit AND r.contract_hash = @contract AND r.input_hash = @input
        AND EXISTS (SELECT 1 FROM consumer_result_sources s WHERE s.result_hash = r.result_hash
                    AND s.segment_key IN (SELECT value FROM json_each(@keys)))
      ORDER BY r.enriched_at DESC, r.result_hash DESC LIMIT 1
    `,
      )
      .get({ unit: unitId, contract: this.contractHash, input: hash, keys });
    if (row === undefined) return;
    enrich.applyEnrichment(
      enrichmentRowSchema.parse(JSON.parse(payloadRow.parse(row).payload_json)),
    );
  }

  private applyRegistry(slice: Database.Database, registry: ConsumerRegistry): void {
    const labels = new Set(
      z
        .array(z.object({ name: z.string() }))
        .parse(
          slice.prepare("SELECT DISTINCT name FROM label_assignments WHERE kind = 'free'").all(),
        )
        .map((row) => row.name),
    );
    const insert = slice.prepare(`INSERT INTO free_label_registry
      (name, status, first_observed_at, updated_at) VALUES (?, 'approved', ?, ?)`);
    for (const label of registry.approved) {
      if (labels.has(label.name)) insert.run(label.name, label.first_observed_at, label.updated_at);
    }
  }
}
