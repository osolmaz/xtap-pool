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
  // Start source membership with the observation, not one probe per pinned segment.
  // Both indexes exist, but the segment-first plan exceeds the real-source deadline.
  const row = database
    .prepare(
      `WITH eligible AS MATERIALIZED (${eligible.sql}), permitted AS MATERIALIZED (
    SELECT e.unit_id FROM eligible e WHERE
      (? IS NULL OR EXISTS (SELECT 1 FROM label_assignments a WHERE a.unit_id = e.unit_id
        AND a.kind = 'free' AND a.name = ? AND a.name IN (SELECT json_extract(value, '$.name') FROM json_each(?))))
      AND NOT EXISTS (SELECT 1 FROM unit_members m JOIN tweets t ON t.id = m.tweet_id
        WHERE m.unit_id = e.unit_id AND json_type(t.json, '$.is_subscriber_only') IS NOT NULL
          AND json_type(t.json, '$.is_subscriber_only') <> 'false')
    ) SELECT MAX(o.observed_at) AS latest FROM permitted p JOIN unit_members m ON m.unit_id = p.unit_id
      JOIN post_observations o ON o.post_id = m.tweet_id
      JOIN post_content_versions c ON c.content_hash = o.content_hash
      WHERE (? IS NULL OR o.post_id IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (SELECT 1 FROM tweets current WHERE current.id = o.post_id
          AND json_type(current.json, '$.is_retweet') IS NOT NULL AND json_type(current.json, '$.is_retweet') <> 'false')
        AND (json_type(c.payload_json, '$.is_subscriber_only') IS NULL OR json_type(c.payload_json, '$.is_subscriber_only') = 'false')
        AND (json_type(c.payload_json, '$.is_retweet') IS NULL OR json_type(c.payload_json, '$.is_retweet') = 'false')
        AND json_extract(c.payload_json, '$.author.id') IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM observation_sources s INDEXED BY idx_observation_source_id WHERE s.observation_id = o.observation_id
          AND s.segment_key IN (SELECT json_extract(value, '$.key') FROM json_each(?)))
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
