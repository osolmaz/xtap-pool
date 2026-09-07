import { createHash } from "node:crypto";
import { canonicalJson } from "@xtap-pool/shared";
import type { EnrichmentRow } from "@xtap-pool/shared";

/** Stable tie-breaker shared by current and historical result selection. */
export function resultIdentity(row: EnrichmentRow): {
  row: EnrichmentRow;
  json: string;
  hash: string;
} {
  const normalized = { ...row, enriched_at: new Date(row.enriched_at).toISOString() };
  const json = canonicalJson(normalized);
  return { row: normalized, json, hash: createHash("sha256").update(json).digest("hex") };
}
