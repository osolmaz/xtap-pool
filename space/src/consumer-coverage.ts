import type Database from "better-sqlite3";
import { z } from "zod";
import { eligibleUnits } from "./enrich-store.js";
import { historicalSelection } from "./consumer-changes.js";
import type { ResolvedConsumerContext } from "./consumer-context.js";

/** Current selected, completed public content only. Counters have their own clock;
 * pending, unselected, subscriber-only and retweet samples cannot advance it. */
export function selectedObservationThrough(
  database: Database.Database,
  target: ResolvedConsumerContext,
  postIds?: readonly string[],
): string | null {
  const context = target.context;
  const selection = historicalSelection(target);
  const unitIds =
    postIds === undefined
      ? undefined
      : database
          .prepare(
            "SELECT DISTINCT unit_id FROM unit_members WHERE tweet_id IN (SELECT value FROM json_each(?))",
          )
          .all(JSON.stringify(postIds))
          .map((row) => z.object({ unit_id: z.string() }).parse(row).unit_id);
  const eligible = eligibleUnits({
    ...selection,
    ...(unitIds === undefined ? {} : { unitIds }),
    taxonomyVersion: context.taxonomy.version,
    contractHash: context.contract,
  });
  // Read each selected post once and stop at its newest permitted observation.
  // Scanning every historical counter sample repeats source and visibility checks.
  const row = database
    .prepare(
      `WITH eligible AS MATERIALIZED (${eligible.sql}), permitted AS MATERIALIZED (
    SELECT e.unit_id FROM eligible e WHERE
      (? IS NULL OR EXISTS (SELECT 1 FROM label_assignments a WHERE a.unit_id = e.unit_id
        AND a.kind = 'free' AND a.name = ? AND a.name IN (SELECT json_extract(value, '$.name') FROM json_each(?))))
      AND NOT EXISTS (SELECT 1 FROM unit_members m JOIN tweets t ON t.id = m.tweet_id
        WHERE m.unit_id = e.unit_id AND json_type(t.json, '$.is_subscriber_only') IS NOT NULL
          AND json_type(t.json, '$.is_subscriber_only') <> 'false')
    ), selected_posts AS MATERIALIZED (
      SELECT DISTINCT m.tweet_id AS post_id FROM permitted p JOIN unit_members m ON m.unit_id = p.unit_id
      WHERE (? IS NULL OR m.tweet_id IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (SELECT 1 FROM tweets current WHERE current.id = m.tweet_id
          AND json_type(current.json, '$.is_retweet') IS NOT NULL AND json_type(current.json, '$.is_retweet') <> 'false')
    ) SELECT MAX((
      SELECT o.observed_at FROM post_observations o INDEXED BY idx_observation_post_time
      JOIN post_content_versions c ON c.content_hash = o.content_hash
      WHERE o.post_id = p.post_id
        AND (json_type(c.payload_json, '$.is_subscriber_only') IS NULL OR json_type(c.payload_json, '$.is_subscriber_only') = 'false')
        AND (json_type(c.payload_json, '$.is_retweet') IS NULL OR json_type(c.payload_json, '$.is_retweet') = 'false')
        AND json_extract(c.payload_json, '$.author.id') IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM observation_sources s INDEXED BY idx_observation_source_id WHERE s.observation_id = o.observation_id
          AND s.segment_key IN (SELECT json_extract(value, '$.key') FROM json_each(?)))
      ORDER BY o.observed_at DESC, o.observation_id DESC LIMIT 1
    )) AS latest FROM selected_posts p
    `,
    )
    .get(
      ...eligible.params,
      selection.freeLabel ?? null,
      selection.freeLabel ?? null,
      JSON.stringify(context.registry.approved),
      postIds === undefined ? null : JSON.stringify(postIds),
      postIds === undefined ? null : JSON.stringify(postIds),
      JSON.stringify(selection.authorIds),
      JSON.stringify(target.snapshot.files),
    );
  return z.object({ latest: z.string().nullable() }).parse(row).latest;
}
