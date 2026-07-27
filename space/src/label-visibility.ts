import type Database from "better-sqlite3";

import type { LabelAssignment } from "@xtap-pool/shared";

/**
 * Read the public-visible assignments (preset labels always, free labels only
 * when the registry marks them `approved`) for the given unit IDs. Returns a
 * map keyed by unit_id. Shared by the read model (`UnitStore.hydrate`) and
 * the internal store helper so the visibility rule is defined in exactly one
 * SQL query.
 */
export function readVisibleAssignments(
  db: Database.Database,
  unitIds: readonly string[],
): Map<string, { preset_labels: LabelAssignment[]; free_labels: LabelAssignment[] }> {
  const result = new Map<
    string,
    { preset_labels: LabelAssignment[]; free_labels: LabelAssignment[] }
  >();
  if (unitIds.length === 0) return result;
  const placeholders = unitIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.unit_id, a.name, a.kind, e.tweet_id, e.quote
       FROM label_assignments a
       LEFT JOIN label_evidence e ON e.unit_id = a.unit_id AND e.name = a.name AND e.kind = a.kind
       LEFT JOIN free_label_registry r ON r.name = a.name
       WHERE a.unit_id IN (${placeholders})
         AND (a.kind = 'preset' OR (a.kind = 'free' AND r.status = 'approved'))
       ORDER BY a.unit_id, a.kind, a.name, e.tweet_id`,
    )
    .all(...unitIds) as {
    unit_id: string;
    name: string;
    kind: "preset" | "free";
    tweet_id: string | null;
    quote: string | null;
  }[];
  for (const row of rows) {
    const bucket = result.get(row.unit_id) ?? {
      preset_labels: [] as LabelAssignment[],
      free_labels: [] as LabelAssignment[],
    };
    const list = row.kind === "preset" ? bucket.preset_labels : bucket.free_labels;
    let assignment = list.find((entry) => entry.name === row.name);
    if (assignment === undefined) {
      assignment = { name: row.name, evidence: [] };
      list.push(assignment);
    }
    if (row.tweet_id !== null && row.quote !== null) {
      (assignment.evidence as { tweet_id: string; quote: string }[]).push({
        tweet_id: row.tweet_id,
        quote: row.quote,
      });
    }
    result.set(row.unit_id, bucket);
  }
  return result;
}
