import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

import { downloadFile, listFiles, uploadFile } from "@huggingface/hub";
import { z } from "zod";

import {
  attemptEventSchema,
  freeLabelEventSchema,
  parseEnrichReceipt,
  parseEnrichmentRow,
  validateTweet,
} from "@xtap-pool/shared";
import type { EnrichReceipt, PooledTweet } from "@xtap-pool/shared";

import type { EnrichStore } from "./enrich-store.js";
import type { TweetStore } from "./store.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SEGMENT_PREFIX = "v1/segments";
const SNAPSHOT_PREFIX = "v1/snapshots";
const SEGMENT_KEY = /^v1\/segments\/(tweet|enrichment|attempt|registry|receipt|config|mixed)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{13})-([0-9a-f-]{36})-([a-f0-9]{64})\.json\.gz$/u;
const SNAPSHOT_KEY = /^v1\/snapshots\/([a-f0-9]{64})\.json$/u;
const CONFIG_PATHS = new Set([
  "config/labels.json",
  "config/pool.json",
  "config/service-accounts.json",
  "enrichment/vocabulary.json",
]);

const appendOperationSchema = z
  .object({
    path: z.string().min(1),
    mode: z.literal("append"),
    lines: z.array(z.string().min(1)).min(1),
  })
  .strict();
const writeOperationSchema = z
  .object({ path: z.string().min(1), mode: z.literal("write"), content: z.string() })
  .strict();
export const bucketSegmentSchema = z
  .object({
    schema_version: z.literal(1),
    transaction_id: z.string().regex(UUID),
    created_at: z.iso.datetime({ offset: true }),
    operations: z
      .array(z.discriminatedUnion("mode", [appendOperationSchema, writeOperationSchema]))
      .min(1),
  })
  .strict()
  .superRefine((segment, context) => {
    const paths = segment.operations.map((operation) => operation.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "operation paths must be unique",
      });
    }
  });

const snapshotFileSchema = z
  .object({
    key: z.string().regex(SEGMENT_KEY),
    oid: z.string().min(1),
    size: z.number().int().nonnegative(),
    content_sha256: z.string().regex(SHA256),
  })
  .strict();
export const bucketSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    bucket: z.string().min(3),
    files: z.array(snapshotFileSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const keys = snapshot.files.map((file) => file.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", path: ["files"], message: "file keys must be unique" });
    }
    if (keys.some((key, index) => index > 0 && key <= (keys[index - 1] ?? ""))) {
      context.addIssue({ code: "custom", path: ["files"], message: "files must be sorted" });
    }
  });

export type BucketOperation = z.infer<typeof appendOperationSchema> | z.infer<typeof writeOperationSchema>;
export type BucketSegment = z.infer<typeof bucketSegmentSchema>;
export type BucketSnapshot = z.infer<typeof bucketSnapshotSchema>;
export type BucketSnapshotFile = z.infer<typeof snapshotFileSchema>;
export type SourceKind = "tweet" | "enrichment" | "attempt" | "registry" | "receipt";
export type SourceCounts = Readonly<Record<SourceKind, number>>;
export type BucketObject = { key: string; oid: string; size: number };

export type RawBucketClient = {
  list(prefix: string): Promise<readonly BucketObject[]>;
  download(key: string): Promise<Uint8Array | undefined>;
  upload(key: string, content: Uint8Array): Promise<void>;
};

const legacyReceiptSchema = z
  .object({
    started_at: z.string().min(1),
    finished_at: z.string().min(1),
    units: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
  })
  .strict();
const legacyEnrichmentRowSchema = z
  .object({
    unit_id: z.string().min(1),
    tweet_ids: z.array(z.string().min(1)).min(1),
    labels: z.array(z.string()),
    free_labels: z.array(z.string()),
    concepts: z.array(z.unknown()),
    model: z.string().min(1),
    taxonomy_version: z.number().int().min(1),
    enriched_at: z.string().min(1),
  })
  .loose();

export function createRawBucketClient(rawBucket: string, accessToken: string): RawBucketClient {
  const repo = { type: "bucket", name: rawBucket } as const;
  return {
    async list(prefix): Promise<readonly BucketObject[]> {
      const objects: BucketObject[] = [];
      for await (const entry of listFiles({
        repo,
        accessToken,
        recursive: true,
        path: prefix,
        expand: true,
      })) {
        if (entry.type !== "file") continue;
        const oid = entry.xetHash ?? entry.lfs?.oid ?? entry.oid;
        if (oid === undefined || oid.length === 0) {
          throw new Error(`Bucket object has no immutable object id: ${entry.path}`);
        }
        objects.push({ key: entry.path, oid, size: entry.size });
      }
      return objects;
    },
    async download(key): Promise<Uint8Array | undefined> {
      const blob = await downloadFile({ repo, accessToken, path: key });
      return blob === null ? undefined : new Uint8Array(await blob.arrayBuffer());
    },
    async upload(key, content): Promise<void> {
      await uploadFile({
        repo,
        accessToken,
        file: { path: key, content: new Blob([content]) },
        commitTitle: `Store ${key}`,
      });
    },
  };
}

/** Immutable transaction log and exact snapshots in a private Hugging Face Bucket. */
export class BucketLog {
  private lastReceipt: EnrichReceipt | undefined;
  private lastCreatedAtMs = 0;

  constructor(
    readonly name: string,
    private readonly client: RawBucketClient,
    private readonly cacheDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async commitBatch(
    appends: readonly { path: string; lines: readonly string[] }[],
    writes: readonly { path: string; content: string }[],
    _title?: string,
  ): Promise<string> {
    const operations: BucketOperation[] = [
      ...appends.map(({ path, lines }) => ({ path, mode: "append" as const, lines: [...lines] })),
      ...writes.map(({ path, content }) => ({ path, mode: "write" as const, content })),
    ];
    return this.putSegment({
      schema_version: 1,
      transaction_id: randomUUID(),
      created_at: this.nextCreatedAt(),
      operations,
    });
  }

  async appendTweets(tweets: readonly PooledTweet[], title?: string): Promise<string> {
    const byPath = new Map<string, string[]>();
    for (const tweet of tweets) {
      const path = tweetPathFor(tweet.contributed_by, tweet.captured_at);
      const lines = byPath.get(path);
      if (lines === undefined) byPath.set(path, [JSON.stringify(tweet)]);
      else lines.push(JSON.stringify(tweet));
    }
    return this.commitBatch(
      [...byPath].map(([path, lines]) => ({ path, lines })),
      [],
      title,
    );
  }

  async putSegment(candidate: BucketSegment): Promise<string> {
    const segment = bucketSegmentSchema.parse(candidate);
    validateOperations(segment.operations);
    const raw = canonicalBytes(segment);
    const digest = sha256(raw);
    const category = segmentCategory(segment.operations);
    const day = segment.created_at.slice(0, 10);
    const time = Date.parse(segment.created_at);
    if (!Number.isSafeInteger(time)) throw new Error("segment created_at is outside the safe range");
    const key = `${SEGMENT_PREFIX}/${category}/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}/${String(time).padStart(13, "0")}-${segment.transaction_id}-${digest}.json.gz`;
    const compressed = new Uint8Array(await gzipAsync(raw, { level: 9 }));
    const existing = await this.client.download(key);
    if (existing === undefined) await this.client.upload(key, compressed);
    await this.verifyStoredSegment(key, raw);
    return key;
  }

  async createSnapshot(): Promise<{ revision: string; snapshot: BucketSnapshot }> {
    const objects = [...(await this.client.list(SEGMENT_PREFIX))].sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    const files = objects.map((object): BucketSnapshotFile => ({
      key: object.key,
      oid: object.oid,
      size: object.size,
      content_sha256: segmentHash(object.key),
    }));
    const snapshot = bucketSnapshotSchema.parse({ schema_version: 1, bucket: this.name, files });
    const raw = canonicalBytes(snapshot);
    const revision = sha256(raw);
    const key = `${SNAPSHOT_PREFIX}/${revision}.json`;
    const existing = await this.client.download(key);
    if (existing === undefined) await this.client.upload(key, raw);
    const stored = await this.client.download(key);
    if (stored === undefined || !equalBytes(stored, raw)) {
      throw new Error(`Bucket snapshot read-back mismatch: ${key}`);
    }
    return { revision, snapshot };
  }

  async loadSnapshot(revision: string): Promise<BucketSnapshot> {
    if (!SHA256.test(revision)) throw new Error(`invalid Bucket snapshot revision: ${revision}`);
    const key = `${SNAPSHOT_PREFIX}/${revision}.json`;
    const raw = await this.client.download(key);
    if (raw === undefined) throw new Error(`Bucket snapshot is missing: ${key}`);
    if (sha256(raw) !== revision) throw new Error(`Bucket snapshot checksum mismatch: ${key}`);
    let candidate: unknown;
    try {
      candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      throw new Error(`Bucket snapshot is not valid UTF-8 JSON: ${key}`);
    }
    const snapshot = bucketSnapshotSchema.parse(candidate);
    if (snapshot.bucket !== this.name) throw new Error(`Bucket snapshot source mismatch: ${snapshot.bucket}`);
    return snapshot;
  }

  async loadSegment(file: BucketSnapshotFile): Promise<BucketSegment> {
    if (segmentHash(file.key) !== file.content_sha256) {
      throw new Error(`Bucket snapshot segment hash mismatch: ${file.key}`);
    }
    const compressed = await this.client.download(file.key);
    if (compressed === undefined) throw new Error(`Bucket segment is missing: ${file.key}`);
    if (compressed.byteLength !== file.size) throw new Error(`Bucket segment size mismatch: ${file.key}`);
    const raw = new Uint8Array(await gunzipAsync(compressed));
    if (sha256(raw) !== file.content_sha256) throw new Error(`Bucket segment checksum mismatch: ${file.key}`);
    let candidate: unknown;
    try {
      candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      throw new Error(`Bucket segment is not valid UTF-8 JSON: ${file.key}`);
    }
    const segment = bucketSegmentSchema.parse(candidate);
    validateOperations(segment.operations);
    if (!equalBytes(canonicalBytes(segment), raw)) throw new Error(`Bucket segment is not canonical: ${file.key}`);
    return segment;
  }

  async readText(path: string): Promise<string | undefined> {
    assertConfigPath(path);
    const { snapshot } = await this.createSnapshot();
    let latest: { order: string; value: string } | undefined;
    for (const file of snapshot.files.filter((item) => item.key.includes("/config/") || item.key.includes("/mixed/"))) {
      const segment = await this.loadSegment(file);
      for (const operation of segment.operations) {
        if (operation.mode !== "write" || operation.path !== path) continue;
        const order = `${segment.created_at}\0${segment.transaction_id}\0${file.key}`;
        if (latest === undefined || order > latest.order) latest = { order, value: operation.content };
      }
    }
    return latest?.value;
  }

  async writeText(path: string, content: string, title?: string): Promise<void> {
    await this.commitBatch([], [{ path, content }], title);
    this.rememberText(path, content);
  }

  applySegment(segment: BucketSegment, store: TweetStore, enrich: EnrichStore): SourceCounts {
    const counts = emptyCounts();
    for (const operation of segment.operations) {
      if (operation.mode === "write") {
        this.rememberText(operation.path, operation.content);
        continue;
      }
      const kind = sourceKind(operation.path);
      const content = `${operation.lines.join("\n")}\n`;
      counts[kind] += applyLines(kind, operation.path, content, store, enrich, (receipt) => {
        if (this.lastReceipt === undefined || receipt.finished_at > this.lastReceipt.finished_at) {
          this.lastReceipt = receipt;
        }
      });
    }
    return counts;
  }

  latestReceipt(): EnrichReceipt | undefined {
    return this.lastReceipt;
  }

  private nextCreatedAt(): string {
    const observed = this.now().getTime();
    const next = Math.max(observed, this.lastCreatedAtMs + 1);
    this.lastCreatedAtMs = next;
    return new Date(next).toISOString();
  }

  private async verifyStoredSegment(key: string, expected: Uint8Array): Promise<void> {
    const stored = await this.client.download(key);
    if (stored === undefined) throw new Error(`Bucket did not retain segment: ${key}`);
    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await gunzipAsync(stored));
    } catch {
      throw new Error(`Bucket segment read-back is not valid gzip: ${key}`);
    }
    if (!equalBytes(raw, expected) || sha256(raw) !== segmentHash(key)) {
      throw new Error(`Bucket segment read-back mismatch: ${key}`);
    }
  }

  private rememberText(path: string, content: string): void {
    const local = this.localPath(path);
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, content);
  }

  private localPath(path: string): string {
    const root = normalize(this.cacheDir);
    const resolved = normalize(join(root, path));
    const rel = relative(root, resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Bucket cache path escapes root: ${path}`);
    }
    return resolved;
  }
}

export function sourceKind(path: string): SourceKind {
  if (/^data\/[^/]+\/\d{4}\/\d{2}\/tweets-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)) return "tweet";
  if (/^enrichment\/\d{4}\/\d{2}\/enrichment-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)) return "enrichment";
  if (/^enrichment\/attempts\/\d{4}\/\d{2}\/attempts-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)) return "attempt";
  if (/^enrichment\/registry\/\d{4}\/\d{2}\/registry-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)) return "registry";
  if (/^enrichment\/receipts\/\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)) return "receipt";
  throw new Error(`unsupported Bucket log source: ${path}`);
}

export function assertValidSource(path: string, content: string): void {
  const kind = sourceKind(path);
  for (const [index, line] of content.split("\n").entries()) {
    if (line.trim() === "") continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSON in ${path} at line ${String(index + 1)}`);
    }
    if (!validRecord(kind, candidate)) {
      throw new Error(`invalid ${kind} record in ${path} at line ${String(index + 1)}`);
    }
  }
}

export function parseJsonlTweets(content: string, path: string): PooledTweet[] {
  const contributor = path.split("/")[1] ?? "unknown";
  const tweets: PooledTweet[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      continue;
    }
    const result = validateTweet(candidate);
    if (!result.ok) continue;
    const tweet = result.tweet;
    tweets.push({
      ...tweet,
      contributed_by:
        typeof tweet["contributed_by"] === "string" && tweet["contributed_by"].length > 0
          ? tweet["contributed_by"]
          : contributor,
      pooled_at: typeof tweet["pooled_at"] === "string" ? tweet["pooled_at"] : tweet.captured_at,
    });
  }
  return tweets;
}

export function tweetPathFor(contributor: string, capturedAt: string): string {
  const day = new Date(capturedAt).toISOString().slice(0, 10);
  return `data/${contributor}/${day.slice(0, 4)}/${day.slice(5, 7)}/tweets-${day}.jsonl`;
}

export function deterministicUuid(digest: string): string {
  if (!SHA256.test(digest)) throw new Error("deterministic UUID requires a SHA-256 digest");
  const bytes = digest.slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = ["8", "9", "a", "b"][Number.parseInt(bytes[16] ?? "0", 16) % 4] ?? "8";
  const value = bytes.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function validateOperations(operations: readonly BucketOperation[]): void {
  for (const operation of operations) {
    if (operation.mode === "write") assertConfigPath(operation.path);
    else assertValidSource(operation.path, `${operation.lines.join("\n")}\n`);
  }
}

function validRecord(kind: SourceKind, candidate: unknown): boolean {
  switch (kind) {
    case "tweet":
      return validateTweet(candidate).ok;
    case "enrichment":
      return parseEnrichmentRow(candidate) !== undefined || legacyEnrichmentRowSchema.safeParse(candidate).success;
    case "attempt":
      return attemptEventSchema.safeParse(candidate).success;
    case "registry":
      return freeLabelEventSchema.safeParse(candidate).success;
    case "receipt":
      return parseEnrichReceipt(candidate) !== undefined || legacyReceiptSchema.safeParse(candidate).success;
  }
}

function applyLines(
  kind: SourceKind,
  path: string,
  content: string,
  store: TweetStore,
  enrich: EnrichStore,
  observeReceipt: (receipt: EnrichReceipt) => void,
): number {
  if (kind === "tweet") {
    const tweets = parseJsonlTweets(content, path);
    store.insert(tweets);
    enrich.registerTweets(tweets);
    return tweets.length;
  }
  let rows = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const candidate: unknown = JSON.parse(line);
    if (kind === "enrichment") {
      const row = parseEnrichmentRow(candidate);
      if (row !== undefined) enrich.applyEnrichment(row);
    } else if (kind === "attempt") {
      enrich.replayAttemptEvent(attemptEventSchema.parse(candidate));
    } else if (kind === "registry") {
      enrich.applyRegistryEvent(freeLabelEventSchema.parse(candidate));
    } else {
      const receipt = parseEnrichReceipt(candidate);
      if (receipt !== undefined) observeReceipt(receipt);
    }
    rows += 1;
  }
  return rows;
}

function segmentCategory(operations: readonly BucketOperation[]): string {
  const categories = new Set(
    operations.map((operation) => (operation.mode === "write" ? "config" : sourceKind(operation.path))),
  );
  return categories.size === 1 ? ([...categories][0] ?? "mixed") : "mixed";
}

function assertConfigPath(path: string): void {
  if (!CONFIG_PATHS.has(path)) throw new Error(`unsupported Bucket configuration path: ${path}`);
}

function segmentHash(key: string): string {
  const match = SEGMENT_KEY.exec(key);
  if (match === null) throw new Error(`invalid Bucket segment key: ${key}`);
  const digest = match[7];
  if (digest === undefined || !SHA256.test(digest)) throw new Error(`invalid Bucket segment key: ${key}`);
  const day = `${match[2] ?? ""}-${match[3] ?? ""}-${match[4] ?? ""}`;
  const time = Number(match[5]);
  if (new Date(time).toISOString().slice(0, 10) !== day || !UUID.test(match[6] ?? "")) {
    throw new Error(`invalid Bucket segment key: ${key}`);
  }
  return digest;
}

function emptyCounts(): Record<SourceKind, number> {
  return { tweet: 0, enrichment: 0, attempt: 0, registry: 0, receipt: 0 };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function readCachedText(cacheDir: string, path: string): string | undefined {
  try {
    return readFileSync(join(cacheDir, path), "utf8");
  } catch {
    return undefined;
  }
}
