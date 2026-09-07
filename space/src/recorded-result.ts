import type Database from "better-sqlite3";
import { z } from "zod";
import { enrichmentRowSchema } from "@xtap-pool/shared";
import type { EnrichmentRow } from "@xtap-pool/shared";
import type { EnrichStore } from "./enrich-store.js";

const payloadSchema = z.object({ payload_json: z.string() });
const MAX_CANDIDATES = 50;

/** Use the newest applicable raw result, just as ordered replay does. An invalid
 * later quote must not erase a valid result; exact input reverts can reuse it. */
export function recordedResult(options: {
  database: Database.Database;
  enrich: EnrichStore;
  unitId: string;
  inputHash: string;
  sourceKeys?: string;
}): EnrichmentRow | undefined {
  const rows = options.database
    .prepare(
      `SELECT r.payload_json FROM consumer_results r
    WHERE r.unit_id = @unit AND r.contract_hash = @contract AND r.input_hash = @input
      AND (@keys IS NULL OR EXISTS (SELECT 1 FROM consumer_result_sources s WHERE s.result_hash = r.result_hash
        AND s.segment_key IN (SELECT value FROM json_each(@keys))))
    ORDER BY r.enriched_at DESC, r.result_hash DESC LIMIT @limit`,
    )
    .all({
      unit: options.unitId,
      contract: options.enrich.currentContractHash(),
      input: options.inputHash,
      keys: options.sourceKeys ?? null,
      limit: MAX_CANDIDATES + 1,
    });
  for (const candidate of rows.slice(0, MAX_CANDIDATES)) {
    const row = enrichmentRowSchema.parse(JSON.parse(payloadSchema.parse(candidate).payload_json));
    if (options.enrich.matchesCurrentUnit(row)) return row;
  }
  if (rows.length > MAX_CANDIDATES)
    throw new Error("recorded result validation exceeds its candidate bound");
  return undefined;
}
