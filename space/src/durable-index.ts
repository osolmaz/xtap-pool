import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, openAsBlob } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import Database from "better-sqlite3";
import {
  commit,
  datasetInfo,
  deleteFiles,
  downloadFile,
  listFiles,
  uploadFile,
} from "@huggingface/hub";
import { z } from "zod";

import {
  assertDatasetRepoReadable,
  DatasetMirror,
  datasetSourceKind,
  isHubNotFound,
} from "./dataset.js";
import type { DatasetSourceKind } from "./dataset.js";
import { EnrichStore } from "./enrich-store.js";
import { TweetStore } from "./store.js";

const INDEX_SCHEMA_VERSION = 1;
const CURRENT_MANIFEST_KEY = "index/current.json";
const DATABASE_PREFIX = "index/databases";
const RETAINED_PREDECESSORS = 3;
const MAX_PUBLICATION_ATTEMPTS = 5;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{7,64}$/;

const indexCountsSchema = z
  .object({
    tweets: z.number().int().nonnegative(),
    units: z.number().int().nonnegative(),
    enrichments: z.number().int().nonnegative(),
    attempt_events: z.number().int().nonnegative(),
    registry_events: z.number().int().nonnegative(),
  })
  .strict();

export const durableIndexManifestSchema = z
  .object({
    schema_version: z.literal(INDEX_SCHEMA_VERSION),
    dataset: z
      .object({ repo: z.string().min(1), revision: z.string().regex(REVISION_PATTERN) })
      .strict(),
    projection: z.object({ contract_hash: z.string().regex(SHA256_PATTERN) }).strict(),
    database: z
      .object({ key: z.string().min(1), sha256: z.string().regex(SHA256_PATTERN) })
      .strict(),
    counts: indexCountsSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const expected = `${DATABASE_PREFIX}/${manifest.database.sha256}.sqlite`;
    if (manifest.database.key !== expected) {
      context.addIssue({
        code: "custom",
        path: ["database", "key"],
        message: `database key must be ${expected}`,
      });
    }
  });

export type DurableIndexManifest = z.infer<typeof durableIndexManifestSchema>;
export type DurableIndexCounts = z.infer<typeof indexCountsSchema>;

export type DatasetSourceFile = {
  path: string;
  oid: string;
  size: number;
};

export type DatasetSnapshotClient = {
  currentRevision(): Promise<string>;
  listJsonlFiles(revision: string): Promise<readonly DatasetSourceFile[]>;
  downloadFile(path: string, revision: string): Promise<Uint8Array>;
  readText(path: string, revision: string): Promise<string | undefined>;
  commitText(path: string, content: string, parentRevision: string): Promise<string>;
};

export type BucketFile = { path: string; uploadedAt?: string };

export type DurableIndexBucketClient = {
  download(path: string, destination: string): Promise<boolean>;
  uploadFile(path: string, source: string): Promise<void>;
  list(prefix: string): Promise<readonly BucketFile[]>;
  remove(paths: readonly string[]): Promise<void>;
};

type SourceFileRow = {
  path: string;
  kind: DatasetSourceKind;
  oid: string;
  byte_length: number;
  content_sha256: string;
  row_count: number;
};

type IndexMetadataRow = {
  schema_version: number;
  dataset_repo: string;
  dataset_revision: string;
  contract_hash: string;
};

type StagedSourceFile = {
  current: DatasetSourceFile;
  kind: DatasetSourceKind;
  fullContent: Uint8Array;
  fullText: string;
  suffixText: string;
  contentSha256: string;
  previousRows: number;
};

export type DurableIndexOptions = {
  datasetRepo: string;
  indexBucket: string;
  accessToken: string;
  databasePath: string;
  mirror: DatasetMirror;
  taxonomyVersion: number;
  contractHash: string;
  sourceClient?: DatasetSnapshotClient;
  bucketClient?: DurableIndexBucketClient;
};

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
};

/**
 * Restored local SQLite projection backed by an immutable Bucket generation.
 * The dataset stays authoritative; this class only advances strict append-only
 * JSONL inputs and publishes verified replacement generations.
 */
export class DurableIndex {
  readonly store: TweetStore;
  readonly enrichStore: EnrichStore;

  private constructor(
    private readonly options: DurableIndexOptions,
    private readonly source: DatasetSnapshotClient,
    private readonly bucket: DurableIndexBucketClient,
    store: TweetStore,
    enrichStore: EnrichStore,
  ) {
    this.store = store;
    this.enrichStore = enrichStore;
  }

  static async restore(options: DurableIndexOptions): Promise<DurableIndex> {
    const source =
      options.sourceClient ?? createDatasetSnapshotClient(options.datasetRepo, options.accessToken);
    const bucket =
      options.bucketClient ??
      createDurableIndexBucketClient(options.indexBucket, options.accessToken);
    const manifestRevision = await source.currentRevision();
    const rawManifest = await source.readText(CURRENT_MANIFEST_KEY, manifestRevision);
    if (rawManifest === undefined) {
      throw new Error("durable index manifest is missing; run the index bootstrap command");
    }
    const manifest = parseManifest(rawManifest, options);
    await mkdir(dirname(options.databasePath), { recursive: true });
    const staged = `${options.databasePath}.${randomUUID()}.download`;
    try {
      if (!(await bucket.download(manifest.database.key, staged))) {
        throw new Error(`durable index database is missing: ${manifest.database.key}`);
      }
      await assertFileSha256(staged, manifest.database.sha256);
      if (existsSync(options.databasePath)) await rm(options.databasePath, { force: true });
      await rename(staged, options.databasePath);
    } finally {
      await rm(staged, { force: true });
    }
    const store = new TweetStore(options.databasePath);
    const enrichStore = new EnrichStore(
      store.database,
      options.taxonomyVersion,
      (): Date => new Date(),
      options.contractHash,
    );
    ensureIndexTables(store.database);
    validateDatabase(store.database, manifest, options);
    const index = new DurableIndex(options, source, bucket, store, enrichStore);
    await index.loadLatestReceipt(manifest.dataset.revision);
    return index;
  }

  static openLocal(options: DurableIndexOptions): DurableIndex {
    if (!existsSync(options.databasePath)) {
      throw new Error(`durable index working database is missing: ${options.databasePath}`);
    }
    const source =
      options.sourceClient ?? createDatasetSnapshotClient(options.datasetRepo, options.accessToken);
    const bucket =
      options.bucketClient ??
      createDurableIndexBucketClient(options.indexBucket, options.accessToken);
    const store = new TweetStore(options.databasePath);
    const enrichStore = new EnrichStore(
      store.database,
      options.taxonomyVersion,
      (): Date => new Date(),
      options.contractHash,
    );
    ensureIndexTables(store.database);
    assertDatabaseIntegrity(store.database);
    const metadata = readMetadata(store.database);
    if (
      metadata?.schema_version !== INDEX_SCHEMA_VERSION ||
      metadata.dataset_repo !== options.datasetRepo ||
      metadata.contract_hash !== options.contractHash
    ) {
      store.close();
      throw new Error("durable index working database provenance mismatch");
    }
    return new DurableIndex(options, source, bucket, store, enrichStore);
  }

  static async bootstrap(options: DurableIndexOptions): Promise<DurableIndex> {
    const source =
      options.sourceClient ?? createDatasetSnapshotClient(options.datasetRepo, options.accessToken);
    const bucket =
      options.bucketClient ??
      createDurableIndexBucketClient(options.indexBucket, options.accessToken);
    await mkdir(dirname(options.databasePath), { recursive: true });
    await rm(options.databasePath, { force: true });
    const store = new TweetStore(options.databasePath);
    const enrichStore = new EnrichStore(
      store.database,
      options.taxonomyVersion,
      (): Date => new Date(),
      options.contractHash,
    );
    ensureIndexTables(store.database);
    const index = new DurableIndex(options, source, bucket, store, enrichStore);
    await index.advanceToLatest();
    return index;
  }

  async advanceToLatest(): Promise<IndexAdvance> {
    return this.advanceToRevision(await this.source.currentRevision());
  }

  async advanceToRevision(revision: string): Promise<IndexAdvance> {
    if (!REVISION_PATTERN.test(revision)) throw new Error(`invalid dataset revision: ${revision}`);
    const currentFiles = [...(await this.source.listJsonlFiles(revision))].sort((a, b) =>
      sourceOrder(a.path, b.path),
    );
    const previous = sourceFileRows(this.store.database);
    const currentPaths = new Set(currentFiles.map((file) => file.path));
    const deleted = [...previous.keys()].filter((path) => !currentPaths.has(path));
    if (deleted.length > 0) {
      throw new Error(`dataset source files were deleted: ${deleted.slice(0, 3).join(", ")}`);
    }
    const staged: StagedSourceFile[] = [];
    for (const file of currentFiles) {
      const old = previous.get(file.path);
      if (old?.oid === file.oid && old.byte_length === file.size) continue;
      staged.push(await this.stageSourceFile(file, old, revision));
    }

    let rowsApplied = 0;
    const apply = this.store.database.transaction(() => {
      for (const file of staged) {
        const applied = this.options.mirror.applySourceContent(
          file.current.path,
          file.suffixText,
          this.store,
          this.enrichStore,
        );
        if (applied.kind !== file.kind)
          throw new Error(`source kind changed: ${file.current.path}`);
        rowsApplied += applied.rows;
        upsertSourceFile(this.store.database, {
          path: file.current.path,
          kind: file.kind,
          oid: file.current.oid,
          byte_length: file.fullContent.byteLength,
          content_sha256: file.contentSha256,
          row_count: file.previousRows + applied.rows,
        });
      }
      writeMetadata(this.store.database, {
        schema_version: INDEX_SCHEMA_VERSION,
        dataset_repo: this.options.datasetRepo,
        dataset_revision: revision,
        contract_hash: this.options.contractHash,
      });
    });
    apply();
    for (const file of staged) {
      this.options.mirror.rememberSourceFile(file.current.path, file.fullText);
    }
    await this.loadLatestReceipt(revision, currentFiles);
    const counts = databaseCounts(this.store.database);
    assertDatabaseIntegrity(this.store.database);
    return { revision, filesChanged: staged.length, rowsApplied, counts };
  }

  stats(): DurableIndexStats {
    const rows = this.store.database
      .prepare(
        `SELECT kind, COUNT(*) AS files, COALESCE(SUM(row_count), 0) AS rows
         FROM source_files GROUP BY kind`,
      )
      .all() as { kind: DatasetSourceKind; files: number; rows: number }[];
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    const tweets = sourceKindStats(byKind, "tweet");
    const enrichments = sourceKindStats(byKind, "enrichment");
    return {
      tweetFiles: tweets.files,
      tweetRows: tweets.rows,
      enrichmentFiles: enrichments.files,
      enrichmentRows: enrichments.rows,
      attemptEvents: sourceKindStats(byKind, "attempt").rows,
      registryEvents: sourceKindStats(byKind, "registry").rows,
    };
  }

  async createWorkingCopy(path: string): Promise<void> {
    await rm(path, { force: true });
    await this.store.database.backup(path);
  }

  async publishLatest(): Promise<{
    advance: IndexAdvance;
    manifest: DurableIndexManifest;
  }> {
    for (let attempt = 1; attempt <= MAX_PUBLICATION_ATTEMPTS; attempt += 1) {
      const advance = await this.advanceToLatest();
      try {
        return { advance, manifest: await this.publish() };
      } catch (error) {
        if (attempt === MAX_PUBLICATION_ATTEMPTS || !isConcurrentDatasetUpdate(error)) throw error;
      }
    }
    throw new Error("durable index publication retry invariant failed");
  }

  async publish(): Promise<DurableIndexManifest> {
    const metadata = readMetadata(this.store.database);
    if (metadata === undefined) throw new Error("durable index metadata is missing");
    assertDatabaseIntegrity(this.store.database);
    const counts = databaseCounts(this.store.database);
    const publicationPath = `${this.options.databasePath}.${randomUUID()}.publish`;
    const verificationPath = `${this.options.databasePath}.${randomUUID()}.verify`;
    try {
      await this.store.database.backup(publicationPath);
      validateStandaloneDatabase(publicationPath, metadata, counts);
      const sha256 = await fileSha256(publicationPath);
      const key = `${DATABASE_PREFIX}/${sha256}.sqlite`;
      await this.bucket.uploadFile(key, publicationPath);
      if (!(await this.bucket.download(key, verificationPath))) {
        throw new Error(`uploaded durable index database is unavailable: ${key}`);
      }
      await assertFileSha256(verificationPath, sha256);
      validateStandaloneDatabase(verificationPath, metadata, counts);
      const manifest: DurableIndexManifest = {
        schema_version: INDEX_SCHEMA_VERSION,
        dataset: { repo: metadata.dataset_repo, revision: metadata.dataset_revision },
        projection: { contract_hash: metadata.contract_hash },
        database: { key, sha256 },
        counts,
      };
      const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
      const manifestRevision = await this.source.commitText(
        CURRENT_MANIFEST_KEY,
        encoded,
        metadata.dataset_revision,
      );
      const active = await this.source.readText(CURRENT_MANIFEST_KEY, manifestRevision);
      if (
        active === undefined ||
        JSON.stringify(parseManifest(active, this.options)) !== JSON.stringify(manifest)
      ) {
        throw new Error("durable index manifest read-back did not match the published generation");
      }
      await this.pruneDatabases(key);
      return manifest;
    } finally {
      await Promise.all([
        rm(publicationPath, { force: true }),
        rm(verificationPath, { force: true }),
      ]);
    }
  }

  close(): void {
    this.store.close();
  }

  private async stageSourceFile(
    current: DatasetSourceFile,
    previous: SourceFileRow | undefined,
    revision: string,
  ): Promise<StagedSourceFile> {
    const kind = datasetSourceKind(current.path);
    assertSourceKind(current.path, kind, previous);
    const content = await this.source.downloadFile(current.path, revision);
    assertCompletePinnedSource(current, content);
    const suffix = sourceSuffix(current.path, content, previous);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return {
      current,
      kind,
      fullContent: content,
      fullText: decoder.decode(content),
      suffixText: decoder.decode(suffix),
      contentSha256: sha256Bytes(content),
      previousRows: previous?.row_count ?? 0,
    };
  }

  private async loadLatestReceipt(
    revision: string,
    knownFiles?: readonly DatasetSourceFile[],
  ): Promise<void> {
    const files = knownFiles ?? (await this.source.listJsonlFiles(revision));
    const latest = files
      .filter((file) => datasetSourceKind(file.path) === "receipt")
      .sort((a, b) => a.path.localeCompare(b.path))
      .at(-1);
    if (latest === undefined) return;
    const content = await this.source.downloadFile(latest.path, revision);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    this.options.mirror.applySourceContent(latest.path, text, this.store, this.enrichStore);
    this.options.mirror.rememberSourceFile(latest.path, text);
  }

  private async pruneDatabases(activeKey: string): Promise<void> {
    const files = [...(await this.bucket.list(DATABASE_PREFIX))]
      .filter((file) => file.path.endsWith(".sqlite"))
      .sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""));
    const keep = new Set<string>([activeKey]);
    for (const file of files) {
      if (keep.size >= RETAINED_PREDECESSORS + 1) break;
      keep.add(file.path);
    }
    const stale = files.map((file) => file.path).filter((path) => !keep.has(path));
    if (stale.length > 0) await this.bucket.remove(stale);
  }
}

function isConcurrentDatasetUpdate(error: unknown): boolean {
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    statusCode === 409 ||
    message.includes("branch was updated") ||
    message.includes("parent commit does not match")
  );
}

function assertSourceKind(
  path: string,
  kind: DatasetSourceKind,
  previous: SourceFileRow | undefined,
): void {
  if (previous !== undefined && previous.kind !== kind) {
    throw new Error(`dataset source kind changed: ${path}`);
  }
}

function assertCompletePinnedSource(current: DatasetSourceFile, content: Uint8Array): void {
  if (content.byteLength !== current.size) {
    throw new Error(`dataset source size changed while pinned: ${current.path}`);
  }
  if (content.byteLength > 0 && content.at(-1) !== 0x0a) {
    throw new Error(`dataset source does not end with a complete JSONL line: ${current.path}`);
  }
}

function sourceSuffix(
  path: string,
  content: Uint8Array,
  previous: SourceFileRow | undefined,
): Uint8Array {
  if (previous === undefined) return content;
  if (content.byteLength < previous.byte_length) {
    throw new Error(`dataset source was truncated: ${path}`);
  }
  const prefix = content.subarray(0, previous.byte_length);
  if (sha256Bytes(prefix) !== previous.content_sha256) {
    throw new Error(`dataset source prefix changed: ${path}`);
  }
  return content.subarray(previous.byte_length);
}

export function createDatasetSnapshotClient(
  datasetRepo: string,
  accessToken: string,
): DatasetSnapshotClient {
  const repo = { type: "dataset", name: datasetRepo } as const;
  return {
    async currentRevision(): Promise<string> {
      const info = await datasetInfo({
        name: datasetRepo,
        accessToken,
        additionalFields: ["sha"],
      });
      if (typeof info.sha !== "string" || !REVISION_PATTERN.test(info.sha)) {
        throw new Error(`dataset ${datasetRepo} did not return a valid revision`);
      }
      return info.sha;
    },
    async listJsonlFiles(revision: string): Promise<readonly DatasetSourceFile[]> {
      const groups = await Promise.all(
        ["data", "enrichment"].map((prefix) =>
          listDatasetPrefix(repo, accessToken, revision, prefix),
        ),
      );
      return groups.flat();
    },
    async downloadFile(path: string, revision: string): Promise<Uint8Array> {
      const blob = await downloadFile({ repo, accessToken, path, revision });
      if (blob === null) throw new Error(`dataset source is missing: ${path}`);
      return new Uint8Array(await blob.arrayBuffer());
    },
    async readText(path: string, revision: string): Promise<string | undefined> {
      const blob = await downloadFile({ repo, accessToken, path, revision });
      return blob === null ? undefined : blob.text();
    },
    async commitText(path: string, content: string, parentRevision: string): Promise<string> {
      const result = await commit({
        repo,
        accessToken,
        parentCommit: parentRevision,
        title: "Publish durable enrichment index manifest",
        operations: [{ operation: "addOrUpdate", path, content: new Blob([content]) }],
      });
      if (result === undefined || !REVISION_PATTERN.test(result.commit.oid)) {
        throw new Error("dataset did not confirm the durable index manifest commit");
      }
      return result.commit.oid;
    },
  };
}

// eslint-disable-next-line complexity -- Hub entries require type, path, and immutable-object validation.
async function listDatasetPrefix(
  repo: { type: "dataset"; name: string },
  accessToken: string,
  revision: string,
  prefix: string,
): Promise<DatasetSourceFile[]> {
  const files: DatasetSourceFile[] = [];
  try {
    for await (const entry of listFiles({
      repo,
      accessToken,
      recursive: true,
      path: prefix,
      revision,
    })) {
      if (entry.type !== "file" || !entry.path.endsWith(".jsonl")) continue;
      const oid = entry.xetHash ?? entry.lfs?.oid ?? entry.oid;
      if (oid === undefined || oid.length === 0) {
        throw new Error(`dataset source has no immutable object id: ${entry.path}`);
      }
      files.push({ path: entry.path, oid, size: entry.size });
    }
  } catch (error) {
    if (!isHubNotFound(error)) throw error;
    await assertDatasetRepoReadable(repo, accessToken, revision);
  }
  return files;
}

export function createDurableIndexBucketClient(
  indexBucket: string,
  accessToken: string,
): DurableIndexBucketClient {
  const repo = { type: "bucket", name: indexBucket } as const;
  return {
    async download(path: string, destination: string): Promise<boolean> {
      const blob = await downloadFile({ repo, accessToken, path });
      if (blob === null) return false;
      await mkdir(dirname(destination), { recursive: true });
      await pipeline(Readable.fromWeb(blob.stream()), createWriteStream(destination));
      return true;
    },
    async uploadFile(path: string, source: string): Promise<void> {
      await uploadFile({
        repo,
        accessToken,
        file: { path, content: await openAsBlob(source) },
        commitTitle: `Publish ${path}`,
      });
    },
    async list(prefix: string): Promise<readonly BucketFile[]> {
      const files: BucketFile[] = [];
      for await (const entry of listFiles({
        repo,
        accessToken,
        recursive: true,
        path: prefix,
        expand: true,
      })) {
        if (entry.type === "file") {
          files.push({
            path: entry.path,
            ...(entry.uploadedAt === undefined ? {} : { uploadedAt: entry.uploadedAt }),
          });
        }
      }
      return files;
    },
    async remove(paths: readonly string[]): Promise<void> {
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

function parseManifest(
  raw: string,
  options: Pick<DurableIndexOptions, "datasetRepo" | "contractHash">,
): DurableIndexManifest {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("durable index manifest is not valid JSON");
  }
  const manifest = durableIndexManifestSchema.parse(candidate);
  if (manifest.dataset.repo !== options.datasetRepo) {
    throw new Error(`durable index dataset mismatch: ${manifest.dataset.repo}`);
  }
  if (manifest.projection.contract_hash !== options.contractHash) {
    throw new Error("durable index enrichment contract does not match the running code");
  }
  return manifest;
}

function ensureIndexTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      dataset_repo TEXT NOT NULL,
      dataset_revision TEXT NOT NULL,
      contract_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_files (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      oid TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      content_sha256 TEXT NOT NULL,
      row_count INTEGER NOT NULL CHECK (row_count >= 0)
    );
  `);
}

function sourceFileRows(db: Database.Database): Map<string, SourceFileRow> {
  const rows = db
    .prepare(
      `SELECT path, kind, oid, byte_length, content_sha256, row_count
       FROM source_files ORDER BY path`,
    )
    .all() as SourceFileRow[];
  return new Map(rows.map((row) => [row.path, row]));
}

function upsertSourceFile(db: Database.Database, row: SourceFileRow): void {
  db.prepare(
    `INSERT INTO source_files
       (path, kind, oid, byte_length, content_sha256, row_count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       kind = excluded.kind,
       oid = excluded.oid,
       byte_length = excluded.byte_length,
       content_sha256 = excluded.content_sha256,
       row_count = excluded.row_count`,
  ).run(row.path, row.kind, row.oid, row.byte_length, row.content_sha256, row.row_count);
}

function writeMetadata(db: Database.Database, metadata: IndexMetadataRow): void {
  db.prepare(
    `INSERT INTO index_metadata
       (singleton, schema_version, dataset_repo, dataset_revision, contract_hash)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       schema_version = excluded.schema_version,
       dataset_repo = excluded.dataset_repo,
       dataset_revision = excluded.dataset_revision,
       contract_hash = excluded.contract_hash`,
  ).run(
    metadata.schema_version,
    metadata.dataset_repo,
    metadata.dataset_revision,
    metadata.contract_hash,
  );
}

function readMetadata(db: Database.Database): IndexMetadataRow | undefined {
  return db
    .prepare(
      `SELECT schema_version, dataset_repo, dataset_revision, contract_hash
       FROM index_metadata WHERE singleton = 1`,
    )
    .get() as IndexMetadataRow | undefined;
}

function sourceKindStats(
  byKind: ReadonlyMap<DatasetSourceKind, { files: number; rows: number }>,
  kind: DatasetSourceKind,
): { files: number; rows: number } {
  return byKind.get(kind) ?? { files: 0, rows: 0 };
}

function databaseCounts(db: Database.Database): DurableIndexCounts {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const eventCount = (kind: DatasetSourceKind): number =>
    (
      db
        .prepare("SELECT COALESCE(SUM(row_count), 0) AS n FROM source_files WHERE kind = ?")
        .get(kind) as {
        n: number;
      }
    ).n;
  return {
    tweets: count("tweets"),
    units: count("enrich_queue"),
    enrichments: count("enrichment"),
    attempt_events: eventCount("attempt"),
    registry_events: eventCount("registry"),
  };
}

function validateDatabase(
  db: Database.Database,
  manifest: DurableIndexManifest,
  options: Pick<DurableIndexOptions, "datasetRepo" | "contractHash">,
): void {
  assertDatabaseIntegrity(db);
  const metadata = readMetadata(db);
  if (metadata === undefined) throw new Error("durable index metadata is missing");
  if (metadata.schema_version !== INDEX_SCHEMA_VERSION)
    throw new Error("durable index schema version mismatch");
  if (
    metadata.dataset_repo !== options.datasetRepo ||
    metadata.dataset_revision !== manifest.dataset.revision
  ) {
    throw new Error("durable index dataset provenance mismatch");
  }
  if (metadata.contract_hash !== options.contractHash)
    throw new Error("durable index contract mismatch");
  if (JSON.stringify(databaseCounts(db)) !== JSON.stringify(manifest.counts)) {
    throw new Error("durable index physical counts do not match the manifest");
  }
}

function validateStandaloneDatabase(
  path: string,
  metadata: IndexMetadataRow,
  counts: DurableIndexCounts,
): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    assertDatabaseIntegrity(db);
    if (JSON.stringify(readMetadata(db)) !== JSON.stringify(metadata)) {
      throw new Error("published durable index metadata does not match");
    }
    if (JSON.stringify(databaseCounts(db)) !== JSON.stringify(counts)) {
      throw new Error("published durable index counts do not match");
    }
  } finally {
    db.close();
  }
}

function assertDatabaseIntegrity(db: Database.Database): void {
  const rows = db.pragma("quick_check") as { quick_check: string }[];
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
    throw new Error("durable index SQLite quick_check failed");
  }
}

function sourceOrder(left: string, right: string): number {
  const priorities: Record<DatasetSourceKind, number> = {
    tweet: 0,
    enrichment: 1,
    registry: 2,
    attempt: 3,
    receipt: 4,
  };
  const difference = priorities[datasetSourceKind(left)] - priorities[datasetSourceKind(right)];
  return difference === 0 ? left.localeCompare(right) : difference;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function assertFileSha256(path: string, expected: string): Promise<void> {
  if ((await fileSha256(path)) !== expected) {
    throw new Error("durable index database checksum mismatch");
  }
}

function sha256Bytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
