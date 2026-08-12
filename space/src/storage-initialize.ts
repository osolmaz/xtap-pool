import { BucketLog, createRawBucketClient } from "./bucket-log.js";
import { DEFAULT_TAXONOMY } from "./enrich-config.js";

export type StorageInitializationResult =
  { initialized: false } | { initialized: true; segment: string };

/** Write canonical configuration only when the transaction log is empty. */
export async function initializeRawStorage(options: {
  rawBucket: string;
  token: string;
  members: readonly string[];
  admins: readonly string[];
  workDir: string;
  now?: () => Date;
}): Promise<StorageInitializationResult> {
  const now = options.now ?? (() => new Date());
  const client = createRawBucketClient(options.rawBucket, options.token);
  const existing = await client.list("v1/segments");
  const log = new BucketLog(options.rawBucket, client, options.workDir, now);
  if (existing.length > 0) {
    const configurations = await Promise.all(
      [
        "config/pool.json",
        "config/service-accounts.json",
        "config/labels.json",
        "enrichment/vocabulary.json",
      ].map((path) => log.readText(path)),
    );
    if (configurations.every((content) => content !== undefined)) return { initialized: false };
    throw new Error("existing raw Bucket transaction log has incomplete configuration");
  }
  const timestamp = now().toISOString();
  const segment = await log.commitBatch(
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
  return { initialized: true, segment };
}
