import type Database from "better-sqlite3";
import { z } from "zod";
import type { ResolvedConsumerContext } from "./consumer-context.js";
import { ConsumerHttpError } from "./consumer-errors.js";
import { removalPositionSchema } from "./consumer-cursor.js";

export const consumerRemovalSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("post_remove"),
      post_id: z.string(),
      reason: z.literal("not_available"),
    })
    .strict(),
  z
    .object({
      type: z.literal("unit_remove"),
      unit_id: z.string(),
      post_id: z.string(),
      reason: z.literal("not_available"),
    })
    .strict(),
]);
export const reconciliationPageSchema = z.object({
  removals: z.array(consumerRemovalSchema).max(500),
  next: removalPositionSchema.optional(),
});

const restricted = (column: string) => `(
  (json_type(${column}, '$.is_subscriber_only') IS NOT NULL AND json_type(${column}, '$.is_subscriber_only') <> 'false')
  OR (json_type(${column}, '$.is_retweet') IS NOT NULL AND json_type(${column}, '$.is_retweet') <> 'false')
  OR json_extract(${column}, '$.author.id') IS NULL
  OR json_extract(${column}, '$.author.id') NOT IN (SELECT value FROM json_each(@authors)))`;

/** Immutable source effects, never historical bodies. A restriction event remains in
 * its fixed range even if a later source restores the post while removal pages run. */
export class ConsumerPrivacyEffects {
  private readonly parameters: {
    baseline: string;
    through: string | null;
    exposed: string;
    authors: string;
  };
  constructor(
    private readonly database: Database.Database,
    baseline: readonly ResolvedConsumerContext[],
    exposed: readonly ResolvedConsumerContext[],
    through?: ResolvedConsumerContext,
  ) {
    this.parameters = {
      baseline: keys(baseline),
      through: through === undefined ? null : keys([through]),
      exposed: keys(exposed),
      authors: JSON.stringify(exposed[0]?.context.selection.author_ids ?? []),
    };
  }

  private cte(): string {
    return `WITH additions AS MATERIALIZED (
      SELECT key FROM source_segments
      WHERE key NOT IN (SELECT value FROM json_each(@baseline))
        AND (@through IS NULL OR key IN (SELECT value FROM json_each(@through)))
    ), withdrawn AS MATERIALIZED (
      SELECT DISTINCT o.post_id FROM additions a
      CROSS JOIN observation_sources s ON s.segment_key = a.key
      CROSS JOIN post_observations o ON o.observation_id = s.observation_id
      CROSS JOIN post_content_versions c ON c.content_hash = o.content_hash
      WHERE ${restricted("c.payload_json")}
      AND EXISTS (SELECT 1 FROM consumer_post_units u JOIN observation_sources os ON os.source_ref = u.source_ref
        WHERE u.post_id = o.post_id AND u.author_id IN (SELECT value FROM json_each(@authors))
          AND os.segment_key IN (SELECT value FROM json_each(@exposed)))
    )`;
  }

  assertUnchanged(): void {
    if (
      this.database
        .prepare(`${this.cte()} SELECT 1 FROM withdrawn LIMIT 1`)
        .get(this.parameters) !== undefined
    )
      throw new ConsumerHttpError(
        409,
        "privacy_changed",
        "Apply the affected removals before resuming this page.",
      );
  }

  page(
    limit: number,
    after?: z.infer<typeof removalPositionSchema>,
  ): z.infer<typeof reconciliationPageSchema> {
    const rows = this.database
      .prepare(
        `${this.cte()}, removals AS (
      SELECT post_id, '' AS unit_id FROM withdrawn
      UNION
      SELECT w.post_id, u.unit_id FROM withdrawn w
      JOIN consumer_post_units u ON u.post_id = w.post_id
      JOIN observation_sources s ON s.source_ref = u.source_ref
      WHERE s.segment_key IN (SELECT value FROM json_each(@exposed))
    ) SELECT post_id, unit_id FROM removals
      WHERE (post_id, unit_id) > (@post, @unit) ORDER BY post_id, unit_id LIMIT @limit`,
      )
      .all({
        ...this.parameters,
        post: after?.post_id ?? "",
        unit: after?.unit_id ?? "",
        limit: limit + 1,
      })
      .map((row) => removalPositionSchema.parse(row));
    const selected = rows.slice(0, limit);
    return {
      removals: selected.map((row) =>
        row.unit_id === ""
          ? { type: "post_remove" as const, post_id: row.post_id, reason: "not_available" as const }
          : { type: "unit_remove" as const, ...row, reason: "not_available" as const },
      ),
      ...(rows.length > limit ? { next: selected.at(-1) } : {}),
    };
  }

  /** A removal can outlive its public source version. Re-emit only affected units
   * if the next content comparison would otherwise suppress a same-hash restore. */
  restoredUnits(after: string | undefined, limit: number): string[] {
    return this.database
      .prepare(
        `${this.cte()} SELECT DISTINCT u.unit_id FROM withdrawn w
      JOIN consumer_post_units u ON u.post_id = w.post_id
      JOIN observation_sources s ON s.source_ref = u.source_ref
      WHERE s.segment_key IN (SELECT value FROM json_each(@exposed)) AND u.unit_id > @after
        AND EXISTS (SELECT 1 FROM tweets t WHERE t.id = w.post_id)
        AND NOT EXISTS (SELECT 1 FROM tweets t WHERE t.id = w.post_id AND ${restricted("t.json")})
      ORDER BY u.unit_id LIMIT @limit`,
      )
      .all({ ...this.parameters, after: after ?? "", limit })
      .map((row) => z.object({ unit_id: z.string() }).parse(row).unit_id);
  }

  includes(postIds: readonly string[]): boolean {
    return (
      this.database
        .prepare(
          `${this.cte()} SELECT 1 FROM withdrawn
      WHERE post_id IN (SELECT value FROM json_each(@posts)) LIMIT 1`,
        )
        .get({ ...this.parameters, posts: JSON.stringify(postIds) }) !== undefined
    );
  }
}
function keys(contexts: readonly ResolvedConsumerContext[]): string {
  return JSON.stringify([
    ...new Set(contexts.flatMap((context) => context.snapshot.files.map((file) => file.key))),
  ]);
}
