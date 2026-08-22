/* eslint-disable @typescript-eslint/require-await -- In-memory fakes implement asynchronous storage interfaces. */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- Assertions first prove fixture values exist. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  assertValidSource,
  BucketLog,
  bucketSegmentSchema,
  canonicalBytes,
  deterministicUuid,
  parseJsonlTweets,
  readCachedText,
  receiptsInSegment,
  sha256,
  sourceKind,
} from "../src/bucket-log.js";
import type { BucketObject, RawBucketClient } from "../src/bucket-log.js";
import { makePooled } from "./helpers.js";

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

class MemoryBucket implements RawBucketClient {
  readonly files = new Map<string, Uint8Array>();
  readonly downloads: string[] = [];
  failUpload = false;
  downloadDelayMs = 0;
  activeDownloads = 0;
  maxActiveDownloads = 0;

  async list(prefix: string): Promise<readonly BucketObject[]> {
    return [...this.files]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, content]) => ({ key, oid: sha256(content), size: content.byteLength }));
  }

  async download(key: string): Promise<Uint8Array | undefined> {
    this.downloads.push(key);
    this.activeDownloads += 1;
    this.maxActiveDownloads = Math.max(this.maxActiveDownloads, this.activeDownloads);
    try {
      if (this.downloadDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.downloadDelayMs));
      }
      const content = this.files.get(key);
      return content === undefined ? undefined : new Uint8Array(content);
    } finally {
      this.activeDownloads -= 1;
    }
  }

  async upload(key: string, content: Uint8Array): Promise<void> {
    if (this.failUpload) throw new Error("upload failed");
    this.files.set(key, new Uint8Array(content));
  }
}

function log(bucket = new MemoryBucket()): { bucket: MemoryBucket; log: BucketLog } {
  return {
    bucket,
    log: new BucketLog(
      "osolmaz/xtap-pool-data",
      bucket,
      mkdtempSync(join(tmpdir(), "xtap-bucket-log-")),
      () => new Date("2026-08-12T12:34:56.789Z"),
    ),
  };
}

describe("BucketLog", () => {
  it("stores deterministic gzip with a checksum-addressed immutable key", async () => {
    const state = log();
    const key = await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    expect(key).toMatch(/v1\/segments\/receipt\/2026\/08\/12\/.*-[a-f0-9]{64}\.json\.gz$/u);
    const compressed = state.bucket.files.get(key);
    expect(compressed).toBeDefined();
    const raw = new Uint8Array(await gunzipAsync(compressed!));
    expect(key).toContain(sha256(raw));
    expect(bucketSegmentSchema.parse(JSON.parse(new TextDecoder().decode(raw)))).toMatchObject({
      schema_version: 1,
      created_at: "2026-08-12T12:34:56.789Z",
    });
  });

  it("makes import retries idempotent for the same segment", async () => {
    const state = log();
    const segment = bucketSegmentSchema.parse({
      schema_version: 1,
      transaction_id: "dfbc9fea-f42c-42d8-ae2d-44f909c417bf",
      created_at: "2026-08-12T12:34:56.789Z",
      operations: [
        {
          path: "enrichment/receipts/2026-08-12.jsonl",
          mode: "append",
          lines: [legacyReceipt()],
        },
      ],
    });
    const first = await state.log.putSegment(segment);
    const second = await state.log.putSegment(segment);
    expect(second).toBe(first);
    expect(state.bucket.files.size).toBe(1);
  });

  it("rejects a conflicting object under the checksum key", async () => {
    const state = log();
    const segment = bucketSegmentSchema.parse({
      schema_version: 1,
      transaction_id: "dfbc9fea-f42c-42d8-ae2d-44f909c417bf",
      created_at: "2026-08-12T12:34:56.789Z",
      operations: [
        {
          path: "enrichment/receipts/2026-08-12.jsonl",
          mode: "append",
          lines: [legacyReceipt()],
        },
      ],
    });
    const key = await state.log.putSegment(segment);
    state.bucket.files.set(key, new TextEncoder().encode("wrong"));
    await expect(state.log.putSegment(segment)).rejects.toThrow("not valid gzip");
  });

  it("does not retain a segment when upload fails", async () => {
    const state = log();
    state.bucket.failUpload = true;
    await expect(
      state.log.commitBatch(
        [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
        [],
      ),
    ).rejects.toThrow("upload failed");
    expect(state.bucket.files.size).toBe(0);
  });

  it("creates stable exact snapshots and detects segment mutations", async () => {
    const state = log();
    const segmentKey = await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    const first = await state.log.createSnapshot();
    expect(first.snapshot.files[0]?.oid).toBe(sha256(state.bucket.files.get(segmentKey)!));
    const second = await state.log.createSnapshot();
    expect(second.revision).toBe(first.revision);
    expect(second.snapshot).toEqual(first.snapshot);
    state.bucket.files.set(segmentKey, new Uint8Array([1, 2, 3]));
    await expect(state.log.loadSegment(first.snapshot.files[0]!)).rejects.toThrow("size mismatch");
  });

  it("replays only the verified tail with bounded downloads in chronological order", async () => {
    const state = log();
    const base = bucketSegmentSchema.parse({
      schema_version: 1,
      transaction_id: "11111111-1111-4111-8111-111111111111",
      created_at: "2026-08-12T12:00:00.000Z",
      operations: [
        {
          path: "enrichment/receipts/2026-08-12.jsonl",
          mode: "append",
          lines: [legacyReceipt()],
        },
      ],
    });
    const baseKey = await state.log.putSegment(base);
    const snapshot = await state.log.createSnapshot();
    const laterKey = await state.log.putSegment(
      bucketSegmentSchema.parse({
        ...base,
        transaction_id: "33333333-3333-4333-8333-333333333333",
        created_at: "2026-08-12T12:02:00.000Z",
        operations: [
          {
            path: "data/osolmaz/2026/08/tweets-2026-08-12.jsonl",
            mode: "append",
            lines: [JSON.stringify(makePooled({ id: "later" }))],
          },
        ],
      }),
    );
    const earlierKey = await state.log.putSegment(
      bucketSegmentSchema.parse({
        ...base,
        transaction_id: "22222222-2222-4222-8222-222222222222",
        created_at: "2026-08-12T12:01:00.000Z",
      }),
    );
    state.bucket.downloads.length = 0;
    state.bucket.maxActiveDownloads = 0;
    state.bucket.downloadDelayMs = 5;
    const consumed: string[] = [];
    const progress: [number, number][] = [];
    await state.log.replayVerifiedTail(snapshot.snapshot.files, {
      concurrency: 2,
      progress: async (completed, total) => {
        progress.push([completed, total]);
      },
      consume: async (file) => {
        consumed.push(file.key);
      },
    });
    expect(consumed).toEqual([earlierKey, laterKey]);
    expect(state.bucket.downloads).not.toContain(baseKey);
    expect(state.bucket.downloads.sort()).toEqual([earlierKey, laterKey].sort());
    expect(state.bucket.maxActiveDownloads).toBe(2);
    expect(progress).toEqual([[2, 2]]);
  });

  it("derives snapshot object identity when Bucket listings omit it", async () => {
    const state = log();
    const key = await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    const originalList = state.bucket.list.bind(state.bucket);
    state.bucket.list = async (prefix) =>
      (await originalList(prefix)).map(({ key: objectKey, size }) => ({ key: objectKey, size }));

    const { snapshot } = await state.log.createSnapshot();

    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]?.oid).toBe(sha256(state.bucket.files.get(key)!));
  });

  it("rejects objects that disappear or change size during snapshot creation", async () => {
    const missing = log();
    await missing.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    missing.bucket.download = async () => undefined;
    await expect(missing.log.createSnapshot()).rejects.toThrow("disappeared");

    const resized = log();
    await resized.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    const originalList = resized.bucket.list.bind(resized.bucket);
    resized.bucket.list = async (prefix) =>
      (await originalList(prefix)).map((object) => ({ ...object, size: object.size + 1 }));
    await expect(resized.log.createSnapshot()).rejects.toThrow("size changed");
  });

  it("rejects corrupt and noncanonical objects during snapshot creation", async () => {
    const corrupt = log();
    const corruptKey = await corrupt.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    corrupt.bucket.files.set(corruptKey, new Uint8Array([1, 2, 3]));
    await expect(corrupt.log.createSnapshot()).rejects.toThrow("not valid gzip");

    const noncanonical = log();
    const segment = bucketSegmentSchema.parse({
      schema_version: 1,
      transaction_id: "dfbc9fea-f42c-42d8-ae2d-44f909c417bf",
      created_at: "2026-08-12T12:34:56.789Z",
      operations: [
        { path: "enrichment/receipts/2026-08-12.jsonl", mode: "append", lines: [legacyReceipt()] },
      ],
    });
    const pretty = new TextEncoder().encode(JSON.stringify(segment, null, 2));
    const digest = sha256(pretty);
    const key = `v1/segments/receipt/2026/08/12/1786538096789-${segment.transaction_id}-${digest}.json.gz`;
    noncanonical.bucket.files.set(key, new Uint8Array(await gzipAsync(pretty)));
    await expect(noncanonical.log.createSnapshot()).rejects.toThrow("not canonical");
  });

  it("rejects deletion and resize while discovering an indexed head", async () => {
    const deleted = log();
    await deleted.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    const deletedHead = await deleted.log.discoverSnapshot();
    deleted.bucket.files.clear();
    await expect(deleted.log.discoverSnapshot(deletedHead.snapshot.files)).rejects.toThrow(
      "were deleted",
    );

    const resized = log();
    await resized.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    const resizedHead = await resized.log.discoverSnapshot();
    const originalList = resized.bucket.list.bind(resized.bucket);
    resized.bucket.list = async (prefix) =>
      (await originalList(prefix)).map((object) => ({ ...object, size: object.size + 1 }));
    await expect(resized.log.discoverSnapshot(resizedHead.snapshot.files)).rejects.toThrow(
      "size changed",
    );
  });

  it("reuses known metadata when the listed object identity is unchanged", async () => {
    const state = log();
    await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    const first = await state.log.discoverSnapshot();
    state.bucket.download = async () => {
      throw new Error("known body must not be downloaded");
    };

    await expect(state.log.discoverSnapshot(first.snapshot.files)).resolves.toEqual(first);
  });

  it("rejects a same-size rewrite while discovering an indexed head", async () => {
    const state = log();
    await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    const first = await state.log.discoverSnapshot();
    const file = first.snapshot.files[0]!;
    const content = state.bucket.files.get(file.key)!;
    const changed = new Uint8Array(content);
    changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    state.bucket.files.set(file.key, changed);

    await expect(state.log.discoverSnapshot(first.snapshot.files)).rejects.toThrow(
      "source segment changed",
    );
  });

  it("revalidates known bodies when Bucket listings omit object identity", async () => {
    const state = log();
    await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    const first = await state.log.discoverSnapshot();
    const originalList = state.bucket.list.bind(state.bucket);
    state.bucket.list = async (prefix) =>
      (await originalList(prefix)).map(({ key, size }) => ({ key, size }));

    await expect(state.log.discoverSnapshot(first.snapshot.files)).resolves.toEqual(first);
  });

  it("rejects a valid segment stored under the wrong category key", async () => {
    const state = log();
    const key = await state.log.commitBatch([], [{ path: "config/pool.json", content: "{}" }]);
    const content = state.bucket.files.get(key)!;
    state.bucket.files.delete(key);
    state.bucket.files.set(key.replace("/config/", "/tweet/"), content);

    await expect(state.log.createSnapshot()).rejects.toThrow(
      "segment key does not match its contents",
    );
  });

  it("rejects changed bytes that retain the same object size", async () => {
    const state = log();
    await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [],
    );
    const { snapshot } = await state.log.createSnapshot();
    const file = snapshot.files[0]!;
    const content = state.bucket.files.get(file.key)!;
    const changed = new Uint8Array(content);
    changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    state.bucket.files.set(file.key, changed);

    await expect(state.log.loadSegment(file)).rejects.toThrow("object identity mismatch");
  });

  it("orders configuration writes by timestamp and transaction ID", async () => {
    const state = log();
    await state.log.putSegment(
      bucketSegmentSchema.parse({
        schema_version: 1,
        transaction_id: "00000000-0000-4000-8000-000000000001",
        created_at: "2026-08-12T12:00:00.000Z",
        operations: [{ path: "config/pool.json", mode: "write", content: "old" }],
      }),
    );
    await state.log.putSegment(
      bucketSegmentSchema.parse({
        schema_version: 1,
        transaction_id: "00000000-0000-4000-8000-000000000002",
        created_at: "2026-08-12T12:00:00.000Z",
        operations: [{ path: "config/pool.json", mode: "write", content: "new" }],
      }),
    );
    await expect(state.log.readText("config/pool.json")).resolves.toBe("new");
  });

  it("compares all mixed writes with dedicated configuration writes", async () => {
    const state = log();
    const oldMixed = await state.log.putSegment(
      bucketSegmentSchema.parse({
        schema_version: 1,
        transaction_id: "00000000-0000-4000-8000-000000000001",
        created_at: "2026-08-12T12:00:00.000Z",
        operations: [
          { path: "config/labels.json", mode: "write", content: "old" },
          {
            path: "enrichment/receipts/2026-08-12.jsonl",
            mode: "append",
            lines: [legacyReceipt()],
          },
        ],
      }),
    );
    const dedicated = await state.log.putSegment(
      bucketSegmentSchema.parse({
        schema_version: 1,
        transaction_id: "00000000-0000-4000-8000-000000000002",
        created_at: "2026-08-12T12:10:00.000Z",
        operations: [{ path: "config/labels.json", mode: "write", content: "new" }],
      }),
    );
    const laterMixed = await state.log.putSegment(
      bucketSegmentSchema.parse({
        schema_version: 1,
        transaction_id: "00000000-0000-4000-8000-000000000003",
        created_at: "2026-08-12T12:20:00.000Z",
        operations: [
          { path: "config/pool.json", mode: "write", content: "other" },
          {
            path: "enrichment/receipts/2026-08-12.jsonl",
            mode: "append",
            lines: [legacyReceipt()],
          },
        ],
      }),
    );
    const { snapshot } = await state.log.createSnapshot();
    state.bucket.downloads.length = 0;
    const progress: [number, number][] = [];

    await expect(
      state.log.readText("config/labels.json", {
        snapshot,
        concurrency: 4,
        progress: async (completed, total) => {
          progress.push([completed, total]);
        },
      }),
    ).resolves.toBe("new");

    expect(state.bucket.downloads).toContain(oldMixed);
    expect(state.bucket.downloads).toContain(dedicated);
    expect(state.bucket.downloads).toContain(laterMixed);
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it("primes all configuration values with one bounded snapshot scan", async () => {
    const state = log();
    await state.log.putSegment(
      bucketSegmentSchema.parse({
        schema_version: 1,
        transaction_id: "00000000-0000-4000-8000-000000000001",
        created_at: "2026-08-12T12:00:00.000Z",
        operations: [{ path: "config/pool.json", mode: "write", content: "pool" }],
      }),
    );
    await state.log.putSegment(
      bucketSegmentSchema.parse({
        schema_version: 1,
        transaction_id: "00000000-0000-4000-8000-000000000002",
        created_at: "2026-08-12T12:10:00.000Z",
        operations: [
          { path: "config/labels.json", mode: "write", content: "labels" },
          {
            path: "config/service-accounts.json",
            mode: "write",
            content: "accounts",
          },
        ],
      }),
    );
    const { snapshot } = await state.log.createSnapshot();
    state.bucket.downloads.length = 0;
    const progress: [number, number][] = [];

    await state.log.primeTextCache(snapshot, 4, (completed, total) => {
      progress.push([completed, total]);
      return Promise.resolve();
    });
    const downloads = state.bucket.downloads.length;

    await expect(state.log.readText("config/pool.json")).resolves.toBe("pool");
    await expect(state.log.readText("config/labels.json")).resolves.toBe("labels");
    await expect(state.log.readText("config/service-accounts.json")).resolves.toBe("accounts");
    expect(state.bucket.downloads).toHaveLength(downloads);
    expect(progress.at(-1)).toEqual([2, 2]);
  });

  it("primes configuration from one complete anchor and its bounded tail", async () => {
    const state = log();
    const oldMixed = await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [{ path: "config/pool.json", content: "old" }],
    );
    const anchor = await state.log.commitBatch(
      [],
      [
        { path: "config/labels.json", content: "labels" },
        { path: "config/pool.json", content: "pool" },
        { path: "config/service-accounts.json", content: "accounts" },
        { path: "enrichment/vocabulary.json", content: "vocabulary" },
      ],
    );
    const tail = await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [{ path: "config/pool.json", content: "new" }],
    );
    const { snapshot } = await state.log.createSnapshot();
    state.bucket.downloads.length = 0;
    const progress: [number, number][] = [];

    await state.log.primeTextCacheFromAnchor(snapshot, 4, (completed, total) => {
      progress.push([completed, total]);
      return Promise.resolve();
    });

    expect(state.bucket.downloads).not.toContain(oldMixed);
    expect(state.bucket.downloads).toContain(anchor);
    expect(state.bucket.downloads).toContain(tail);
    await expect(state.log.readText("config/labels.json")).resolves.toBe("labels");
    await expect(state.log.readText("config/pool.json")).resolves.toBe("new");
    await expect(state.log.readText("config/service-accounts.json")).resolves.toBe("accounts");
    await expect(state.log.readText("enrichment/vocabulary.json")).resolves.toBe("vocabulary");
    expect(progress.at(-1)).toEqual([2, 2]);
  });

  it("fails closed when the configuration anchor is incomplete", async () => {
    const state = log();
    await state.log.commitBatch([], [{ path: "config/pool.json", content: "pool" }]);
    const { snapshot } = await state.log.createSnapshot();

    await expect(state.log.primeTextCacheFromAnchor(snapshot)).rejects.toThrow(
      "complete Bucket configuration anchor is missing",
    );
  });

  it("rejects duplicate paths, unsupported paths, and malformed records", async () => {
    expect(() =>
      bucketSegmentSchema.parse({
        schema_version: 1,
        transaction_id: "dfbc9fea-f42c-42d8-ae2d-44f909c417bf",
        created_at: "2026-08-12T12:34:56.789Z",
        operations: [
          { path: "config/pool.json", mode: "write", content: "a" },
          { path: "config/pool.json", mode: "write", content: "b" },
        ],
      }),
    ).toThrow("operation paths must be unique");
    const state = log();
    await expect(
      state.log.putSegment(
        bucketSegmentSchema.parse({
          schema_version: 1,
          transaction_id: "dfbc9fea-f42c-42d8-ae2d-44f909c417bf",
          created_at: "2026-08-12T12:34:56.789Z",
          operations: [{ path: "config/unknown.json", mode: "write", content: "x" }],
        }),
      ),
    ).rejects.toThrow("unsupported Bucket configuration path");
    await expect(
      state.log.putSegment(
        bucketSegmentSchema.parse({
          schema_version: 1,
          transaction_id: "dfbc9fea-f42c-42d8-ae2d-44f909c417bf",
          created_at: "2026-08-12T12:34:56.789Z",
          operations: [
            { path: "enrichment/receipts/2026-08-12.jsonl", mode: "append", lines: ["no"] },
          ],
        }),
      ),
    ).rejects.toThrow("invalid JSON");
  });

  it("replays receipt metadata without scanning older mixed segments", async () => {
    const state = log();
    await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [legacyReceipt()] }],
      [{ path: "config/pool.json", content: "mixed" }],
    );
    await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [currentReceipt()] }],
      [],
    );
    const { snapshot } = await state.log.createSnapshot();
    state.bucket.downloads.length = 0;
    await state.log.hydrateMetadata(snapshot);
    expect(state.log.latestReceipt()?.worker_id).toBe("worker-1");
    expect(state.bucket.downloads.some((key) => key.includes("/mixed/"))).toBe(false);

    const tweet = makePooled({ id: "55", contributed_by: "alice" });
    const retained = makePooled({ id: "56", contributed_by: "bob" });
    const parsed = parseJsonlTweets(
      `${JSON.stringify({ ...tweet, contributed_by: undefined, pooled_at: undefined })}\n${JSON.stringify(retained)}\ninvalid\n`,
      "data/alice/2026/08/tweets-2026-08-12.jsonl",
    );
    expect(parsed).toMatchObject([
      { id: "55", contributed_by: "alice" },
      { id: "56", contributed_by: "bob", pooled_at: retained.pooled_at },
    ]);
    expect(readCachedText("/missing", "config/pool.json")).toBeUndefined();
  });

  it("hydrates receipts from validated database membership without scanning unrelated mixed bodies", async () => {
    const state = log();
    const tweet = makePooled({ id: "54", contributed_by: "alice" });
    const unrelatedMixed = await state.log.putSegment(
      bucketSegmentSchema.parse({
        schema_version: 1,
        transaction_id: "00000000-0000-4000-8000-000000000001",
        created_at: "2026-08-12T12:00:00.000Z",
        operations: [
          { path: "config/pool.json", mode: "write", content: "mixed" },
          {
            path: "data/alice/2026/08/tweets-2026-08-12.jsonl",
            mode: "append",
            lines: [JSON.stringify(tweet)],
          },
        ],
      }),
    );
    const receiptKey = await state.log.putSegment(
      bucketSegmentSchema.parse({
        schema_version: 1,
        transaction_id: "00000000-0000-4000-8000-000000000002",
        created_at: "2026-08-12T12:10:00.000Z",
        operations: [
          {
            path: "enrichment/receipts/2026-08-12.jsonl",
            mode: "append",
            lines: [currentReceipt()],
          },
        ],
      }),
    );
    const { snapshot } = await state.log.createSnapshot();
    const receiptFile = snapshot.files.find((file) => file.key === receiptKey)!;
    state.bucket.downloads.length = 0;
    const progress: [number, number][] = [];

    await state.log.hydrateMetadata(snapshot, {
      concurrency: 4,
      receiptFiles: [receiptFile],
      progress: async (completed, total) => {
        progress.push([completed, total]);
      },
    });

    expect(state.log.latestReceipt()?.worker_id).toBe("worker-1");
    expect(state.bucket.downloads).not.toContain(unrelatedMixed);
    expect(state.bucket.downloads).toContain(receiptKey);
    expect(progress).toEqual([[1, 1]]);
  });

  it("preserves the latest registry cursor when a newer receipt has no scan", async () => {
    const state = log();
    await state.log.commitBatch(
      [
        {
          path: "enrichment/receipts/2026-08-12.jsonl",
          lines: [
            currentReceipt("registry-worker", "2026-08-12T12:01:00.000Z", {
              after_name: "last-label",
              scanned: 15_840,
              total: 25_675,
              complete: false,
            }),
          ],
        },
      ],
      [],
    );
    await state.log.commitBatch(
      [
        {
          path: "enrichment/receipts/2026-08-12.jsonl",
          lines: [currentReceipt("newer-worker", "2026-08-12T12:02:00.000Z")],
        },
      ],
      [],
    );
    const { snapshot } = await state.log.createSnapshot();

    await state.log.hydrateMetadata(snapshot);

    expect(state.log.latestReceipt()?.worker_id).toBe("newer-worker");
    expect(state.log.latestRegistryReceipt()).toMatchObject({
      worker_id: "registry-worker",
      registry_scan: { after_name: "last-label", scanned: 15_840 },
    });
  });

  it("selects a newer current receipt from a mixed segment", async () => {
    const state = log();
    await state.log.commitBatch(
      [
        {
          path: "enrichment/receipts/2026-08-12.jsonl",
          lines: [currentReceipt("older-worker", "2026-08-12T12:01:00.000Z")],
        },
      ],
      [],
    );
    await state.log.commitBatch(
      [
        {
          path: "enrichment/receipts/2026-08-12.jsonl",
          lines: [currentReceipt("newer-worker", "2026-08-12T12:36:00.000Z")],
        },
      ],
      [{ path: "config/pool.json", content: "mixed" }],
    );
    const { snapshot } = await state.log.createSnapshot();
    state.bucket.downloads.length = 0;

    await state.log.hydrateMetadata(snapshot);

    expect(state.log.latestReceipt()?.worker_id).toBe("newer-worker");
    expect(state.bucket.downloads.some((key) => key.includes("/mixed/"))).toBe(true);
  });

  it("uses mixed segments as a legacy receipt fallback", async () => {
    const state = log();
    await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [currentReceipt()] }],
      [{ path: "config/pool.json", content: "mixed" }],
    );
    const { snapshot } = await state.log.createSnapshot();
    state.bucket.downloads.length = 0;

    await state.log.hydrateMetadata(snapshot);

    expect(state.log.latestReceipt()?.worker_id).toBe("worker-1");
    expect(state.bucket.downloads.some((key) => key.includes("/mixed/"))).toBe(true);
  });

  it("rejects invalid segment identities and cache escapes", async () => {
    const state = log();
    await expect(
      state.log.putSegment(
        bucketSegmentSchema.parse({
          schema_version: 1,
          transaction_id: "dfbc9fea-f42c-42d8-ae2d-44f909c417bf",
          created_at: "2026-08-12T12:34:56.789Z",
          operations: [{ path: "config/pool.json", mode: "write", content: "x" }],
        }),
      ),
    ).resolves.toBeTruthy();
    await expect(state.log.writeText("../escape", "x")).rejects.toThrow(
      "unsupported Bucket configuration path",
    );
    expect(() => deterministicUuid("bad")).toThrow("SHA-256");
  });

  it("validates and classifies every durable source kind", () => {
    const tweet = makePooled({ id: "77", contributed_by: "alice" });
    const cases = [
      ["data/alice/2026/08/tweets-2026-08-12.jsonl", "tweet", JSON.stringify(tweet)],
      [
        "enrichment/2026/08/enrichment-2026-08-12.jsonl",
        "enrichment",
        JSON.stringify({
          unit_id: "77:alice",
          tweet_ids: ["77"],
          labels: [],
          free_labels: [],
          concepts: [],
          model: "model",
          taxonomy_version: 1,
          enriched_at: "2026-08-12T12:00:00.000Z",
        }),
      ],
      [
        "enrichment/attempts/2026/08/attempts-2026-08-12.jsonl",
        "attempt",
        JSON.stringify({
          unit_id: "77:alice",
          input_hash: "input",
          contract_hash: "contract",
          attempt: 1,
          outcome: "success",
          at: "2026-08-12T12:00:00.000Z",
        }),
      ],
      [
        "enrichment/registry/2026/08/registry-2026-08-12.jsonl",
        "registry",
        JSON.stringify({
          name: "example",
          status: "candidate",
          at: "2026-08-12T12:00:00.000Z",
          contract_hash: "contract",
          registry_revision: 1,
          quotes: [],
          actor: "worker",
        }),
      ],
      ["enrichment/receipts/2026-08-12.jsonl", "receipt", currentReceipt()],
    ] as const;
    for (const [path, kind, line] of cases) {
      expect(sourceKind(path)).toBe(kind);
      expect(() => {
        assertValidSource(path, `${line}\n`);
      }).not.toThrow();
    }
    expect(() => sourceKind("unknown.jsonl")).toThrow("unsupported Bucket log source");
    expect(() => {
      assertValidSource(cases[2][0], "{}\n");
    }).toThrow("invalid attempt record");
  });

  it("stores mixed transactions and replays their configuration write", async () => {
    const state = log();
    const key = await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [currentReceipt()] }],
      [{ path: "config/pool.json", content: "mixed" }],
    );
    expect(key).toContain("/segments/mixed/");
    await expect(state.log.readText("config/pool.json")).resolves.toBe("mixed");
  });

  it("uses a loaded snapshot to skip unrelated historical bodies", async () => {
    const state = log();
    const receiptKey = await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [currentReceipt()] }],
      [],
    );
    const labels = JSON.stringify([{ name: "ai", description: "Artificial intelligence" }]);
    const configKey = await state.log.commitBatch(
      [],
      [{ path: "config/labels.json", content: labels }],
    );
    const created = await state.log.createSnapshot();
    const reader = {
      list: state.bucket.list.bind(state.bucket),
      download: state.bucket.download.bind(state.bucket),
    };
    const restored = new BucketLog(
      "osolmaz/xtap-pool-data",
      reader,
      mkdtempSync(join(tmpdir(), "xtap-bucket-log-read-only-")),
    );
    await restored.loadSnapshot(created.revision);
    state.bucket.downloads.length = 0;

    await expect(restored.readText("config/labels.json")).resolves.toBe(labels);
    expect(state.bucket.downloads).toContain(configKey);
    expect(state.bucket.downloads).not.toContain(receiptKey);
  });

  it("fails closed when a read-only log attempts a write", async () => {
    const state = log();
    const restored = new BucketLog(
      "osolmaz/xtap-pool-data",
      {
        list: state.bucket.list.bind(state.bucket),
        download: state.bucket.download.bind(state.bucket),
      },
      mkdtempSync(join(tmpdir(), "xtap-bucket-log-read-only-")),
    );
    await expect(
      restored.commitBatch([], [{ path: "config/pool.json", content: "forbidden" }]),
    ).rejects.toThrow("raw Bucket is read-only");
  });

  it("extracts only current receipts from receipt segments", () => {
    const segment = bucketSegmentSchema.parse({
      schema_version: 1,
      transaction_id: "dfbc9fea-f42c-42d8-ae2d-44f909c417bf",
      created_at: "2026-08-12T12:34:56.789Z",
      operations: [
        {
          path: "enrichment/receipts/2026-08-12.jsonl",
          mode: "append",
          lines: [legacyReceipt(), currentReceipt()],
        },
      ],
    });
    expect(receiptsInSegment(segment)).toMatchObject([{ worker_id: "worker-1" }]);
  });

  it("derives stable UUIDs from import digests", () => {
    const digest = sha256(canonicalBytes({ source: "file" }));
    expect(deterministicUuid(digest)).toBe(deterministicUuid(digest));
    expect(deterministicUuid(digest)).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

function currentReceipt(
  workerId = "worker-1",
  finishedAt = "2026-08-12T12:01:00.000Z",
  registryScan?: {
    after_name: string;
    scanned: number;
    total: number;
    complete: boolean;
  },
): string {
  return JSON.stringify({
    started_at: "2026-08-12T12:00:00.000Z",
    finished_at: finishedAt,
    units: 1,
    calls: 1,
    prompt_tokens: 1,
    completion_tokens: 1,
    cost_usd: 0,
    failures: 0,
    retries: 0,
    blocked: 0,
    contract_hash: "contract",
    worker_id: workerId,
    discarded_assignments: 0,
    new_candidates: 0,
    new_approvals: 0,
    new_rejections: 0,
    ...(registryScan === undefined ? {} : { registry_scan: registryScan }),
  });
}

function legacyReceipt(): string {
  return JSON.stringify({
    started_at: "2026-08-12T12:00:00.000Z",
    finished_at: "2026-08-12T12:01:00.000Z",
    units: 1,
    calls: 1,
    prompt_tokens: 1,
    completion_tokens: 1,
    failures: 0,
  });
}
