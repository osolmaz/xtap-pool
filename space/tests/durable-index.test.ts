/* eslint-disable @typescript-eslint/no-non-null-assertion -- Assertions first prove fixture values exist. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryRawBucket, MemoryIndexBucket } from "./memory-buckets.js";
import { BucketLog } from "../src/bucket-log.js";
import { DurableIndex } from "../src/durable-index.js";
import { prepareIndexBootstrap } from "../src/index-bootstrap.js";
import { runIndexCommand } from "../src/index-command.js";
import * as rawModule from "../src/bucket-log.js";
import * as indexModule from "../src/durable-index.js";
import type { DurableIndexOptions, DurableIndexProgress } from "../src/durable-index.js";
import { makePooled } from "./helpers.js";

const RAW = "osolmaz/xtap-pool-data";
const INDEX = "osolmaz/xtap-pool-bucket";
const CONTRACT = "a".repeat(64);

let raw: MemoryRawBucket;
let bucket: MemoryIndexBucket;
let log: BucketLog;

beforeEach(() => {
  raw = new MemoryRawBucket();
  bucket = new MemoryIndexBucket();
  log = new BucketLog(RAW, raw, temporary("cache"), () => new Date("2026-08-12T12:00:00.000Z"));
});

describe("DurableIndex", () => {
  it("prepares without publishing and requires a complete explicit cutover", async () => {
    for (const id of ["1", "2", "3"]) await appendTweet(id);
    const incumbent = await DurableIndex.bootstrap(options("incumbent"));
    const manifest = await incumbent.publish();
    incumbent.close();
    vi.spyOn(rawModule, "createRawBucketClient").mockReturnValue(raw);
    vi.spyOn(indexModule, "createDurableIndexBucketClient").mockReturnValue(bucket);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const env = {
      RAW_BUCKET: RAW,
      INDEX_BUCKET: INDEX,
      HF_TOKEN: "test-token",
      DATA_DIR: temporary("command"),
      INDEX_BOOTSTRAP_MAX_SEGMENTS: "1",
    };
    try {
      await runIndexCommand(env);
      expect(JSON.parse(bucket.files.get("index/current.json")!.toString("utf8"))).toEqual(
        manifest,
      );
      await expect(runIndexCommand({ ...env, INDEX_BOOTSTRAP_MODE: "publish" })).rejects.toThrow(
        "EXPECTED_DATABASE",
      );
      const publishEnv = {
        ...env,
        INDEX_BOOTSTRAP_MODE: "publish",
        INDEX_BOOTSTRAP_EXPECTED_DATABASE: manifest.database.sha256,
      };
      await expect(runIndexCommand(publishEnv)).rejects.toThrow("incomplete");
      await runIndexCommand({ ...env, INDEX_BOOTSTRAP_MAX_SEGMENTS: "500" });
      await appendTweet("4");
      await runIndexCommand(publishEnv);
      expect(JSON.parse(bucket.files.get("index/current.json")!.toString("utf8"))).toMatchObject({
        counts: { tweets: 4 },
      });
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"state":"published"'));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not replace an existing bootstrap database", async () => {
    await appendTweet("1");
    const config = options("keep-existing");
    const first = await DurableIndex.bootstrap(config);
    first.close();
    await expect(DurableIndex.bootstrap(config)).rejects.toThrow("EEXIST");
    const retained = DurableIndex.openLocal(config);
    expect(retained.stats().tweetRows).toBe(1);
    retained.close();
  });

  it("resumes a bounded frozen bootstrap without reloading applied segment bodies", async () => {
    for (const id of ["1", "2", "3"]) await appendTweet(id);
    const target = await log.createSnapshot();
    const config = { ...options("bounded"), sourceRevision: target.revision, chunkSize: 1 };
    const partial = await prepareIndexBootstrap({ ...config, maxSegments: 1 });
    expect(partial.complete).toBe(false);
    expect(partial.progress).toMatchObject({ completed: 1, total: 3 });
    expect(() => partial.index.consumerBoundary()).toThrow("bootstrap is incomplete");
    await expect(partial.index.publish()).rejects.toThrow("bootstrap is incomplete");
    const copied = options("copied-partial");
    await partial.index.store.database.backup(copied.databasePath);
    const recoveredCopy = DurableIndex.openLocal(copied);
    expect(() => recoveredCopy.consumerBoundary()).toThrow("bootstrap is incomplete");
    recoveredCopy.close();
    const appliedKey = partial.index.sourceSnapshot().files[0]!.key;
    partial.index.close();
    await appendTweet("4");
    raw.downloads = [];
    const resumed = await prepareIndexBootstrap(config);
    expect(resumed.complete).toBe(true);
    expect(resumed.index.stats().tweetRows).toBe(3);
    expect(resumed.index.consumerBoundary().source).toBe(target.revision);
    expect(raw.downloads).not.toContain(appliedKey);
    expect(bucket.files.size).toBe(0);
    resumed.index.close();
    const latest = await log.createSnapshot();
    await expect(
      prepareIndexBootstrap({ ...config, sourceRevision: latest.revision }),
    ).rejects.toThrow("target changed");
  });

  it("saves completed chunks before a checkpoint interruption and matches a fresh replay", async () => {
    for (const id of ["1", "2", "3"]) await appendTweet(id);
    const target = await log.createSnapshot();
    const config = { ...options("interrupted"), sourceRevision: target.revision, chunkSize: 1 };
    await expect(
      prepareIndexBootstrap({
        ...config,
        onCheckpoint: ({ completed }) =>
          completed === 2 ? Promise.reject(new Error("stop after saved work")) : Promise.resolve(),
      }),
    ).rejects.toThrow("stop after saved work");
    const checkpoint = DurableIndex.openLocal(config);
    expect(checkpoint.stats().tweetRows).toBe(2);
    checkpoint.close();
    const resumed = await prepareIndexBootstrap(config);
    const fresh = await DurableIndex.bootstrap(options("fresh-comparison"));
    expect(resumed.index.stats()).toEqual(fresh.stats());
    expect(resumed.index.consumerBoundary()).toEqual(fresh.consumerBoundary());
    expect(
      resumed.index.store.database
        .prepare("SELECT * FROM post_observations ORDER BY observation_id")
        .all(),
    ).toEqual(
      fresh.store.database.prepare("SELECT * FROM post_observations ORDER BY observation_id").all(),
    );
    resumed.index.close();
    fresh.close();
  });

  it("stops an aborted bootstrap at a real SQLite boundary", async () => {
    await appendTweet("1");
    const target = await log.createSnapshot();
    const config = { ...options("aborted"), sourceRevision: target.revision };
    const paused = await prepareIndexBootstrap({ ...config, signal: AbortSignal.abort() });
    expect(paused.progress.completed).toBe(0);
    expect(paused.complete).toBe(false);
    paused.index.close();
    const resumed = await prepareIndexBootstrap(config);
    expect(resumed.progress.completed).toBe(1);
    expect(resumed.complete).toBe(true);
    resumed.index.close();
  });

  it("does not scan full SQLite integrity on each source tail", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("bounded-integrity"));
    const pragma = vi.spyOn(index.store.database, "pragma");
    await index.advanceToLatest();
    await appendTweet("2");
    await index.advanceToLatest();
    expect(pragma).not.toHaveBeenCalledWith("integrity_check");
    index.verify();
    expect(pragma).toHaveBeenCalledWith("integrity_check");
    index.close();
  });

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

  it("cannot replace the live index with a source that omits published segments", async () => {
    await appendTweet("1");
    const old = await DurableIndex.bootstrap(options("old-source"));
    await old.publish();
    await appendTweet("2");
    const current = await DurableIndex.bootstrap(options("current-source"));
    const published = await current.publish();
    current.close();
    await expect(old.publish()).rejects.toThrow("omits previously published source");
    expect(JSON.parse(bucket.files.get("index/current.json")!.toString("utf8"))).toEqual(published);
    old.close();
  });

  it("reports restore, replay, build, upload, verify, and manifest progress", async () => {
    await appendTweet("1");
    const restoreDatabase = vi.fn(() => Promise.resolve());
    const sourceReplay = vi.fn(() => Promise.resolve());
    const databaseBuild = vi.fn(() => Promise.resolve());
    const databaseUpload = vi.fn(() => Promise.resolve());
    const databaseVerify = vi.fn(() => Promise.resolve());
    const manifestPublished = vi.fn(() => Promise.resolve());
    const progress: DurableIndexProgress = {
      restoreDatabase,
      sourceReplay,
      databaseBuild,
      databaseUpload,
      databaseVerify,
      manifestPublished,
    };
    const first = await DurableIndex.bootstrap({ ...options("progress-first"), progress });
    await first.publish();
    first.close();
    const restored = await DurableIndex.restore({ ...options("progress-restored"), progress });
    restored.close();

    expect(sourceReplay).toHaveBeenCalled();
    expect(databaseBuild).toHaveBeenLastCalledWith(true);
    expect(databaseUpload).toHaveBeenCalled();
    expect(databaseVerify).toHaveBeenCalled();
    expect(manifestPublished).toHaveBeenCalledOnce();
    expect(restoreDatabase).toHaveBeenCalled();
  });

  it("finishes an already published verified database idempotently", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("published-resume"));
    const manifest = await index.publish();
    index.close();
    const database = bucket.files.get(manifest.database.key);
    expect(database).toBeDefined();
    const boundary = vi.fn(() => Promise.resolve());

    await DurableIndex.completeVerifiedPublication({
      indexBucket: INDEX,
      accessToken: "token",
      databasePath: temporary("published-resume-verify"),
      rawBucket: RAW,
      contractHash: CONTRACT,
      expectedCurrentDatabaseSha256: "0".repeat(64),
      manifest,
      alreadyVerified: true,
      databaseBytes: database?.byteLength ?? 0,
      bucketClient: bucket,
      publicationBoundary: boundary,
    });

    expect(boundary).toHaveBeenCalledWith("published", manifest, database?.byteLength);
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

  it("deduplicates a repeated base predecessor before publishing", async () => {
    await appendTweet("1");
    const first = await DurableIndex.bootstrap(options("dedupe-first"));
    const base = await first.publish();
    first.close();

    const restored = await DurableIndex.restoreReference(options("dedupe-restored"), {
      key: base.database.key,
      sha256: base.database.sha256,
      sourceRevision: base.source.revision,
      predecessorKeys: [base.database.key, ...base.database.predecessors],
    });
    await appendTweet("2");
    await restored.advanceToLatest();
    const next = await restored.publish();
    restored.close();

    expect(next.database.predecessors[0]).toBe(base.database.key);
    expect(new Set(next.database.predecessors).size).toBe(next.database.predecessors.length);
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

  it("replays new segments by transaction time instead of category key", async () => {
    const tweet = makePooled({ id: "88", captured_at: "2026-08-12T12:00:00.000Z" });
    await log.putSegment({
      schema_version: 1,
      transaction_id: "00000000-0000-4000-8000-000000000002",
      created_at: "2026-08-12T12:00:00.000Z",
      operations: [
        {
          path: "data/osolmaz/2026/08/tweets-2026-08-12.jsonl",
          mode: "append",
          lines: [JSON.stringify(tweet)],
        },
      ],
    });
    await log.putSegment({
      schema_version: 1,
      transaction_id: "00000000-0000-4000-8000-000000000003",
      created_at: "2026-08-12T12:01:00.000Z",
      operations: [
        {
          path: "enrichment/attempts/2026/08/attempts-2026-08-12.jsonl",
          mode: "append",
          lines: [
            JSON.stringify({
              unit_id: "88:someone",
              input_hash: "stale",
              contract_hash: CONTRACT,
              attempt: 1,
              outcome: "transient_failure",
              at: "2026-08-12T12:01:00.000Z",
              error_message: "retry",
              error_class: "other",
            }),
          ],
        },
      ],
    });

    const order: string[] = [];
    const applySegment = log.applySegment.bind(log);
    vi.spyOn(log, "applySegment").mockImplementation((segment, store, enrich) => {
      order.push(segment.operations[0]?.path ?? "");
      return applySegment(segment, store, enrich);
    });
    const index = await DurableIndex.bootstrap(options("replay-order"));

    expect(order.map((path) => path.split("/")[0])).toEqual(["data", "enrichment"]);
    expect(index.stats().tweetRows).toBe(1);
    expect(index.stats().attemptEvents).toBe(1);
    index.close();
  });

  it("reads only new segment bodies while advancing the live head", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("incremental"));
    await appendTweet("2");
    raw.downloads = [];

    const advance = await index.advanceToLatest();

    expect(advance.filesChanged).toBe(1);
    expect(raw.downloads.filter((key) => key.includes("/segments/"))).toHaveLength(1);
    index.close();
  });

  it("rejects publication when another publisher changes the active manifest", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("publication-race"));
    const originalRead = bucket.readText.bind(bucket);
    let reads = 0;
    bucket.readText = async (path) => {
      reads += 1;
      if (path === "index/current.json" && reads === 2) return "concurrent";
      return originalRead(path);
    };

    await expect(index.publish()).rejects.toThrow("changed during publication");
    expect(bucket.removed).toEqual([]);
    index.close();
  });

  it("retains the active database and three predecessors after the pruning grace", async () => {
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

  it("restores the exact consumer boundary without relying on process state", async () => {
    await appendTweet("1");
    const first = await DurableIndex.bootstrap(options("consumer-boundary"));
    const boundary = first.consumerBoundary();
    await first.publish();
    first.close();
    const restored = await DurableIndex.restore(options("consumer-restored"));
    expect(restored.consumerBoundary()).toEqual(boundary);
    await appendTweet("2");
    await restored.advanceToLatest();
    expect(restored.consumerBoundary().source).not.toBe(boundary.source);
    expect(restored.consumerBoundary().registry).toEqual(boundary.registry);
    restored.close();
  });

  it("does not present empty new tables on an old index as complete history", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("missing-consumer-state"));
    await index.publish();
    const before = bucket.files.get("index/current.json");
    index.store.database.prepare("DELETE FROM consumer_index_state").run();
    await appendTweet("2");
    await index.advanceToLatest();
    expect(() => index.consumerBoundary()).toThrow(/explicit index bootstrap/);
    await expect(index.publish()).rejects.toThrow(/explicit index bootstrap/);
    expect(bucket.files.get("index/current.json")).toEqual(before);
    index.close();
  });

  it("rolls back source inventory and consumer state after an incomplete segment projection", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("consumer-rollback"));
    const before = index.consumerBoundary();
    const omit = vi.spyOn(index.store.sourceEffects, "recordPost").mockImplementation(() => {
      // Simulate a skipped projection write after durable source delivery.
    });
    await appendTweet("2");
    await expect(index.advanceToLatest()).rejects.toThrow(
      /consumer segment projection is incomplete/,
    );
    expect(index.consumerBoundary()).toEqual(before);
    expect(index.stats().tweetRows).toBe(1);
    omit.mockRestore();
    await index.advanceToLatest();
    expect(index.stats().tweetRows).toBe(2);
    index.close();
  });

  it("does not acknowledge output source rows before the snapshot is durable", async () => {
    await appendTweet("1");
    const index = await DurableIndex.bootstrap(options("output-atomic"));
    const before = index.consumerBoundary();
    const key = await log.appendTweets([makePooled({ id: "2" })]);
    const save = vi
      .spyOn(log, "storeSnapshot")
      .mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(index.applyOutputSegments([key])).rejects.toThrow("storage unavailable");
    expect(index.stats().tweetRows).toBe(1);
    expect(index.consumerBoundary()).toEqual(before);
    save.mockRestore();
    const advanced = await index.applyOutputSegments([key]);
    expect(index.consumerBoundary().source).toBe(advanced.revision);
    expect(index.stats().tweetRows).toBe(2);
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
