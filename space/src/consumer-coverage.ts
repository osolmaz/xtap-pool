import type Database from "better-sqlite3";
import { z } from "zod";
import { eligibleUnits } from "./enrich-store.js";
import { historicalSelection } from "./consumer-changes.js";
import type { ResolvedConsumerContext } from "./consumer-context.js";

const unitRow = z.object({ unit_id: z.string() });

/** Historical membership is an indexed superset of current selected units.
 * Start there, then apply the exact current author and publication rules once
 * for both coverage clocks. */
export function selectedCurrentCoverageUnitIds(
  database: Database.Database,
  target: ResolvedConsumerContext,
  options: {
    unitIds?: readonly string[];
    after?: string;
  } = {},
): string[] {
  if (options.unitIds?.length === 0) return [];
  const context = target.context;
  const authors = JSON.stringify(context.selection.author_ids);
  return database
    .prepare(
      `WITH candidates AS MATERIALIZED (
      SELECT DISTINCT u.unit_id FROM consumer_post_units u
      JOIN enrich_queue q ON q.unit_id = u.unit_id
      WHERE u.author_id IN (SELECT value FROM json_each(@authors))
        AND (@unit_ids IS NULL OR u.unit_id IN (SELECT value FROM json_each(@unit_ids)))
        AND (@after IS NULL OR q.latest_activity_at > @after)
    ) SELECT c.unit_id FROM candidates c WHERE
      NOT EXISTS (SELECT 1 FROM unit_members m INDEXED BY idx_unit_members_current_access
        WHERE m.unit_id = c.unit_id AND (
          m.author_id IS NULL
          OR m.author_id NOT IN (SELECT value FROM json_each(@authors))
          OR m.is_subscriber_only = 1))
      AND EXISTS (SELECT 1 FROM unit_members m INDEXED BY idx_unit_members_current_access
        WHERE m.unit_id = c.unit_id AND m.is_retweet = 0)
      ORDER BY c.unit_id`,
    )
    .all({
      authors,
      unit_ids: options.unitIds === undefined ? null : JSON.stringify(options.unitIds),
      after: options.after ?? null,
    })
    .map((row) => unitRow.parse(row).unit_id);
}

/** Current selected, completed public content only. Counters have their own clock;
 * pending, unselected, subscriber-only and retweet samples cannot advance it. */
export function selectedObservationThrough(
  database: Database.Database,
  target: ResolvedConsumerContext,
  postIds?: readonly string[],
): string | null {
  const unitIds =
    postIds === undefined
      ? undefined
      : database
          .prepare(
            "SELECT DISTINCT unit_id FROM unit_members WHERE tweet_id IN (SELECT value FROM json_each(?))",
          )
          .all(JSON.stringify(postIds))
          .map((row) => unitRow.parse(row).unit_id);
  return observationThrough(database, target, unitIds, postIds, false);
}

/** The caller proved that the database is exactly the target source and applied
 * current author and publication rules to unitIds. Do not repeat either scan. */
export function selectedCurrentObservationThrough(
  database: Database.Database,
  target: ResolvedConsumerContext,
  unitIds: readonly string[],
): string | null {
  if (unitIds.length === 0) return null;
  return observationThrough(database, target, unitIds, undefined, true);
}

export function selectedUnitObservationThrough(
  database: Database.Database,
  target: ResolvedConsumerContext,
  unitIds: readonly string[],
): string | null {
  if (unitIds.length === 0) return null;
  return observationThrough(database, target, unitIds, undefined, false);
}

function observationThrough(
  database: Database.Database,
  target: ResolvedConsumerContext,
  unitIds: readonly string[] | undefined,
  postIds: readonly string[] | undefined,
  currentSource: boolean,
): string | null {
  const context = target.context;
  const selection = historicalSelection(target);
  const eligible = eligibleUnits({
    ...(currentSource ? { labels: selection.labels, labelMode: selection.labelMode } : selection),
    unitIds,
    taxonomyVersion: context.taxonomy.version,
    contractHash: context.contract,
  });
  const sourceSql = currentSource
    ? ""
    : `AND EXISTS (SELECT 1 FROM observation_sources s INDEXED BY idx_observation_source_id
          WHERE s.observation_id = o.observation_id
            AND s.segment_key IN (SELECT json_extract(value, '$.key') FROM json_each(?)))`;
  const privacySql = coveragePrivacySql(currentSource);
  // Read each selected post once and stop at its newest permitted observation.
  // Scanning every historical counter sample repeats source and visibility checks.
  const row = database
    .prepare(
      `WITH eligible AS MATERIALIZED (${eligible.sql}), permitted AS MATERIALIZED (
    SELECT e.unit_id FROM eligible e WHERE
      (? IS NULL OR EXISTS (SELECT 1 FROM label_assignments a WHERE a.unit_id = e.unit_id
        AND a.kind = 'free' AND a.name = ? AND a.name IN (SELECT json_extract(value, '$.name') FROM json_each(?))))
      ${privacySql}
    ), selected_posts AS MATERIALIZED (
      SELECT DISTINCT m.tweet_id AS post_id FROM permitted p
      JOIN unit_members m INDEXED BY idx_unit_members_current_access ON m.unit_id = p.unit_id
      WHERE (? IS NULL OR m.tweet_id IN (SELECT value FROM json_each(?)))
        AND m.is_retweet = 0
    ) SELECT MAX((
      SELECT o.observed_at FROM post_observations o INDEXED BY idx_observation_post_time
      JOIN post_content_versions c ON c.content_hash = o.content_hash
      WHERE o.post_id = p.post_id
        AND (json_type(c.payload_json, '$.is_subscriber_only') IS NULL OR json_type(c.payload_json, '$.is_subscriber_only') = 'false')
        AND (json_type(c.payload_json, '$.is_retweet') IS NULL OR json_type(c.payload_json, '$.is_retweet') = 'false')
        AND json_extract(c.payload_json, '$.author.id') IN (SELECT value FROM json_each(?))
        ${sourceSql}
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
      ...(currentSource ? [] : [JSON.stringify(target.snapshot.files)]),
    );
  return z.object({ latest: z.string().nullable() }).parse(row).latest;
}

function coveragePrivacySql(currentSource: boolean): string {
  if (currentSource) return "";
  return `AND NOT EXISTS (SELECT 1 FROM unit_members m INDEXED BY idx_unit_members_current_access
        WHERE m.unit_id = e.unit_id AND m.is_subscriber_only = 1)`;
}
