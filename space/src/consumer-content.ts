import { createHash } from "node:crypto";
import { canonicalJson, tweetContent } from "@xtap-pool/shared";
import type { EnrichedUnit } from "@xtap-pool/shared";

/** Only published content affects replacement. Observations and pool attribution do not. */
export function consumerUnitContent(unit: EnrichedUnit) {
  return {
    id: unit.id,
    posts: [...unit.posts].sort((a, b) => compare(a.id, b.id)).map(tweetContent),
    preset_labels: [...unit.preset_labels].sort((a, b) => compare(a.name, b.name)),
    free_labels: [...unit.free_labels].sort((a, b) => compare(a.name, b.name)),
  };
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function consumerUnitHash(unit: EnrichedUnit): string {
  return createHash("sha256")
    .update(canonicalJson(consumerUnitContent(unit)))
    .digest("hex");
}
