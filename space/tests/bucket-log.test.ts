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

  it("replays receipt metadata and applies normalized tweets", async () => {
    const state = log();
    await state.log.commitBatch(
      [{ path: "enrichment/receipts/2026-08-12.jsonl", lines: [currentReceipt()] }],
      [],
    );
    const { snapshot } = await state.log.createSnapshot();
    await state.log.hydrateMetadata(snapshot);
    expect(state.log.latestReceipt()?.worker_id).toBe("worker-1");

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

function currentReceipt(): string {
  return JSON.stringify({
    started_at: "2026-08-12T12:00:00.000Z",
    finished_at: "2026-08-12T12:01:00.000Z",
    units: 1,
    calls: 1,
    prompt_tokens: 1,
    completion_tokens: 1,
    cost_usd: 0,
    failures: 0,
    retries: 0,
    blocked: 0,
    contract_hash: "contract",
    worker_id: "worker-1",
    discarded_assignments: 0,
    new_candidates: 0,
    new_approvals: 0,
    new_rejections: 0,
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
