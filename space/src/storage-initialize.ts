import { BucketLog, createRawBucketClient } from "./bucket-log.js";
import { DEFAULT_TAXONOMY } from "./enrich-config.js";

/** Write the complete canonical configuration for a confirmed new empty pool. */
export async function initializeRawStorage(options: {
  rawBucket: string;
  token: string;
  members: readonly string[];
  admins: readonly string[];
  workDir: string;
  now?: () => Date;
}): Promise<string> {
  const now = options.now ?? (() => new Date());
  const log = new BucketLog(
    options.rawBucket,
    createRawBucketClient(options.rawBucket, options.token),
    options.workDir,
    now,
  );
  const timestamp = now().toISOString();
  return log.commitBatch(
    [],
    [
      {
        path: "config/pool.json",
        content: `${JSON.stringify({
          version: 1,
          admins: [...new Set(options.admins)].sort(),
          members: [...new Set([...options.members, ...options.admins])].sort(),
          member_orgs: [],
          updated_at: timestamp,
          updated_by: "setup",
        })}\n`,
      },
      { path: "config/service-accounts.json", content: '{"version":1,"accounts":[]}\n' },
      { path: "config/labels.json", content: `${JSON.stringify(DEFAULT_TAXONOMY)}\n` },
      { path: "enrichment/vocabulary.json", content: '{"version":1,"labels":[]}\n' },
    ],
    "Initialize raw pool configuration",
  );
}
