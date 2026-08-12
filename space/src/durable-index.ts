import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, openAsBlob } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import Database from "better-sqlite3";
import { deleteFiles, downloadFile, listFiles, uploadFile } from "@huggingface/hub";
import { z } from "zod";

import { BucketLog } from "./bucket-log.js";
import type { BucketSnapshotFile, SourceCounts } from "./bucket-log.js";
import { EnrichStore } from "./enrich-store.js";
import { TweetStore } from "./store.js";

const INDEX_SCHEMA_VERSION = 1;
const CURRENT_MANIFEST_KEY = "index/current.json";
const DATABASE_PREFIX = "index/databases";
const RETAINED_PREDECESSORS = 3;
const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/u;
const DATABASE_KEY = /^index\/databases\/([a-f0-9]{64})\.sqlite$/u;

const indexCountsSchema = z
  .object({
    tweets: z.number().int().nonnegative(),
    units: z.number().int().nonnegative(),
    enrichments: z.number().int().nonnegative(),
    attempt_events: z.number().int().nonnegative(),
    registry_events: z.number().int().nonnegative(),
    receipts: z.number().int().nonnegative(),
  })
  .strict();

export const durableIndexManifestSchema = z
  .object({
    schema_version: z.literal(INDEX_SCHEMA_VERSION),
    source: z.object({ bucket: z.string().min(3), revision: z.string().regex(SHA256) }).strict(),
    projection: z.object({ contract_hash: z.string().regex(SHA256) }).strict(),
    database: z
      .object({
        key: z.string().regex(DATABASE_KEY),
        sha256: z.string().regex(SHA256),
        predecessors: z.array(z.string().regex(DATABASE_KEY)).max(RETAINED_PREDECESSORS),
      })
      .strict(),
    counts: indexCountsSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.database.key !== `${DATABASE_PREFIX}/${manifest.database.sha256}.sqlite`) {
      context.addIssue({
        code: "custom",
        path: ["database", "key"],
        message: "database key must match its checksum",
      });
    }
    const keys = [manifest.database.key, ...manifest.database.predecessors];
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["database", "predecessors"],
        message: "database keys must be unique",
      });
    }
  });

export type DurableIndexManifest = z.infer<typeof durableIndexManifestSchema>;
export type DurableIndexCounts = z.infer<typeof indexCountsSchema>;
export type IndexAdvance = {
  revision: string;
  filesChanged: number;
  rowsApplied: number;
  counts: DurableIndexCounts;
};
export type DurableIndexStats = {
  tweetFiles: number;
  tweetRows: number;
  enrichmentFiles: number;
  enrichmentRows: number;
  attemptEvents: number;
  registryEvents: number;
  receipts: number;
};
export type BucketFile = { path: string; uploadedAt?: string };

export type DurableIndexBucketClient = {
  download(path: string, destination: string): Promise<boolean>;
  uploadFile(path: string, source: string): Promise<void>;
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, content: string): Promise<void>;
  list(prefix: string): Promise<readonly BucketFile[]>;
  remove(paths: readonly string[]): Promise<void>;
};

export type DurableIndexOptions = {
  rawBucket: string;
  indexBucket: string;
  accessToken: string;
  databasePath: string;
  log: BucketLog;
  taxonomyVersion: number;
  contractHash: string;
  bucketClient?: DurableIndexBucketClient;
  predecessorKeys?: readonly string[];
};

type MetadataRow = {
  schema_version: number;
  raw_bucket: string;
  raw_snapshot_revision: string;
  contract_hash: string;
};
type SegmentRow = {
  key: string;
  oid: string;
  listed_oid: string | null;
  byte_length: number;
  content_sha256: string;
  tweet_rows: number;
  enrichment_rows: number;
  attempt_rows: number;
  registry_rows: number;
  receipt_rows: number;
};

/** Verified SQLite projection of one exact immutable raw Bucket snapshot. */
export class DurableIndex {
  readonly store: TweetStore;
  readonly enrichStore: EnrichStore;

  constructor(
    private readonly options: DurableIndexOptions,
    private readonly bucket: DurableIndexBucketClient,
    store: TweetStore,
    enrichStore: EnrichStore,
    private publishedKeys: string[],
  ) {
    this.store = store;
    this.enrichStore = enrichStore;
  }

  static async restore(options: DurableIndexOptions): Promise<DurableIndex> {
    const bucket =
      options.bucketClient ??
      createDurableIndexBucketClient(options.indexBucket, options.accessToken);
    const rawManifest = await bucket.readText(CURRENT_MANIFEST_KEY);
    if (rawManifest === undefined)
      throw new Error("durable index manifest is missing; run index bootstrap");
    const manifest = parseManifest(rawManifest, options);
    await mkdir(dirname(options.databasePath), { recursive: true });
    const staged = `${options.databasePath}.${randomUUID()}.download`;
    try {
      if (!(await bucket.download(manifest.database.key, staged))) {
        throw new Error(`durable index database is missing: ${manifest.database.key}`);
      }
      await assertFileSha256(staged, manifest.database.sha256);
      validateStandaloneDatabase(staged, manifest, options);
      await removeDatabaseFiles(options.databasePath);
      await rename(staged, options.databasePath);
    } finally {
      await rm(staged, { force: true });
    }
    const snapshot = await options.log.loadSnapshot(manifest.source.revision);
    await options.log.hydrateMetadata(snapshot);
    return open(options, bucket, [manifest.database.key, ...manifest.database.predecessors]);
  }

  static async bootstrap(options: DurableIndexOptions): Promise<DurableIndex> {
    const bucket =
      options.bucketClient ??
      createDurableIndexBucketClient(options.indexBucket, options.accessToken);
    await mkdir(dirname(options.databasePath), { recursive: true });
    await removeDatabaseFiles(options.databasePath);
    const index = open(options, bucket, []);
    await index.advanceToLatest();
    return index;
  }

  static openLocal(options: DurableIndexOptions): DurableIndex {
    if (!existsSync(options.databasePath))
      throw new Error(`durable index working database is missing: ${options.databasePath}`);
    const bucket =
      options.bucketClient ??
      createDurableIndexBucketClient(options.indexBucket, options.accessToken);
    const index = open(options, bucket, [...(options.predecessorKeys ?? [])]);
    const metadata = readMetadata(index.store.database);
    if (
      metadata?.schema_version !== INDEX_SCHEMA_VERSION ||
      metadata.raw_bucket !== options.rawBucket ||
      metadata.contract_hash !== options.contractHash
    ) {
      index.close();
      throw new Error("durable index working database provenance mismatch");
    }
    assertDatabaseIntegrity(index.store.database);
    return index;
  }

  async advanceToLatest(): Promise<IndexAdvance> {
    const previous = sourceRows(this.store.database);
    const { revision, snapshot } = await this.options.log.discoverSnapshot(
      [...previous.values()].map(snapshotFileFromRow),
    );
    return this.advanceToSnapshot(revision, snapshot, previous, false);
  }

  async advanceToRevision(revision: string): Promise<IndexAdvance> {
    const snapshot = await this.options.log.loadSnapshot(revision);
    const previous = sourceRows(this.store.database);
    return this.advanceToSnapshot(revision, snapshot, previous, true);
  }

  private async advanceToSnapshot(
    revision: string,
    snapshot: Awaited<ReturnType<BucketLog["loadSnapshot"]>>,
    previous: ReadonlyMap<string, SegmentRow>,
    verifyKnown: boolean,
  ): Promise<IndexAdvance> {
    const currentKeys = new Set(snapshot.files.map((file) => file.key));
    const deleted = [...previous.keys()].filter((key) => !currentKeys.has(key));
    if (deleted.length > 0)
      throw new Error(`raw Bucket source segments were deleted: ${deleted.slice(0, 3).join(", ")}`);

    const staged: {
      file: BucketSnapshotFile;
      segment: Awaited<ReturnType<BucketLog["loadSegment"]>>;
    }[] = [];
    for (const file of snapshot.files) {
      const old = previous.get(file.key);
      if (old !== undefined) {
        assertSameSourceFile(old, file);
        if (verifyKnown) await this.options.log.loadSegment(file);
        continue;
      }
      staged.push({ file, segment: await this.options.log.loadSegment(file) });
    }

    staged.sort(compareReplayOrder);
    let rowsApplied = 0;
    const apply = this.store.database.transaction(() => {
      for (const item of staged) {
        const counts = this.options.log.applySegment(item.segment, this.store, this.enrichStore);
        rowsApplied += totalSourceRows(counts);
        insertSourceRow(this.store.database, item.file, counts);
      }
      writeMetadata(this.store.database, {
        schema_version: INDEX_SCHEMA_VERSION,
        raw_bucket: this.options.rawBucket,
        raw_snapshot_revision: revision,
        contract_hash: this.options.contractHash,
      });
    });
    apply();
    assertDatabaseIntegrity(this.store.database);
    return {
      revision,
      filesChanged: staged.length,
      rowsApplied,
      counts: databaseCounts(this.store.database),
    };
  }

  async publishLatest(): Promise<{ advance: IndexAdvance; manifest: DurableIndexManifest }> {
    const advance = await this.advanceToLatest();
    return { advance, manifest: await this.publish() };
  }

  async publish(): Promise<DurableIndexManifest> {
    const baselineManifest = await this.bucket.readText(CURRENT_MANIFEST_KEY);
    const metadata = readMetadata(this.store.database);
    if (metadata === undefined) throw new Error("durable index metadata is missing");
    assertDatabaseIntegrity(this.store.database);
    const checkpoint = await this.options.log.storeSnapshot({
      schema_version: 1,
      bucket: this.options.rawBucket,
      files: [...sourceRows(this.store.database).values()]
        .map(snapshotFileFromRow)
        .sort((left, right) => left.key.localeCompare(right.key)),
    });
    if (checkpoint.revision !== metadata.raw_snapshot_revision) {
      throw new Error("durable index source revision does not match its checkpoint");
    }
    const counts = databaseCounts(this.store.database);
    const publishPath = `${this.options.databasePath}.${randomUUID()}.publish`;
    const verifyPath = `${this.options.databasePath}.${randomUUID()}.verify`;
    try {
      await this.store.database.backup(publishPath);
      const sha = await fileSha256(publishPath);
      const key = `${DATABASE_PREFIX}/${sha}.sqlite`;
      const predecessors = this.publishedKeys
        .filter((value) => value !== key)
        .slice(0, RETAINED_PREDECESSORS);
      const manifest: DurableIndexManifest = {
        schema_version: 1,
        source: { bucket: metadata.raw_bucket, revision: metadata.raw_snapshot_revision },
        projection: { contract_hash: metadata.contract_hash },
        database: { key, sha256: sha, predecessors },
        counts,
      };
      validateStandaloneDatabase(publishPath, manifest, this.options);
      await this.bucket.uploadFile(key, publishPath);
      if (!(await this.bucket.download(key, verifyPath)))
        throw new Error(`uploaded durable index database is unavailable: ${key}`);
      await assertFileSha256(verifyPath, sha);
      validateStandaloneDatabase(verifyPath, manifest, this.options);
      const beforeSwap = await this.bucket.readText(CURRENT_MANIFEST_KEY);
      if (beforeSwap !== baselineManifest) {
        throw new Error("durable index manifest changed during publication");
      }
      const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
      await this.bucket.writeText(CURRENT_MANIFEST_KEY, encoded);
      const stored = await this.bucket.readText(CURRENT_MANIFEST_KEY);
      if (
        stored === undefined ||
        JSON.stringify(parseManifest(stored, this.options)) !== JSON.stringify(manifest)
      ) {
        throw new Error("durable index manifest read-back did not match the published generation");
      }
      this.publishedKeys = [key, ...predecessors];
      await this.pruneDatabases(this.publishedKeys);
      return manifest;
    } finally {
      await Promise.all([rm(publishPath, { force: true }), rm(verifyPath, { force: true })]);
    }
  }

  stats(): DurableIndexStats {
    const count = (
      column: keyof Pick<
        SegmentRow,
        "tweet_rows" | "enrichment_rows" | "attempt_rows" | "registry_rows" | "receipt_rows"
      >,
    ): number =>
      (
        this.store.database
          .prepare(`SELECT COALESCE(SUM(${column}), 0) AS n FROM source_segments`)
          .get() as { n: number }
      ).n;
    const files = (column: "tweet_rows" | "enrichment_rows"): number =>
      (
        this.store.database
          .prepare(`SELECT COUNT(*) AS n FROM source_segments WHERE ${column} > 0`)
          .get() as { n: number }
      ).n;
    return {
      tweetFiles: files("tweet_rows"),
      tweetRows: count("tweet_rows"),
      enrichmentFiles: files("enrichment_rows"),
      enrichmentRows: count("enrichment_rows"),
      attemptEvents: count("attempt_rows"),
      registryEvents: count("registry_rows"),
      receipts: count("receipt_rows"),
    };
  }

  retainedDatabaseKeys(): readonly string[] {
    return [...this.publishedKeys];
  }

  async createWorkingCopy(path: string): Promise<void> {
    await rm(path, { force: true });
    await this.store.database.backup(path);
  }

  close(): void {
    this.store.close();
  }

  private async pruneDatabases(retained: readonly string[]): Promise<void> {
    const keep = new Set(retained);
    const activeRaw = await this.bucket.readText(CURRENT_MANIFEST_KEY);
    if (activeRaw === undefined) return;
    const active = parseManifest(activeRaw, this.options);
    keep.add(active.database.key);
    for (const key of active.database.predecessors) keep.add(key);
    const cutoff = Date.now() - PRUNE_GRACE_MS;
    const files = await this.bucket.list(DATABASE_PREFIX);
    const stale = files
      .filter((file) => DATABASE_KEY.test(file.path) && !keep.has(file.path))
      .filter((file) => file.uploadedAt !== undefined && Date.parse(file.uploadedAt) < cutoff)
      .map((file) => file.path);
    if (stale.length === 0) return;
    if ((await this.bucket.readText(CURRENT_MANIFEST_KEY)) !== activeRaw) return;
    await this.bucket.remove(stale);
  }
}

export function createDurableIndexBucketClient(
  indexBucket: string,
  accessToken: string,
): DurableIndexBucketClient {
  const repo = { type: "bucket", name: indexBucket } as const;
  return {
    async download(path, destination): Promise<boolean> {
      const blob = await downloadFile({ repo, accessToken, path });
      if (blob === null) return false;
      await mkdir(dirname(destination), { recursive: true });
      await pipeline(Readable.fromWeb(blob.stream()), createWriteStream(destination));
      return true;
    },
    async uploadFile(path, source): Promise<void> {
      await uploadFile({
        repo,
        accessToken,
        file: { path, content: await openAsBlob(source) },
        commitTitle: `Publish ${path}`,
      });
    },
    async readText(path): Promise<string | undefined> {
      const blob = await downloadFile({ repo, accessToken, path });
      return blob === null ? undefined : blob.text();
    },
    async writeText(path, content): Promise<void> {
      await uploadFile({
        repo,
        accessToken,
        file: { path, content: new Blob([content]) },
        commitTitle: `Publish ${path}`,
      });
    },
    async list(prefix): Promise<readonly BucketFile[]> {
      const files: BucketFile[] = [];
      for await (const entry of listFiles({
        repo,
        accessToken,
        recursive: true,
        path: prefix,
        expand: true,
      })) {
        if (entry.type === "file")
          files.push({
            path: entry.path,
            ...(entry.uploadedAt === undefined ? {} : { uploadedAt: entry.uploadedAt }),
          });
      }
      return files;
    },
    async remove(paths): Promise<void> {
      if (paths.length === 0) return;
      await deleteFiles({
        repo,
        accessToken,
        paths: [...paths],
        commitTitle: "Prune durable index generations",
      });
    },
  };
}

function open(
  options: DurableIndexOptions,
  bucket: DurableIndexBucketClient,
  keys: string[],
): DurableIndex {
  const store = new TweetStore(options.databasePath);
  const enrichStore = new EnrichStore(
    store.database,
    options.taxonomyVersion,
    () => new Date(),
    options.contractHash,
  );
  ensureIndexTables(store.database);
  return new DurableIndex(options, bucket, store, enrichStore, keys);
}

function parseManifest(
  raw: string,
  options: Pick<DurableIndexOptions, "rawBucket" | "contractHash">,
): DurableIndexManifest {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("durable index manifest is not valid JSON");
  }
  const manifest = durableIndexManifestSchema.parse(candidate);
  if (manifest.source.bucket !== options.rawBucket)
    throw new Error(`durable index raw Bucket mismatch: ${manifest.source.bucket}`);
  if (manifest.projection.contract_hash !== options.contractHash)
    throw new Error("durable index enrichment contract does not match the running code");
  return manifest;
}

function ensureIndexTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      raw_bucket TEXT NOT NULL,
      raw_snapshot_revision TEXT NOT NULL,
      contract_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_segments (
      key TEXT PRIMARY KEY,
      oid TEXT NOT NULL,
      listed_oid TEXT,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      content_sha256 TEXT NOT NULL,
      tweet_rows INTEGER NOT NULL CHECK (tweet_rows >= 0),
      enrichment_rows INTEGER NOT NULL CHECK (enrichment_rows >= 0),
      attempt_rows INTEGER NOT NULL CHECK (attempt_rows >= 0),
      registry_rows INTEGER NOT NULL CHECK (registry_rows >= 0),
      receipt_rows INTEGER NOT NULL CHECK (receipt_rows >= 0)
    );
  `);
}

function sourceRows(db: Database.Database): Map<string, SegmentRow> {
  const rows = db.prepare("SELECT * FROM source_segments").all() as SegmentRow[];
  return new Map(rows.map((row) => [row.key, row]));
}

function compareReplayOrder(
  left: { file: BucketSnapshotFile; segment: Awaited<ReturnType<BucketLog["loadSegment"]>> },
  right: { file: BucketSnapshotFile; segment: Awaited<ReturnType<BucketLog["loadSegment"]>> },
): number {
  const time = left.segment.created_at.localeCompare(right.segment.created_at);
  if (time !== 0) return time;
  const transaction = left.segment.transaction_id.localeCompare(right.segment.transaction_id);
  return transaction !== 0 ? transaction : left.file.key.localeCompare(right.file.key);
}

function snapshotFileFromRow(row: SegmentRow): BucketSnapshotFile {
  return {
    key: row.key,
    oid: row.oid,
    ...(row.listed_oid === null ? {} : { listed_oid: row.listed_oid }),
    size: row.byte_length,
    content_sha256: row.content_sha256,
  };
}

function assertSameSourceFile(row: SegmentRow, file: BucketSnapshotFile): void {
  if (
    row.oid !== file.oid ||
    row.listed_oid !== (file.listed_oid ?? null) ||
    row.byte_length !== file.size ||
    row.content_sha256 !== file.content_sha256
  ) {
    throw new Error(`raw Bucket source segment changed: ${file.key}`);
  }
}

function insertSourceRow(
  db: Database.Database,
  file: BucketSnapshotFile,
  counts: SourceCounts,
): void {
  db.prepare(
    `INSERT INTO source_segments
    (key, oid, listed_oid, byte_length, content_sha256, tweet_rows, enrichment_rows, attempt_rows, registry_rows, receipt_rows)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    file.key,
    file.oid,
    file.listed_oid ?? null,
    file.size,
    file.content_sha256,
    counts.tweet,
    counts.enrichment,
    counts.attempt,
    counts.registry,
    counts.receipt,
  );
}

function writeMetadata(db: Database.Database, metadata: MetadataRow): void {
  db.prepare(
    `INSERT INTO index_metadata
    (singleton, schema_version, raw_bucket, raw_snapshot_revision, contract_hash)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET schema_version=excluded.schema_version,
      raw_bucket=excluded.raw_bucket, raw_snapshot_revision=excluded.raw_snapshot_revision,
      contract_hash=excluded.contract_hash`,
  ).run(
    metadata.schema_version,
    metadata.raw_bucket,
    metadata.raw_snapshot_revision,
    metadata.contract_hash,
  );
}

function readMetadata(db: Database.Database): MetadataRow | undefined {
  return db
    .prepare(
      "SELECT schema_version, raw_bucket, raw_snapshot_revision, contract_hash FROM index_metadata WHERE singleton = 1",
    )
    .get() as MetadataRow | undefined;
}

function databaseCounts(db: Database.Database): DurableIndexCounts {
  const table = (name: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
  const source = (column: string): number =>
    (
      db.prepare(`SELECT COALESCE(SUM(${column}), 0) AS n FROM source_segments`).get() as {
        n: number;
      }
    ).n;
  return {
    tweets: table("tweets"),
    units: table("enrich_queue"),
    enrichments: table("enrichment"),
    attempt_events: source("attempt_rows"),
    registry_events: source("registry_rows"),
    receipts: source("receipt_rows"),
  };
}

function validateStandaloneDatabase(
  path: string,
  manifest: DurableIndexManifest,
  options: Pick<DurableIndexOptions, "rawBucket" | "contractHash">,
): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    assertDatabaseIntegrity(db);
    const metadata = readMetadata(db);
    if (
      metadata?.schema_version !== 1 ||
      metadata.raw_bucket !== options.rawBucket ||
      metadata.raw_snapshot_revision !== manifest.source.revision ||
      metadata.contract_hash !== options.contractHash
    )
      throw new Error("durable index database provenance mismatch");
    if (JSON.stringify(databaseCounts(db)) !== JSON.stringify(manifest.counts)) {
      throw new Error("durable index physical counts do not match the manifest");
    }
  } finally {
    db.close();
  }
}

function assertDatabaseIntegrity(db: Database.Database): void {
  const result = db.pragma("integrity_check") as { integrity_check: string }[];
  if (result.length !== 1 || result[0]?.integrity_check !== "ok")
    throw new Error("durable index SQLite integrity check failed");
}

function totalSourceRows(counts: SourceCounts): number {
  return counts.tweet + counts.enrichment + counts.attempt + counts.registry + counts.receipt;
}

async function removeDatabaseFiles(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function assertFileSha256(path: string, expected: string): Promise<void> {
  if ((await fileSha256(path)) !== expected)
    throw new Error(`durable index database checksum mismatch: ${path}`);
}
