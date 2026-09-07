import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalBytes, compareSegmentKeys, sha256 } from "./bucket-log.js";
import type { BucketSnapshot } from "./bucket-log.js";
import { DurableIndex } from "./durable-index.js";
import type { DurableIndexOptions } from "./durable-index.js";

const bounds = z.object({
  chunkSize: z.number().int().min(1).max(500).default(128),
  maxSegments: z.number().int().positive().default(Number.MAX_SAFE_INTEGER),
});
export type BootstrapProgress = { completed: number; total: number; source: string };
export type BootstrapOptions = DurableIndexOptions & {
  sourceRevision: string;
  chunkSize?: number;
  maxSegments?: number;
  signal?: AbortSignal;
  onCheckpoint?: (progress: BootstrapProgress) => Promise<void>;
};

/** Explicit repair path only. Its target is immutable and its SQLite transactions
 * save real partial work. Nothing here uploads an index or replaces a live pointer. */
export async function prepareIndexBootstrap(options: BootstrapOptions): Promise<{
  index: DurableIndex;
  progress: BootstrapProgress;
  complete: boolean;
}> {
  const limits = bounds.parse(options);
  const snapshot = await options.log.loadSnapshot(options.sourceRevision);
  await pinTarget(options.databasePath, snapshot, options.sourceRevision);
  const index = existsSync(options.databasePath)
    ? DurableIndex.openLocal(options)
    : await DurableIndex.createEmpty(options);
  try {
    index.consumerBoundary();
    const ordered = [...snapshot.files].sort((a, b) => compareSegmentKeys(a.key, b.key));
    const applied = index.sourceSnapshot();
    const completed = assertPrefix(applied, ordered);
    let position = completed;
    const stop = Math.min(ordered.length, completed + limits.maxSegments);
    while (position < stop && !options.signal?.aborted) {
      const next = Math.min(stop, position + limits.chunkSize);
      const prefix: BucketSnapshot = {
        ...snapshot,
        files: ordered.slice(0, next).sort((a, b) => a.key.localeCompare(b.key)),
      };
      await index.advanceToDiscovered(sha256(canonicalBytes(prefix)), prefix);
      position = next;
      await options.onCheckpoint?.({
        completed: position,
        total: ordered.length,
        source: options.sourceRevision,
      });
    }
    const complete = position === ordered.length;
    if (complete) index.verify();
    return {
      index,
      complete,
      progress: { completed: position, total: ordered.length, source: options.sourceRevision },
    };
  } catch (error) {
    index.close();
    throw error;
  }
}

async function pinTarget(path: string, snapshot: BucketSnapshot, revision: string): Promise<void> {
  const bytes = canonicalBytes(snapshot);
  if (sha256(bytes) !== revision) throw new Error("bootstrap source checksum mismatch");
  const targetPath = `${path}.source.json`;
  await mkdir(dirname(targetPath), { recursive: true });
  if (!existsSync(targetPath)) await writeExclusiveTarget(targetPath, bytes);
  if (sha256(await readFile(targetPath)) !== revision)
    throw new Error(
      "bootstrap target changed; use a separate working directory for another source",
    );
}

async function writeExclusiveTarget(path: string, bytes: Uint8Array): Promise<void> {
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(staged, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(staged, path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  } finally {
    await rm(staged, { force: true });
  }
}

function assertPrefix(applied: BucketSnapshot, ordered: BucketSnapshot["files"]): number {
  const prefix = new Map(ordered.slice(0, applied.files.length).map((file) => [file.key, file]));
  for (const file of applied.files) {
    const expected = prefix.get(file.key);
    if (expected === undefined || sha256(canonicalBytes(expected)) !== sha256(canonicalBytes(file)))
      throw new Error("bootstrap database is not an exact prefix of its frozen source");
  }
  return applied.files.length;
}
