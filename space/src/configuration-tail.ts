import type { BucketLog, BucketSnapshot } from "./bucket-log.js";

/** Inspect only newly verified segments. Mixed append batches are not config writes. */
export async function hasConfigurationWrites(
  log: Pick<BucketLog, "loadSegment">,
  base: BucketSnapshot,
  target: BucketSnapshot,
): Promise<boolean> {
  const known = new Set(base.files.map((file) => file.key));
  for (const file of target.files) {
    if (known.has(file.key)) continue;
    if (!file.key.includes("/config/") && !file.key.includes("/mixed/")) continue;
    const segment = await log.loadSegment(file);
    if (segment.operations.some((operation) => operation.mode === "write")) return true;
  }
  return false;
}
