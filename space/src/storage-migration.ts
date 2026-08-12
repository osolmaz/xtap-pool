import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { downloadFile, listFiles } from "@huggingface/hub";

import { validateTweet } from "@xtap-pool/shared";
import type { PooledTweet } from "@xtap-pool/shared";

import {
  assertValidSource,
  BucketLog,
  bucketSegmentSchema,
  canonicalBytes,
  deterministicUuid,
  RAW_CONFIG_PATHS,
  sha256,
  sourceKind,
} from "./bucket-log.js";
import type { BucketOperation, BucketSegment, BucketSnapshot, SourceKind } from "./bucket-log.js";

const PINNED_REVISION = /^[a-f0-9]{40}$/u;
const SOURCE_PATH =
  /^(?:data\/[^/]+\/\d{4}\/\d{2}\/tweets-\d{4}-\d{2}-\d{2}\.jsonl|enrichment\/\d{4}\/\d{2}\/enrichment-\d{4}-\d{2}-\d{2}\.jsonl|enrichment\/attempts\/\d{4}\/\d{2}\/attempts-\d{4}-\d{2}-\d{2}\.jsonl|enrichment\/registry\/\d{4}\/\d{2}\/registry-\d{4}-\d{2}-\d{2}\.jsonl|enrichment\/receipts\/\d{4}-\d{2}-\d{2}\.jsonl)$/u;
const CONFIG_PATHS = new Set<string>(RAW_CONFIG_PATHS);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type PinnedSourceObject = { path: string; oid: string; size: number };
export type PinnedDatasetSource = {
  list(): Promise<readonly PinnedSourceObject[]>;
  download(path: string): Promise<Uint8Array>;
};

export type MigrationFileEvidence = {
  path: string;
  source_oid: string;
  byte_length: number;
  content_sha256: string;
  kind: SourceKind | "config";
  rows: number;
  sorted_line_digest: string;
  target_segment: string;
};

export type MigrationReconciliation = {
  source_paths: number;
  target_segments: number;
  rows: Record<SourceKind, number>;
  sorted_line_digests: Record<SourceKind, string>;
  tweet_identity_rows: number;
  tweet_identity_digest: string;
  unique_tweet_identities: number;
  unique_tweet_identity_digest: string;
  contributor_counts_digest: string;
  capture_day_counts_digest: string;
  enrichment_identity_digest: string;
  attempt_row_digest: string;
  registry_identity_digest: string;
  receipt_row_digest: string;
  config_content_digest: string;
  passed: true;
};

export type StorageMigrationReport = {
  schema_version: 1;
  source: { dataset: string; revision: string; objects: number };
  target: { bucket: string; snapshot_revision: string; objects: number };
  files: readonly MigrationFileEvidence[];
  reconciliation: MigrationReconciliation;
};

export type StorageMigrationOptions = {
  dataset: string;
  revision: string;
  log: BucketLog;
  reportPath: string;
  source?: PinnedDatasetSource;
};

type EvidenceAccumulator = {
  rows: Record<SourceKind, string[]>;
  tweetIdentities: string[];
  uniqueTweetIdentities: Set<string>;
  contributors: Map<string, number>;
  captureDays: Map<string, number>;
  enrichments: string[];
  attempts: string[];
  registry: string[];
  receipts: string[];
  configs: string[];
};

type PreparedSource = {
  object: PinnedSourceObject;
  content: string;
  operation: BucketOperation;
  segment: BucketSegment;
  evidence: MigrationFileEvidence;
};

/** Import one exact dataset revision and prove exact preservation in one raw Bucket snapshot. */
export async function importPinnedDataset(
  options: StorageMigrationOptions,
): Promise<StorageMigrationReport> {
  assertPinnedRevision(options.revision);
  const source = options.source ?? createPinnedDatasetSource(options.dataset, options.revision);
  const objects = approvedObjects(await source.list());
  const prepared: PreparedSource[] = [];
  for (const [index, object] of objects.entries()) {
    prepared.push(await prepareSource(options, source, object, index));
  }
  for (const item of prepared) {
    const key = await options.log.putSegment(item.segment);
    if (key !== item.evidence.target_segment) {
      throw new Error(`deterministic target key mismatch for ${item.object.path}`);
    }
  }
  const { revision: snapshotRevision, snapshot } = await options.log.createSnapshot();
  const report = await reconcilePrepared(options, prepared, snapshotRevision, snapshot);
  await writeReport(options.reportPath, report);
  return report;
}

/** Verify an existing import against the same exact pinned source without writing raw objects. */
export async function verifyPinnedDataset(
  options: StorageMigrationOptions,
): Promise<StorageMigrationReport> {
  assertPinnedRevision(options.revision);
  const source = options.source ?? createPinnedDatasetSource(options.dataset, options.revision);
  const objects = approvedObjects(await source.list());
  const prepared: PreparedSource[] = [];
  for (const [index, object] of objects.entries()) {
    prepared.push(await prepareSource(options, source, object, index));
  }
  const { revision: snapshotRevision, snapshot } = await options.log.createSnapshot();
  const report = await reconcilePrepared(options, prepared, snapshotRevision, snapshot);
  await writeReport(options.reportPath, report);
  return report;
}

export function createPinnedDatasetSource(
  dataset: string,
  revision: string,
  accessToken = process.env["HF_TOKEN"],
): PinnedDatasetSource {
  assertPinnedRevision(revision);
  if (accessToken === undefined || accessToken.length === 0)
    throw new Error("HF_TOKEN is required");
  const repo = { type: "dataset", name: dataset } as const;
  return {
    // eslint-disable-next-line complexity -- Pinned listing validates immutable identity and approved paths.
    async list(): Promise<readonly PinnedSourceObject[]> {
      const objects: PinnedSourceObject[] = [];
      for await (const entry of listFiles({
        repo,
        revision,
        accessToken,
        recursive: true,
        expand: true,
      })) {
        if (entry.type !== "file" || !isApprovedPath(entry.path)) continue;
        const oid = entry.xetHash ?? entry.lfs?.oid ?? entry.oid;
        if (oid === undefined || oid.length === 0) {
          throw new Error(`pinned dataset object has no immutable id: ${entry.path}`);
        }
        objects.push({ path: entry.path, oid, size: entry.size });
      }
      return objects;
    },
    async download(path): Promise<Uint8Array> {
      const blob = await downloadFile({ repo, revision, accessToken, path });
      if (blob === null) throw new Error(`pinned dataset object disappeared: ${path}`);
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

async function prepareSource(
  options: StorageMigrationOptions,
  source: PinnedDatasetSource,
  object: PinnedSourceObject,
  sourceOrder: number,
): Promise<PreparedSource> {
  const bytes = await source.download(object.path);
  const content = decodeUtf8(bytes, object.path);
  const contentSha = sha256(bytes);
  if (object.size !== bytes.byteLength)
    throw new Error(`pinned object size mismatch: ${object.path}`);
  const operation = sourceOperation(object.path, content);
  const digest = sha256(
    canonicalBytes({
      dataset: options.dataset,
      revision: options.revision,
      path: object.path,
      content_sha256: contentSha,
    }),
  );
  const segment = bucketSegmentSchema.parse({
    schema_version: 1,
    transaction_id: deterministicUuid(digest),
    created_at: deterministicTimestamp(sourceOrder),
    operations: [operation],
  });
  const category = operation.mode === "write" ? "config" : sourceKind(operation.path);
  const raw = canonicalBytes(segment);
  const day = segment.created_at.slice(0, 10);
  const target = `v1/segments/${category}/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}/${String(Date.parse(segment.created_at)).padStart(13, "0")}-${segment.transaction_id}-${sha256(raw)}.json.gz`;
  const lines = operation.mode === "append" ? operation.lines : [];
  return {
    object,
    content,
    operation,
    segment,
    evidence: {
      path: object.path,
      source_oid: object.oid,
      byte_length: bytes.byteLength,
      content_sha256: contentSha,
      kind: operation.mode === "write" ? "config" : sourceKind(operation.path),
      rows: lines.length,
      sorted_line_digest: digestStrings(lines),
      target_segment: target,
    },
  };
}

async function reconcilePrepared(
  options: StorageMigrationOptions,
  prepared: readonly PreparedSource[],
  snapshotRevision: string,
  snapshot: BucketSnapshot,
): Promise<StorageMigrationReport> {
  const expectedKeys = prepared.map((item) => item.evidence.target_segment).sort();
  const actualKeys = snapshot.files.map((file) => file.key).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("raw Bucket snapshot does not contain exactly the pinned import segments");
  }
  const sourceEvidence = accumulator();
  const targetEvidence = accumulator();
  for (const item of prepared) collectOperation(item.operation, sourceEvidence);
  for (const file of snapshot.files) {
    const segment = await options.log.loadSegment(file);
    for (const operation of segment.operations) collectOperation(operation, targetEvidence);
  }
  const sourceResult = finishEvidence(sourceEvidence);
  const targetResult = finishEvidence(targetEvidence);
  if (JSON.stringify(sourceResult) !== JSON.stringify(targetResult)) {
    throw new Error("pinned dataset and raw Bucket reconciliation differ");
  }
  return {
    schema_version: 1,
    source: { dataset: options.dataset, revision: options.revision, objects: prepared.length },
    target: {
      bucket: snapshot.bucket,
      snapshot_revision: snapshotRevision,
      objects: snapshot.files.length,
    },
    files: prepared.map((item) => item.evidence),
    reconciliation: {
      ...sourceResult,
      source_paths: prepared.length,
      target_segments: snapshot.files.length,
      passed: true,
    },
  };
}

function collectOperation(operation: BucketOperation, evidence: EvidenceAccumulator): void {
  if (operation.mode === "write") {
    evidence.configs.push(
      `${operation.path}\0${sha256(new TextEncoder().encode(operation.content))}`,
    );
    return;
  }
  const kind = sourceKind(operation.path);
  for (const line of operation.lines) {
    const lineHash = sha256(new TextEncoder().encode(line));
    evidence.rows[kind].push(`${operation.path}\0${lineHash}`);
    const candidate = JSON.parse(line) as Record<string, unknown>;
    if (kind === "tweet") collectTweet(candidate, operation.path, lineHash, evidence);
    else if (kind === "enrichment")
      evidence.enrichments.push(`${String(candidate["unit_id"])}\0${lineHash}`);
    else if (kind === "attempt") evidence.attempts.push(lineHash);
    else if (kind === "registry")
      evidence.registry.push(
        `${String(candidate["name"])}\0${String(candidate["registry_revision"])}\0${lineHash}`,
      );
    else evidence.receipts.push(lineHash);
  }
}

function collectTweet(
  candidate: Record<string, unknown>,
  path: string,
  lineHash: string,
  evidence: EvidenceAccumulator,
): void {
  const validated = validateTweet(candidate);
  if (!validated.ok) throw new Error(`invalid tweet reached reconciliation: ${path}`);
  const tweet = validated.tweet as PooledTweet;
  const pathContributor = path.split("/")[1] ?? "unknown";
  const contributor =
    typeof candidate["contributed_by"] === "string" && candidate["contributed_by"].length > 0
      ? candidate["contributed_by"]
      : pathContributor;
  const identity = `${tweet.id}\0${contributor}`;
  evidence.tweetIdentities.push(`${identity}\0${lineHash}`);
  evidence.uniqueTweetIdentities.add(identity);
  increment(evidence.contributors, contributor);
  increment(evidence.captureDays, tweet.captured_at.slice(0, 10));
}

function finishEvidence(
  evidence: EvidenceAccumulator,
): Omit<MigrationReconciliation, "source_paths" | "target_segments" | "passed"> {
  const rowCounts = Object.fromEntries(
    (Object.keys(evidence.rows) as SourceKind[]).map((kind) => [kind, evidence.rows[kind].length]),
  ) as Record<SourceKind, number>;
  const rowDigests = Object.fromEntries(
    (Object.keys(evidence.rows) as SourceKind[]).map((kind) => [
      kind,
      digestStrings(evidence.rows[kind]),
    ]),
  ) as Record<SourceKind, string>;
  return {
    rows: rowCounts,
    sorted_line_digests: rowDigests,
    tweet_identity_rows: evidence.tweetIdentities.length,
    tweet_identity_digest: digestStrings(evidence.tweetIdentities),
    unique_tweet_identities: evidence.uniqueTweetIdentities.size,
    unique_tweet_identity_digest: digestStrings([...evidence.uniqueTweetIdentities]),
    contributor_counts_digest: digestMap(evidence.contributors),
    capture_day_counts_digest: digestMap(evidence.captureDays),
    enrichment_identity_digest: digestStrings(evidence.enrichments),
    attempt_row_digest: digestStrings(evidence.attempts),
    registry_identity_digest: digestStrings(evidence.registry),
    receipt_row_digest: digestStrings(evidence.receipts),
    config_content_digest: digestStrings(evidence.configs),
  };
}

function accumulator(): EvidenceAccumulator {
  return {
    rows: { tweet: [], enrichment: [], attempt: [], registry: [], receipt: [] },
    tweetIdentities: [],
    uniqueTweetIdentities: new Set(),
    contributors: new Map(),
    captureDays: new Map(),
    enrichments: [],
    attempts: [],
    registry: [],
    receipts: [],
    configs: [],
  };
}

function sourceOperation(path: string, content: string): BucketOperation {
  if (CONFIG_PATHS.has(path)) return { path, mode: "write", content };
  assertValidSource(path, content);
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error(`approved source has no valid records: ${path}`);
  if (new Set(lines).size !== lines.length) {
    throw new Error(`approved source contains a duplicate line: ${path}`);
  }
  return { path, mode: "append", lines };
}

function approvedObjects(objects: readonly PinnedSourceObject[]): PinnedSourceObject[] {
  const approved = objects
    .filter((object) => isApprovedPath(object.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (approved.length === 0) throw new Error("pinned dataset has no approved durable objects");
  const paths = approved.map((object) => object.path);
  if (new Set(paths).size !== paths.length)
    throw new Error("pinned dataset contains duplicate approved paths");
  return approved;
}

function isApprovedPath(path: string): boolean {
  return SOURCE_PATH.test(path) || CONFIG_PATHS.has(path);
}

function deterministicTimestamp(sourceOrder: number): string {
  // Preserve sorted source-shard chronology and sort every imported write
  // before post-cutover runtime transactions.
  return new Date(sourceOrder).toISOString();
}

function assertPinnedRevision(revision: string): void {
  if (!PINNED_REVISION.test(revision))
    throw new Error("dataset revision must be an explicit 40-character commit SHA");
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`pinned dataset object is not valid UTF-8: ${path}`);
  }
}

function digestStrings(values: readonly string[]): string {
  return createHash("sha256")
    .update([...values].sort().join("\n"))
    .digest("hex");
}

function digestMap(values: ReadonlyMap<string, number>): string {
  return digestStrings([...values].map(([key, value]) => `${key}\0${String(value)}`));
}

function increment(values: Map<string, number>, key: string): void {
  values.set(key, (values.get(key) ?? 0) + 1);
}

async function writeReport(path: string, report: StorageMigrationReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}
