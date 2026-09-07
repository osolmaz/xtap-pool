import type Database from "better-sqlite3";
import { z } from "zod";
import { enrichmentRowSchema } from "@xtap-pool/shared";
import type { EnrichmentRow } from "@xtap-pool/shared";
import type { EnrichStore } from "./enrich-store.js";

const candidateSchema = z.object({
  unit_id: z.string(),
  payload_json: z.string(),
  position: z.number().int().positive(),
});
const MAX_CANDIDATES = 50;
type ResultSource = {
  database: Database.Database;
  enrich: EnrichStore;
  sourceKeys?: string;
};

/** Use the newest applicable raw result, just as ordered replay does. An invalid
 * later quote must not erase a valid result; exact input reverts can reuse it. */
export function recordedResult(
  options: ResultSource & { unitId: string; inputHash: string },
): EnrichmentRow | undefined {
  return recordedResults({
    ...options,
    requests: [{ unit_id: options.unitId, input_hash: options.inputHash }],
  }).get(options.unitId);
}

/** Share one exact source-membership lookup across a bounded unit slice. */
export function recordedResults(
  options: ResultSource & { requests: readonly { unit_id: string; input_hash: string }[] },
): Map<string, EnrichmentRow> {
  const requests = z
    .array(z.object({ unit_id: z.string(), input_hash: z.string() }))
    .max(200)
    .parse(options.requests);
  const results = new Map<string, EnrichmentRow>();
  if (requests.length === 0) return results;
  // Unary + prevents the second index column from driving an IN loop over every
  // segment for each result. Keys are strings; exact membership is unchanged.
  const rows = options.database
    .prepare(
      `WITH requested AS MATERIALIZED (
      SELECT json_extract(value, '$.unit_id') AS unit_id,
        json_extract(value, '$.input_hash') AS input_hash FROM json_each(@requests)
    ), candidates AS (
      SELECT r.unit_id, r.payload_json, ROW_NUMBER() OVER (
        PARTITION BY r.unit_id ORDER BY r.enriched_at DESC, r.result_hash DESC
      ) AS position FROM requested q CROSS JOIN consumer_results r
        ON r.unit_id = q.unit_id AND r.contract_hash = @contract AND r.input_hash = q.input_hash
      WHERE (@keys IS NULL OR EXISTS (
        SELECT 1 FROM consumer_result_sources s INDEXED BY idx_consumer_result_source_hash
        WHERE s.result_hash = r.result_hash AND +s.segment_key IN (SELECT value FROM json_each(@keys))))
    ) SELECT unit_id, payload_json, position FROM candidates
      WHERE position <= @limit ORDER BY unit_id, position`,
    )
    .iterate({
      requests: JSON.stringify(requests),
      contract: options.enrich.currentContractHash(),
      keys: options.sourceKeys ?? null,
      limit: MAX_CANDIDATES + 1,
    });
  for (const candidate of rows) {
    const parsed = candidateSchema.parse(candidate);
    if (results.has(parsed.unit_id)) continue;
    if (parsed.position > MAX_CANDIDATES)
      throw new Error("recorded result validation exceeds its candidate bound");
    const row = enrichmentRowSchema.parse(JSON.parse(parsed.payload_json));
    if (options.enrich.matchesCurrentUnit(row)) results.set(parsed.unit_id, row);
  }
  return results;
}
