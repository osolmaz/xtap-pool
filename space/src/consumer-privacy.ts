import type Database from "better-sqlite3";
import type { ResolvedConsumerContext } from "./consumer-context.js";
import { ConsumerHttpError } from "./consumer-errors.js";

/** Inspect only posts in source segments added since this page sequence was pinned.
 * No historical body reconstruction. A withdrawal invalidates the whole unfinished
 * selection, including bodies the consumer has already accepted on earlier pages. */
export function assertConsumerPrivacy(
  database: Database.Database,
  target: ResolvedConsumerContext,
): void {
  const withdrawn = database
    .prepare(
      `
    WITH additions AS MATERIALIZED (
      SELECT key AS segment_key FROM source_segments
      WHERE key NOT IN (SELECT json_extract(value, '$.key') FROM json_each(@files))
    ), changed AS MATERIALIZED (
      SELECT DISTINCT o.post_id FROM additions a
      JOIN observation_sources s ON s.segment_key = a.segment_key
      JOIN post_observations o ON o.observation_id = s.observation_id
    )
    SELECT 1 FROM changed p WHERE
      EXISTS (SELECT 1 FROM consumer_post_units u JOIN observation_sources s ON s.source_ref = u.source_ref
        WHERE u.post_id = p.post_id AND u.author_id IN (SELECT value FROM json_each(@authors))
        AND s.segment_key IN (SELECT json_extract(value, '$.key') FROM json_each(@files)))
      AND (NOT EXISTS (SELECT 1 FROM tweets t WHERE t.id = p.post_id)
        OR EXISTS (SELECT 1 FROM tweets t WHERE t.id = p.post_id AND (
          (json_type(t.json, '$.is_subscriber_only') IS NOT NULL AND json_type(t.json, '$.is_subscriber_only') <> 'false')
          OR (json_type(t.json, '$.is_retweet') IS NOT NULL AND json_type(t.json, '$.is_retweet') <> 'false')
          OR json_extract(t.json, '$.author.id') IS NULL
          OR json_extract(t.json, '$.author.id') NOT IN (SELECT value FROM json_each(@authors))))) LIMIT 1
  `,
    )
    .get({
      files: JSON.stringify(target.snapshot.files),
      authors: JSON.stringify(target.context.selection.author_ids),
    });
  if (withdrawn !== undefined)
    throw new ConsumerHttpError(
      409,
      "privacy_changed",
      "Source privacy changed. Remove the saved selection before recovery.",
      {
        action: "discard_selection",
        selection: target.context.selection,
        discard: ["units", "observations"],
        next: "explicit_bootstrap",
      },
    );
}
