import type Database from "better-sqlite3";
import { z } from "zod";
import { observationSchema } from "@xtap-pool/shared";
import type { HistoricalBoundary, HistoricalSelection } from "./historical-unit-reader.js";
import { ConsumerPostAccess } from "./consumer-post-access.js";
import { observationPositionSchema } from "./consumer-cursor.js";
import type { ObservationPosition } from "./consumer-cursor.js";

export const consumerObservationSchema = observationSchema
  .extend({
    post_id: z.string().regex(/^\d{1,20}$/u),
    source_ref: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type ConsumerObservation = z.infer<typeof consumerObservationSchema>;
const requestSchema = z
  .object({
    postIds: z
      .array(z.string().regex(/^\d{1,20}$/u))
      .min(1)
      .max(100),
    since: z.iso.datetime(),
    until: z.iso.datetime(),
    after: observationPositionSchema.optional(),
    limit: z.number().int().min(1).max(500),
  })
  .superRefine((value, context) => {
    const duration = Date.parse(value.until) - Date.parse(value.since);
    if (
      duration <= 0 ||
      duration > 30 * 86_400_000 ||
      new Set(value.postIds).size !== value.postIds.length
    )
      context.addIssue({
        code: "custom",
        message: "history requires distinct IDs and a range of at most 30 days",
      });
  });
const PUBLIC_SAMPLE = `(json_type(c.payload_json, '$.is_subscriber_only') IS NULL OR json_type(c.payload_json, '$.is_subscriber_only') = 'false')
  AND (json_type(c.payload_json, '$.is_retweet') IS NULL OR json_type(c.payload_json, '$.is_retweet') = 'false')
  AND json_extract(c.payload_json, '$.author.id') IN (SELECT value FROM json_each(@authors))`;
const storedSchema = z.object({
  payload_json: z.string(),
  source_ref: z.string(),
  received_at: z.string(),
});
const coverageSchema = z.object({
  post_id: z.string(),
  count: z.number().int().nonnegative(),
  earliest: z.string().nullable(),
  latest: z.string().nullable(),
});
export type ObservationCoverage = {
  post_id: string;
  state: "available" | "no_history" | "unavailable";
  count: number | null;
  earliest: string | null;
  latest: string | null;
};
export type ObservationPage = {
  observations: ConsumerObservation[];
  coverage: ObservationCoverage[];
  next?: ObservationPosition;
};

/** Bounded private history read. Authorization is checked even for a retained old boundary. */
export class ConsumerObservationReader {
  private readonly access: ConsumerPostAccess;
  constructor(
    private readonly database: Database.Database,
    taxonomyVersion: number,
    contractHash: string,
  ) {
    this.access = new ConsumerPostAccess(database, taxonomyVersion, contractHash);
  }

  history(
    options: z.infer<typeof requestSchema> & {
      boundary: HistoricalBoundary;
      selection: HistoricalSelection;
    },
  ): ObservationPage {
    const query = requestSchema.parse(options);
    const permitted = this.access.permitted(query.postIds, options.boundary, options.selection);
    const after = query.after ?? { post_id: "", observed_at: "", id: "" };
    const params = {
      posts: JSON.stringify([...permitted]),
      keys: JSON.stringify(options.boundary.segments),
      authors: JSON.stringify(options.selection.authorIds ?? []),
      since: query.since,
      until: query.until,
      post: after.post_id,
      at: after.observed_at,
      id: after.id,
      limit: query.limit + 1,
    };
    const rows = this.database
      .prepare(
        `WITH samples AS MATERIALIZED (
      SELECT o.*, s.source_ref, s.received_at AS source_received_at,
        ROW_NUMBER() OVER (PARTITION BY o.observation_id ORDER BY s.received_at, s.source_ref) AS copy
      FROM post_observations o JOIN observation_sources s INDEXED BY idx_observation_source_id ON s.observation_id = o.observation_id
      JOIN post_content_versions c ON c.content_hash = o.content_hash
      WHERE ${PUBLIC_SAMPLE} AND o.post_id IN (SELECT value FROM json_each(@posts))
        AND o.observed_at >= @since AND o.observed_at < @until
        AND s.segment_key IN (SELECT value FROM json_each(@keys))
        AND (o.post_id, o.observed_at, o.observation_id) > (@post, @at, @id)
    ) SELECT payload_json, source_ref, source_received_at AS received_at FROM samples WHERE copy = 1
      ORDER BY post_id, observed_at, observation_id LIMIT @limit`,
      )
      .all(params);
    const observations = rows.slice(0, query.limit).map(parseObservation);
    const last = observations.at(-1);
    return {
      observations,
      coverage: this.coverage(
        query,
        permitted,
        options.boundary,
        options.selection.authorIds ?? [],
      ),
      ...(rows.length > query.limit && last !== undefined
        ? { next: { post_id: last.post_id, observed_at: last.observed_at, id: last.id } }
        : {}),
    };
  }

  /** Read one bounded source batch. Advance by the last scanned observation even
   * when none is publishable yet; activation later recovers its retained history. */
  changed(options: {
    changedSegments: readonly string[];
    previousChangedSegments: readonly string[];
    baseSegments: readonly string[];
    boundary: HistoricalBoundary;
    selection: HistoricalSelection;
    since: string;
    after?: ObservationPosition;
    limit: number;
  }): { observations: ConsumerObservation[]; scanned?: ObservationPosition; hasMore: boolean } {
    const changed = z.array(z.string().min(1)).max(128).parse(options.changedSegments);
    const previousChanged = z.array(z.string().min(1)).parse(options.previousChangedSegments);
    const since = z.iso.datetime().parse(options.since);
    const limit = Math.min(100, z.number().int().min(1).max(500).parse(options.limit));
    const after = options.after ?? { post_id: "", observed_at: "", id: "" };
    // Snapshot boundaries contain tens of thousands of segment keys. Materialize each
    // boundary once instead of rescanning json_each for every candidate observation.
    const rows = this.database
      .prepare(
        `WITH base_keys(key) AS MATERIALIZED (SELECT value FROM json_each(@base)),
    previous_keys(key) AS MATERIALIZED (SELECT value FROM json_each(@previous_changed)),
    target_keys(key) AS MATERIALIZED (SELECT value FROM json_each(@target)),
    new_ids AS MATERIALIZED (
      SELECT DISTINCT s.observation_id FROM observation_sources s
      WHERE s.segment_key IN (SELECT value FROM json_each(@changed))
        AND NOT EXISTS (SELECT 1 FROM observation_sources old JOIN base_keys b ON b.key = old.segment_key
          WHERE old.observation_id = s.observation_id)
        AND NOT EXISTS (SELECT 1 FROM observation_sources processed JOIN previous_keys p ON p.key = processed.segment_key
          WHERE processed.observation_id = s.observation_id)
    ), samples AS MATERIALIZED (
      SELECT o.*, s.source_ref, s.received_at AS source_received_at,
        ROW_NUMBER() OVER (PARTITION BY o.observation_id ORDER BY s.received_at, s.source_ref) AS copy
      FROM new_ids n CROSS JOIN post_observations o ON o.observation_id = n.observation_id
      CROSS JOIN observation_sources s ON s.observation_id = o.observation_id
      CROSS JOIN target_keys t ON t.key = s.segment_key
      CROSS JOIN post_content_versions c ON c.content_hash = o.content_hash
      WHERE ${PUBLIC_SAMPLE} AND o.observed_at >= @since
        AND (o.post_id, o.observed_at, o.observation_id) > (@post, @at, @id)
    ) SELECT payload_json, source_ref, source_received_at AS received_at FROM samples WHERE copy = 1
      ORDER BY post_id, observed_at, observation_id LIMIT @limit`,
      )
      .all({
        changed: JSON.stringify(changed),
        previous_changed: JSON.stringify(previousChanged),
        base: JSON.stringify(options.baseSegments),
        target: JSON.stringify(options.boundary.segments),
        since,
        authors: JSON.stringify(options.selection.authorIds ?? []),
        post: after.post_id,
        at: after.observed_at,
        id: after.id,
        limit: limit + 1,
      });
    const scanned = rows.slice(0, limit).map(parseObservation);
    const allowed = this.access.permitted(
      [...new Set(scanned.map((row) => row.post_id))],
      options.boundary,
      options.selection,
    );
    const last = scanned.at(-1);
    return {
      observations: scanned.filter((row) => allowed.has(row.post_id)),
      hasMore: rows.length > limit,
      ...(last === undefined
        ? {}
        : { scanned: { post_id: last.post_id, observed_at: last.observed_at, id: last.id } }),
    };
  }

  private coverage(
    query: z.infer<typeof requestSchema>,
    permitted: ReadonlySet<string>,
    boundary: HistoricalBoundary,
    authorIds: readonly string[],
  ): ObservationCoverage[] {
    const rows = this.database
      .prepare(
        `SELECT o.post_id, COUNT(*) AS count, MIN(o.observed_at) AS earliest, MAX(o.observed_at) AS latest
      FROM post_observations o JOIN post_content_versions c ON c.content_hash = o.content_hash
      WHERE ${PUBLIC_SAMPLE} AND o.post_id IN (SELECT value FROM json_each(@posts))
      AND o.observed_at >= @since AND o.observed_at < @until
      AND EXISTS (SELECT 1 FROM observation_sources s INDEXED BY idx_observation_source_id WHERE s.observation_id = o.observation_id
                  AND s.segment_key IN (SELECT value FROM json_each(@keys))) GROUP BY o.post_id`,
      )
      .all({
        posts: JSON.stringify([...permitted]),
        keys: JSON.stringify(boundary.segments),
        authors: JSON.stringify(authorIds),
        since: query.since,
        until: query.until,
      });
    const counts = new Map(
      rows.map((row) => {
        const parsed = coverageSchema.parse(row);
        return [parsed.post_id, parsed];
      }),
    );
    return query.postIds.map((post_id) => {
      const row = counts.get(post_id);
      if (!permitted.has(post_id))
        return { post_id, state: "unavailable", count: null, earliest: null, latest: null };
      if (row === undefined)
        return { post_id, state: "no_history", count: 0, earliest: null, latest: null };
      return { ...row, state: "available" };
    });
  }
}

function parseObservation(row: unknown): ConsumerObservation {
  const parsed = storedSchema.parse(row);
  const observation = observationSchema.parse(JSON.parse(parsed.payload_json));
  return consumerObservationSchema.parse({
    ...observation,
    received_at: parsed.received_at,
    source_ref: parsed.source_ref,
  });
}
