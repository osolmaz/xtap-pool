import type Database from "better-sqlite3";
import { z } from "zod";
import type { EnrichedUnit } from "@xtap-pool/shared";
import { HistoricalUnitReader } from "./historical-unit-reader.js";
import type { HistoricalBoundary, HistoricalSelection } from "./historical-unit-reader.js";

const idsSchema = z.array(z.string().min(1)).max(100);
const unitRowSchema = z.object({ unit_id: z.string() });
const publicRowSchema = z.object({ id: z.string(), original: z.number().int() });
function absentOrFalse(value: unknown): boolean {
  return value === undefined || value === false;
}

/** Recheck authorization on every history/cached page. A pinned old public copy
 * must not bypass a newer subscriber-only or author-scope restriction. */
export class ConsumerPostAccess {
  private readonly reader: HistoricalUnitReader;
  constructor(
    private readonly database: Database.Database,
    taxonomyVersion: number,
    contractHash: string,
  ) {
    this.reader = new HistoricalUnitReader(database, taxonomyVersion, contractHash);
  }

  permitted(
    postIds: readonly string[],
    boundary: HistoricalBoundary,
    selection: HistoricalSelection,
  ): Set<string> {
    const ids = idsSchema.parse(postIds);
    if (ids.length === 0) return new Set();
    const rows = this.database
      .prepare(
        `SELECT DISTINCT u.unit_id FROM consumer_post_units u
      JOIN observation_sources s ON s.source_ref = u.source_ref
      WHERE u.post_id IN (SELECT value FROM json_each(@posts))
        AND s.segment_key IN (SELECT value FROM json_each(@keys)) ORDER BY u.unit_id LIMIT 201`,
      )
      .all({ posts: JSON.stringify(ids), keys: JSON.stringify(boundary.segments) });
    if (rows.length > 200) throw new Error("post history exceeds the unit membership bound");
    const units = this.reader.read(
      rows.map((row) => unitRowSchema.parse(row).unit_id),
      boundary,
      selection,
    );
    const members = [...new Set(units.flatMap((unit) => unit.posts.map((post) => post.id)))];
    const current = this.currentPublic(members, selection.authorIds ?? []);
    const wanted = new Set(ids);
    const visible = units.filter((unit) =>
      unit.posts.every((post) => current.has(post.id) && absentOrFalse(post["is_subscriber_only"])),
    );
    return new Set(
      visible.flatMap((unit) =>
        unit.posts
          .filter(
            (post) =>
              wanted.has(post.id) &&
              absentOrFalse(post["is_retweet"]) &&
              current.get(post.id) === 1,
          )
          .map((post) => post.id),
      ),
    );
  }

  canPublish(unit: EnrichedUnit, selection: HistoricalSelection): boolean {
    const current = this.currentPublic(
      unit.posts.map((post) => post.id),
      selection.authorIds ?? [],
    );
    return (
      unit.posts.every(
        (post) => current.has(post.id) && absentOrFalse(post["is_subscriber_only"]),
      ) &&
      unit.posts.some((post) => absentOrFalse(post["is_retweet"]) && current.get(post.id) === 1)
    );
  }

  private currentPublic(ids: readonly string[], authors: readonly string[]): Map<string, number> {
    if (ids.length > 2000) throw new Error("post history exceeds the current privacy-check bound");
    const rows = this.database
      .prepare(
        `SELECT tweet_id AS id, CASE WHEN is_retweet = 0 THEN 1 ELSE 0 END AS original
      FROM unit_members
      WHERE tweet_id IN (SELECT value FROM json_each(@ids))
        AND is_subscriber_only = 0
        AND author_id IN (SELECT value FROM json_each(@authors))`,
      )
      .all({ ids: JSON.stringify(ids), authors: JSON.stringify(authors) });
    return new Map(
      rows.map((row) => {
        const parsed = publicRowSchema.parse(row);
        return [parsed.id, parsed.original];
      }),
    );
  }
}
