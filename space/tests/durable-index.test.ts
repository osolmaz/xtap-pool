import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { BucketLog, sha256 } from "../src/bucket-log.js";
import type { BucketObject, RawBucketClient } from "../src/bucket-log.js";
import { DurableIndex } from "../src/durable-index.js";
import type {
  BucketFile,
  DurableIndexBucketClient,
  DurableIndexOptions,
} from "../src/durable-index.js";
import { makePooled } from "./helpers.js";

const RAW = "osolmaz/xtap-pool-data";
const INDEX = "osolmaz/xtap-pool-bucket";
const CONTRACT = "a".repeat(64);

class MemoryRawBucket implements RawBucketClient {
  files = new Map<string, Uint8Array>();

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
    this.files.set(key, new Uint8Array(content));
  }
}

class MemoryIndexBucket implements DurableIndexBucketClient {
  files = new Map<string, Buffer>();
  removed: string[] = [];

  async download(path: string, destination: string): Promise<boolean> {
    const content = this.files.get(path);
    if (content === undefined) return false;
    writeFileSync(destination, content);
    return true;
  }

  async uploadFile(path: string, source: string): Promise<void> {
    this.files.set(path, readFileSync(source));
  }

  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path)?.toString("utf8");
  }

  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, Buffer.from(content));
  }

  async list(prefix: string): Promise<readonly BucketFile[]> {
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => ({ path }));
  }

  async remove(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      this.files.delete(path);
      this.removed.push(path);
    }
  }
}

let raw: MemoryRawBucket;
let bucket: MemoryIndexBucket;
let log: BucketLog;

beforeEach(() => {
  raw = new MemoryRawBucket();
  bucket = new MemoryIndexBucket();
  log = new BucketLog(RAW, raw, temporary("cache"), () => new Date("2026-08-12T12:00:00.000Z"));
});

describe("DurableIndex", () => {
  it("bootstraps, publishes, restores, and advances exact Bucket snapshots", async () => {
    await appendTweet("1");
    const firstOptions = options("first");
    const first = await DurableIndex.bootstrap(firstOptions);
    expect(first.stats()).toMatchObject({ tweetRows: 1, tweetFiles: 1 });
    const published = await first.publish();
    expect(published.source.bucket).toBe(RAW);
    expect(published.counts.tweets).toBe(1);
    first.close();

    const restored = await DurableIndex.restore(options("restored"));
    expect(restored.store.query({ limit: 10 }).records).toHaveLength(1);
    await appendTweet("2");
    const advance = await restored.advanceToLatest();
    expect(advance.filesChanged).toBe(1);
    expect(advance.counts.tweets).toBe(2);
    restored.close();
  });

  it("fails closed when an exact snapshot segment is missing or changed", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("mutation"));
    const current = await log.createSnapshot();
    const file = current.snapshot.files[0]!;
    raw.files.delete(file.key);
    await expect(index.advanceToRevision(current.revision)).rejects.toThrow("missing");
    index.close();

    raw = new MemoryRawBucket();
    log = new BucketLog(
      RAW,
      raw,
      temporary("cache-two"),
      () => new Date("2026-08-12T12:00:00.000Z"),
    );
    await appendTweet("1");
    const second = await DurableIndex.bootstrap(options("changed"));
    const old = await log.createSnapshot();
    const oldFile = old.snapshot.files[0]!;
    raw.files.set(oldFile.key, new Uint8Array([1, 2, 3]));
    await expect(second.advanceToRevision(old.revision)).rejects.toThrow("size mismatch");
    second.close();
  });

  it("rejects deleted source segments after recording them", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("delete"));
    raw.files.clear();
    await expect(index.advanceToLatest()).rejects.toThrow("were deleted");
    index.close();
  });

  it("detects a corrupt published SQLite generation", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("corrupt"));
    const manifest = await index.publish();
    index.close();
    bucket.files.set(manifest.database.key, Buffer.from("corrupt"));
    await expect(DurableIndex.restore(options("restore-corrupt"))).rejects.toThrow(
      "checksum mismatch",
    );
  });

  it("restores receipt metadata from the exact raw snapshot", async () => {
    await appendTweet("1");
    await log.commitBatch(
      [
        {
          path: "enrichment/receipts/2026-08-12.jsonl",
          lines: [
            JSON.stringify({
              started_at: "2026-08-12T12:00:00.000Z",
              finished_at: "2026-08-12T12:01:00.000Z",
              units: 1,
              calls: 1,
              prompt_tokens: 1,
              completion_tokens: 1,
              failures: 0,
              retries: 0,
              blocked: 0,
              contract_hash: CONTRACT,
              worker_id: "test-worker",
              discarded_assignments: 0,
              new_candidates: 0,
              new_approvals: 0,
              new_rejections: 0,
            }),
          ],
        },
      ],
      [],
    );
    const index = await DurableIndex.bootstrap(options("receipt-publish"));
    await index.publish();
    index.close();

    const restoredLog = new BucketLog(RAW, raw, temporary("receipt-cache"));
    const restored = await DurableIndex.restore({
      ...options("receipt-restore"),
      log: restoredLog,
    });
    expect(restoredLog.latestReceipt()?.finished_at).toBe("2026-08-12T12:01:00.000Z");
    restored.close();
  });

  it("retains the active database and three predecessors", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("retention"));
    for (let generation = 0; generation < 6; generation += 1) {
      if (generation > 0) {
        await appendTweet(String(generation + 1));
        await index.advanceToLatest();
      }
      await index.publish();
    }
    const manifest = JSON.parse(
      bucket.files.get("index/current.json")?.toString("utf8") ?? "{}",
    ) as {
      database: { key: string; predecessors: string[] };
    };
    expect(manifest.database.predecessors).toHaveLength(3);
    expect([...bucket.files.keys()].filter((key) => key.endsWith(".sqlite"))).toHaveLength(4);
    expect(bucket.removed).toHaveLength(2);
    index.close();
  });

  it("binds the manifest to the raw Bucket and enrichment contract", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("provenance"));
    await index.publish();
    index.close();
    await expect(
      DurableIndex.restore({ ...options("wrong-bucket"), rawBucket: "osolmaz/other" }),
    ).rejects.toThrow("raw Bucket mismatch");
    await expect(
      DurableIndex.restore({ ...options("wrong-contract"), contractHash: "b".repeat(64) }),
    ).rejects.toThrow("contract");
  });
});

async function appendTweet(id: string): Promise<void> {
  await log.appendTweets([
    makePooled({
      id,
      url: `https://x.com/someone/status/${id}`,
      text: `tweet ${id}`,
      captured_at: `2026-08-12T12:00:${id.padStart(2, "0")}.000Z`,
    }),
  ]);
}

function options(name: string): DurableIndexOptions {
  return {
    rawBucket: RAW,
    indexBucket: INDEX,
    accessToken: "token",
    databasePath: join(temporary(name), "index.sqlite"),
    log,
    taxonomyVersion: 1,
    contractHash: CONTRACT,
    bucketClient: bucket,
  };
}

function temporary(name: string): string {
  return mkdtempSync(join(tmpdir(), `xtap-index-${name}-`));
}
