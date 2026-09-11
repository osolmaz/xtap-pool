import type Database from "better-sqlite3";
import { z } from "zod";
import type { ResolvedConsumerContext } from "./consumer-context.js";
import { restrictedAccessSql } from "./post-state.js";

const proofSchema = z.object({
  base_hashes: z.string().nullable(),
  target_hashes: z.string().nullable(),
  base_hash: z.string().nullable(),
  base_at: z.string().nullable(),
  current_hash: z.string(),
  current_at: z.string(),
});
/** Coverage proofs use exact source membership and existing scalar indexes. No
 * queue replay or persisted consumer state is created here. */
export class ConsumerCoverageEffects {
  readonly additions: string[];
  private readonly baseKeys: string;
  private readonly targetKeys: string;
  private readonly authors: string;
  constructor(
    private readonly database: Database.Database,
    base: ResolvedConsumerContext,
    target: ResolvedConsumerContext,
  ) {
    this.authors = JSON.stringify(target.context.selection.author_ids);
    const previous = new Set(base.snapshot.files.map((file) => file.key));
    const current = new Set(target.snapshot.files.map((file) => file.key));
    if ([...previous].some((key) => !current.has(key)))
      throw new Error("coverage source is not append-only");
    this.additions = [...current].filter((key) => !previous.has(key));
    this.baseKeys = JSON.stringify([...previous]);
    this.targetKeys = JSON.stringify([...current]);
  }

  newResultUnits(contract: string, after = ""): string[] {
    return this.database
      .prepare(
        `SELECT DISTINCT r.unit_id FROM json_each(@changed) a
      JOIN source_segments segment ON segment.key = a.value AND segment.enrichment_rows > 0
      JOIN consumer_result_sources s ON s.segment_key = segment.key
      JOIN consumer_results r ON r.result_hash = s.result_hash
      WHERE r.contract_hash = @contract AND r.unit_id > @after AND EXISTS (
        SELECT 1 FROM consumer_post_units d JOIN observation_sources ds ON ds.source_ref = d.source_ref
        WHERE d.unit_id = r.unit_id AND d.author_id IN (SELECT value FROM json_each(@authors))
          AND ds.segment_key IN (SELECT value FROM json_each(@target))) AND NOT EXISTS (
        SELECT 1 FROM consumer_result_sources old WHERE old.result_hash = r.result_hash
          AND old.segment_key IN (SELECT value FROM json_each(@base)))
      ORDER BY r.unit_id LIMIT 100`,
      )
      .all({
        changed: JSON.stringify(this.additions),
        base: this.baseKeys,
        contract,
        authors: this.authors,
        target: this.targetKeys,
        after,
      })
      .map((row) => z.object({ unit_id: z.string() }).parse(row).unit_id);
  }

  posts(after = ""): string[] {
    return this.database
      .prepare(
        `WITH changed_posts AS MATERIALIZED (
      SELECT DISTINCT o.post_id FROM json_each(@changed) a
      CROSS JOIN source_segments segment ON segment.key = a.value AND segment.tweet_rows > 0
      CROSS JOIN observation_sources s ON s.segment_key = segment.key
      CROSS JOIN post_observations o ON o.observation_id = s.observation_id
      WHERE o.post_id > @after
    ) SELECT p.post_id FROM changed_posts p WHERE EXISTS (
        SELECT 1 FROM consumer_post_units d JOIN observation_sources ds ON ds.source_ref = d.source_ref
        WHERE d.post_id = p.post_id AND ds.segment_key IN (SELECT value FROM json_each(@target))
          AND EXISTS (SELECT 1 FROM consumer_post_units member JOIN observation_sources ms ON ms.source_ref = member.source_ref
            WHERE member.unit_id = d.unit_id AND member.author_id IN (SELECT value FROM json_each(@authors))
              AND ms.segment_key IN (SELECT value FROM json_each(@target))))
      ORDER BY p.post_id LIMIT 100`,
      )
      .all({
        changed: JSON.stringify(this.additions),
        after,
        authors: this.authors,
        target: this.targetKeys,
      })
      .map((row) => z.object({ post_id: z.string() }).parse(row).post_id);
  }

  units(posts: readonly string[]): string[] {
    if (posts.length === 0) return [];
    return this.database
      .prepare(
        `SELECT DISTINCT u.unit_id FROM consumer_post_units u
      JOIN observation_sources s ON s.source_ref = u.source_ref
      WHERE u.post_id IN (SELECT value FROM json_each(@posts))
        AND s.segment_key IN (SELECT value FROM json_each(@target))
      ORDER BY u.unit_id`,
      )
      .all({ posts: JSON.stringify(posts), target: this.targetKeys })
      .map((row) => z.object({ unit_id: z.string() }).parse(row).unit_id);
  }

  unitsObservedAt(units: readonly string[], observedAt: string): boolean {
    if (units.length === 0) return false;
    return (
      this.database
        .prepare(
          `SELECT 1 FROM consumer_post_units u
      JOIN observation_sources membership ON membership.source_ref = u.source_ref
      JOIN post_observations o ON o.post_id = u.post_id
      WHERE u.unit_id IN (SELECT value FROM json_each(@units))
        AND membership.segment_key IN (SELECT value FROM json_each(@base))
        AND o.observed_at = @observed_at AND EXISTS (
          SELECT 1 FROM observation_sources source
          WHERE source.observation_id = o.observation_id
            AND source.segment_key IN (SELECT value FROM json_each(@base)))
      LIMIT 1`,
        )
        .get({
          units: JSON.stringify(units),
          base: this.baseKeys,
          observed_at: observedAt,
        }) !== undefined
    );
  }

  unchanged(post: string): boolean {
    const row = this.database
      .prepare(
        `WITH observed AS MATERIALIZED (
      SELECT o.contributor, o.observed_at, o.content_hash,
        EXISTS (SELECT 1 FROM observation_sources s WHERE s.observation_id = o.observation_id
          AND s.segment_key IN (SELECT value FROM json_each(@base))) AS in_base
      FROM post_observations o WHERE o.post_id = @post AND EXISTS (
        SELECT 1 FROM observation_sources s WHERE s.observation_id = o.observation_id
          AND s.segment_key IN (SELECT value FROM json_each(@target)))
    ), base_latest AS (SELECT contributor, MAX(observed_at) AS at FROM observed WHERE in_base = 1 GROUP BY contributor),
    target_latest AS (SELECT contributor, MAX(observed_at) AS at FROM observed GROUP BY contributor),
    base_hashes AS (SELECT DISTINCT o.content_hash FROM observed o JOIN base_latest b
      ON b.contributor = o.contributor AND b.at = o.observed_at WHERE o.in_base = 1 ORDER BY o.content_hash),
    target_hashes AS (SELECT DISTINCT o.content_hash FROM observed o JOIN target_latest t
      ON t.contributor = o.contributor AND t.at = o.observed_at ORDER BY o.content_hash),
    latest AS MATERIALIZED (SELECT DISTINCT content_hash FROM observed WHERE in_base = 1
      AND observed_at = (SELECT MAX(observed_at) FROM observed WHERE in_base = 1)),
    winner AS MATERIALIZED (SELECT c.content_hash FROM latest l JOIN post_content_versions c ON c.content_hash = l.content_hash
      ORDER BY ${restrictedAccessSql("c.payload_json", "is_subscriber_only")} DESC,
        ${restrictedAccessSql("c.payload_json", "is_retweet")} DESC, c.content_hash DESC LIMIT 1)
    SELECT (SELECT GROUP_CONCAT(content_hash) FROM base_hashes) AS base_hashes,
      (SELECT GROUP_CONCAT(content_hash) FROM target_hashes) AS target_hashes,
      (SELECT content_hash FROM winner) AS base_hash,
      (SELECT MIN(observed_at) FROM observed WHERE in_base = 1 AND content_hash = (SELECT content_hash FROM winner)
        AND observed_at >= COALESCE((SELECT MAX(observed_at) FROM observed
          WHERE in_base = 1 AND content_hash <> (SELECT content_hash FROM winner)), '')) AS base_at,
      m.content_hash AS current_hash, m.content_at AS current_at FROM unit_members m WHERE m.tweet_id = @post`,
      )
      .get({ post, base: this.baseKeys, target: this.targetKeys });
    if (row === undefined) return false;
    const proof = proofSchema.parse(row);
    return (
      proof.base_hashes !== null &&
      proof.base_hashes === proof.target_hashes &&
      proof.base_hash === proof.current_hash &&
      proof.base_at === proof.current_at
    );
  }
}
