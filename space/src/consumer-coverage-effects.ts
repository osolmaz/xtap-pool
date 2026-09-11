import type Database from "better-sqlite3";
import { z } from "zod";
import type { ResolvedConsumerContext } from "./consumer-context.js";
import { restrictedAccessSql } from "./post-state.js";

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
      ORDER BY p.post_id LIMIT 500`,
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

  semanticPosts(posts: readonly string[]): string[] {
    if (posts.length === 0) return [];
    return this.database
      .prepare(
        `WITH requested(post_id) AS MATERIALIZED (SELECT value FROM json_each(@posts)),
    base(key) AS MATERIALIZED (SELECT value FROM json_each(@base)),
    target(key) AS MATERIALIZED (SELECT value FROM json_each(@target)),
    observed AS MATERIALIZED (
      SELECT o.observation_id, o.post_id, o.contributor, o.observed_at, o.content_hash,
        MAX(CASE WHEN b.key IS NULL THEN 0 ELSE 1 END) AS in_base
      FROM requested r
      JOIN post_observations o INDEXED BY idx_observation_post_time ON o.post_id = r.post_id
      JOIN observation_sources s INDEXED BY idx_observation_source_id
        ON s.observation_id = o.observation_id
      JOIN target t ON t.key = s.segment_key
      LEFT JOIN base b ON b.key = s.segment_key
      GROUP BY o.observation_id
    ), base_latest AS (
      SELECT post_id, contributor, MAX(observed_at) AS at FROM observed
      WHERE in_base = 1 GROUP BY post_id, contributor
    ), target_latest AS (
      SELECT post_id, contributor, MAX(observed_at) AS at FROM observed
      GROUP BY post_id, contributor
    ), base_hashes AS MATERIALIZED (
      SELECT DISTINCT o.post_id, o.content_hash FROM observed o JOIN base_latest b
        ON b.post_id = o.post_id AND b.contributor = o.contributor AND b.at = o.observed_at
      WHERE o.in_base = 1
    ), target_hashes AS MATERIALIZED (
      SELECT DISTINCT o.post_id, o.content_hash FROM observed o JOIN target_latest t
        ON t.post_id = o.post_id AND t.contributor = o.contributor AND t.at = o.observed_at
    ), base_only AS (
      SELECT post_id, content_hash FROM base_hashes
      EXCEPT SELECT post_id, content_hash FROM target_hashes
    ), target_only AS (
      SELECT post_id, content_hash FROM target_hashes
      EXCEPT SELECT post_id, content_hash FROM base_hashes
    ), changed_hashes AS (
      SELECT post_id FROM base_only UNION SELECT post_id FROM target_only
    ), base_max AS (
      SELECT post_id, MAX(observed_at) AS at FROM observed WHERE in_base = 1 GROUP BY post_id
    ), latest AS MATERIALIZED (
      SELECT DISTINCT o.post_id, o.content_hash FROM observed o JOIN base_max b
        ON b.post_id = o.post_id AND b.at = o.observed_at WHERE o.in_base = 1
    ), ranked_winners AS MATERIALIZED (
      SELECT l.post_id, c.content_hash, ROW_NUMBER() OVER (
        PARTITION BY l.post_id ORDER BY
          ${restrictedAccessSql("c.payload_json", "is_subscriber_only")} DESC,
          ${restrictedAccessSql("c.payload_json", "is_retweet")} DESC,
          c.content_hash DESC
      ) AS position
      FROM latest l JOIN post_content_versions c ON c.content_hash = l.content_hash
    ), winners AS MATERIALIZED (
      SELECT post_id, content_hash FROM ranked_winners WHERE position = 1
    ), last_different AS (
      SELECT w.post_id, MAX(o.observed_at) AS at FROM winners w
      LEFT JOIN observed o ON o.post_id = w.post_id AND o.in_base = 1
        AND o.content_hash <> w.content_hash GROUP BY w.post_id
    ), base_activity AS (
      SELECT w.post_id, MIN(o.observed_at) AS at FROM winners w
      JOIN observed o ON o.post_id = w.post_id AND o.in_base = 1
        AND o.content_hash = w.content_hash
      LEFT JOIN last_different d ON d.post_id = w.post_id
      WHERE o.observed_at >= COALESCE(d.at, '') GROUP BY w.post_id
    ), base_posts AS (SELECT DISTINCT post_id FROM base_hashes)
    SELECT r.post_id FROM requested r
    LEFT JOIN base_posts b ON b.post_id = r.post_id
    LEFT JOIN changed_hashes h ON h.post_id = r.post_id
    LEFT JOIN winners w ON w.post_id = r.post_id
    LEFT JOIN base_activity a ON a.post_id = r.post_id
    LEFT JOIN unit_members m ON m.tweet_id = r.post_id
    WHERE b.post_id IS NULL OR h.post_id IS NOT NULL
      OR w.content_hash IS NULL OR m.content_hash IS NULL OR w.content_hash <> m.content_hash
      OR a.at IS NULL OR a.at <> m.content_at
    ORDER BY r.post_id`,
      )
      .all({ posts: JSON.stringify(posts), base: this.baseKeys, target: this.targetKeys })
      .map((row) => z.object({ post_id: z.string() }).parse(row).post_id);
  }
}
