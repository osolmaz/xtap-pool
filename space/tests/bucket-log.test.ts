/* eslint-disable @typescript-eslint/require-await -- In-memory fakes implement asynchronous storage interfaces. */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- Assertions first prove fixture values exist. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  BucketLog,
  bucketSegmentSchema,
  canonicalBytes,
  deterministicUuid,
  sha256,
} from "../src/bucket-log.js";
import type { BucketObject, RawBucketClient } from "../src/bucket-log.js";

const gunzipAsync = promisify(gunzip);

class MemoryBucket implements RawBucketClient {
  readonly files = new Map<string, Uint8Array>();
  failUpload = false;

  async list(prefix: string): Promise<readonly BucketObject[]> {
    return [...this.files]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, content]) => ({ key, oid: sha256(content), size: content.byteLength }));
  }

  async download(key: string): Promise<Uint8Array | undefined> {
    const content = this.files.get(key);
    return content === undefined ? undefined : new Uint8Array(content);
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

  it("derives stable UUIDs from import digests", () => {
    const digest = sha256(canonicalBytes({ source: "file" }));
    expect(deterministicUuid(digest)).toBe(deterministicUuid(digest));
    expect(deterministicUuid(digest)).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

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
