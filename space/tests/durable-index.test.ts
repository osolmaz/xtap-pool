import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatasetMirror } from "../src/dataset.js";
import { DurableIndex, durableIndexManifestSchema } from "../src/durable-index.js";
import type {
  BucketFile,
  DatasetSnapshotClient,
  DatasetSourceFile,
  DurableIndexBucketClient,
  DurableIndexOptions,
} from "../src/durable-index.js";
import { FakeHub, makePooled } from "./helpers.js";

const DATASET = "osolmaz/xtap-pool-data";
const BUCKET = "osolmaz/xtap-pool-bucket";
const CONTRACT = "a".repeat(64);

class FakeSource implements DatasetSnapshotClient {
  revision = "1".repeat(40);
  files = new Map<string, string>();
  textFiles = new Map<string, string>();

  currentRevision(): Promise<string> {
    return Promise.resolve(this.revision);
  }

  listJsonlFiles(): Promise<readonly DatasetSourceFile[]> {
    return Promise.resolve(
      [...this.files.entries()].map(([path, content]) => ({
        path,
        oid: sha256(content),
        size: Buffer.byteLength(content),
      })),
    );
  }

  downloadFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (content === undefined) return Promise.reject(new Error(`missing ${path}`));
    return Promise.resolve(Buffer.from(content));
  }

  readText(path: string): Promise<string | undefined> {
    return Promise.resolve(this.textFiles.get(path));
  }

  commitText(path: string, content: string, parentRevision: string): Promise<string> {
    if (parentRevision !== this.revision) {
      return Promise.reject(new Error("parent commit does not match dataset HEAD"));
    }
    this.textFiles.set(path, content);
    this.advanceRevision();
    return Promise.resolve(this.revision);
  }

  advanceRevision(): void {
    const value = Number.parseInt(this.revision.slice(0, 8), 16) + 1;
    this.revision = value.toString(16).padStart(40, "0");
  }
}

class FakeBucket implements DurableIndexBucketClient {
  files = new Map<string, Buffer>();
  uploaded = new Map<string, string>();
  removed: string[] = [];
  private clock = 0;

  async download(path: string, destination: string): Promise<boolean> {
    const content = this.files.get(path);
    if (content === undefined) return false;
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    return true;
  }

  async uploadFile(path: string, source: string): Promise<void> {
    this.files.set(path, await readFile(source));
    this.clock += 1;
    this.uploaded.set(path, String(this.clock).padStart(8, "0"));
  }

  list(prefix: string): Promise<readonly BucketFile[]> {
    return Promise.resolve(
      [...this.files.keys()]
        .filter((path) => path.startsWith(`${prefix}/`))
        .map((path) => {
          const uploadedAt = this.uploaded.get(path);
          return { path, ...(uploadedAt === undefined ? {} : { uploadedAt }) };
        }),
    );
  }

  remove(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      this.files.delete(path);
      this.uploaded.delete(path);
      this.removed.push(path);
    }
    return Promise.resolve();
  }
}

let dir: string;
let source: FakeSource;
let bucket: FakeBucket;
let hub: FakeHub;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xtap-index-test-"));
  source = new FakeSource();
  bucket = new FakeBucket();
  hub = new FakeHub();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function options(name: string): DurableIndexOptions {
  return {
    datasetRepo: DATASET,
    indexBucket: BUCKET,
    accessToken: "hf_test",
    databasePath: join(dir, `${name}.sqlite`),
    mirror: new DatasetMirror(hub, join(dir, `${name}-mirror`)),
    taxonomyVersion: 1,
    contractHash: CONTRACT,
    sourceClient: source,
    bucketClient: bucket,
  };
}

function tweetLine(id: string, author = "someone"): string {
  return `${JSON.stringify(
    makePooled({
      id,
      url: `https://x.com/${author}/status/${id}`,
      author: { username: author, display_name: author },
      conversation_id: id,
    }),
  )}\n`;
}

describe("durable enrichment index", () => {
  it("bootstraps, publishes, restores, and applies only a strict append suffix", async () => {
    const path = "data/osolmaz/2026/08/tweets-2026-08-04.jsonl";
    source.files.set(path, tweetLine("1"));
    const initial = await DurableIndex.bootstrap(options("bootstrap"));
    expect(initial.store.count()).toBe(1);
    const firstManifest = await initial.publish();
    initial.close();

    expect(durableIndexManifestSchema.parse(firstManifest)).toEqual(firstManifest);
    expect(() =>
      durableIndexManifestSchema.parse({ ...firstManifest, unexpected: true }),
    ).toThrow();
    const restored = await DurableIndex.restore(options("restored"));
    expect(restored.store.count()).toBe(1);
    source.files.set(path, `${source.files.get(path) ?? ""}${tweetLine("2", "other")}`);
    source.advanceRevision();

    const advanced = await restored.advanceToLatest();
    expect(advanced).toMatchObject({ filesChanged: 1, rowsApplied: 1 });
    expect(restored.store.count()).toBe(2);
    await expect(restored.advanceToLatest()).resolves.toMatchObject({
      filesChanged: 0,
      rowsApplied: 0,
    });
    restored.close();
  });

  it("replays enrichment, attempt, registry, and receipt suffixes", async () => {
    const tweetPath = "data/osolmaz/2026/08/tweets-2026-08-04.jsonl";
    source.files.set(tweetPath, `${tweetLine("1")}${tweetLine("2", "other")}`);
    const eventOptions = options("events");
    const index = await DurableIndex.bootstrap(eventOptions);
    const items = index.enrichStore.claimQueued(10);
    index.enrichStore.releaseClaims();
    const first = items.find((item) => item.tweetIds.includes("1"));
    const second = items.find((item) => item.tweetIds.includes("2"));
    if (first === undefined || second === undefined) throw new Error("expected queue items");

    source.files.set(
      "enrichment/2026/08/enrichment-2026-08-04.jsonl",
      `${JSON.stringify({
        unit_id: first.unitId,
        tweet_ids: first.tweetIds,
        input_hash: first.inputHash,
        contract_hash: first.contractHash,
        preset_labels: [],
        free_labels: [],
        model: "model",
        taxonomy_version: 1,
        enriched_at: "2026-08-04T00:00:00.000Z",
      })}\n`,
    );
    source.files.set(
      "enrichment/attempts/2026/08/attempts-2026-08-04.jsonl",
      `${JSON.stringify({
        unit_id: second.unitId,
        input_hash: second.inputHash,
        contract_hash: second.contractHash,
        attempt: 1,
        outcome: "transient_failure",
        error_class: "timeout",
        at: "2026-08-04T00:00:00.000Z",
      })}\n`,
    );
    source.files.set(
      "enrichment/registry/2026/08/registry-2026-08-04.jsonl",
      `${JSON.stringify({
        name: "new-label",
        status: "candidate",
        at: "2026-08-04T00:00:00.000Z",
        actor: "worker",
        contract_hash: CONTRACT,
        registry_revision: 2,
      })}\n`,
    );
    source.files.set(
      "enrichment/receipts/2026-08-04.jsonl",
      `${JSON.stringify(receiptFixture("job-1"))}\n`,
    );
    source.advanceRevision();

    const advanced = await index.advanceToLatest();
    expect(advanced.filesChanged).toBe(4);
    expect(index.enrichStore.queueEntry(first.unitId)?.status).toBe("done");
    expect(index.enrichStore.queueEntry(second.unitId)?.status).toBe("retrying");
    expect(index.enrichStore.registryStatus("new-label")).toBe("candidate");
    expect(eventOptions.mirror.latestReceipt()?.worker_id).toBe("job-1");
    expect(index.stats()).toMatchObject({
      enrichmentRows: 1,
      attemptEvents: 1,
      registryEvents: 1,
    });
    index.close();
  });

  it("fails closed on prefix edits, truncation, deletion, and checksum mismatch", async () => {
    const path = "data/osolmaz/2026/08/tweets-2026-08-04.jsonl";
    source.files.set(path, `${tweetLine("1")}${tweetLine("2")}`);
    const index = await DurableIndex.bootstrap(options("failures"));
    await index.publish();

    source.files.set(path, `${tweetLine("changed")}${tweetLine("2")}`);
    source.advanceRevision();
    await expect(index.advanceToLatest()).rejects.toThrow("prefix changed");
    source.files.set(path, tweetLine("1"));
    source.advanceRevision();
    await expect(index.advanceToLatest()).rejects.toThrow("truncated");
    source.files.delete(path);
    source.advanceRevision();
    await expect(index.advanceToLatest()).rejects.toThrow("were deleted");
    source.files.set(path, tweetLine("1").trimEnd());
    source.advanceRevision();
    await expect(index.advanceToLatest()).rejects.toThrow("complete JSONL line");
    source.files.set(path, `${tweetLine("1")}${tweetLine("2")}`);
    source.files.set("data/unknown.jsonl", tweetLine("1"));
    source.advanceRevision();
    await expect(index.advanceToLatest()).rejects.toThrow("unsupported dataset index source");
    index.close();

    const manifest = JSON.parse(source.textFiles.get("index/current.json") ?? "{}") as {
      database: { key: string };
    };
    bucket.files.set(manifest.database.key, Buffer.from("corrupt"));
    await expect(DurableIndex.restore(options("corrupt"))).rejects.toThrow("checksum mismatch");
  });

  it("refuses an atomic manifest commit after the dataset head changes", async () => {
    source.files.set("data/osolmaz/2026/08/tweets-2026-08-04.jsonl", tweetLine("1"));
    const index = await DurableIndex.bootstrap(options("race"));
    source.advanceRevision();

    await expect(index.publish()).rejects.toThrow("parent commit does not match");
    expect(source.textFiles.has("index/current.json")).toBe(false);
    index.close();
  });

  it("retains the active database and three recent predecessors", async () => {
    const path = "data/osolmaz/2026/08/tweets-2026-08-04.jsonl";
    source.files.set(path, tweetLine("1"));
    const index = await DurableIndex.bootstrap(options("retention"));
    for (let generation = 0; generation < 6; generation += 1) {
      if (generation > 0) {
        source.files.set(
          path,
          `${source.files.get(path) ?? ""}${tweetLine(String(generation + 1))}`,
        );
        source.advanceRevision();
        await index.advanceToLatest();
      }
      await index.publish();
    }
    const databases = [...bucket.files.keys()].filter((key) => key.startsWith("index/databases/"));
    expect(databases).toHaveLength(4);
    const current = JSON.parse(source.textFiles.get("index/current.json") ?? "{}") as {
      database: { key: string };
    };
    expect(databases).toContain(current.database.key);
    expect(bucket.removed).toHaveLength(2);
    index.close();
  });
});

function receiptFixture(workerId: string): Record<string, unknown> {
  return {
    started_at: "2026-08-04T00:00:00.000Z",
    finished_at: "2026-08-04T00:01:00.000Z",
    units: 1,
    calls: 1,
    prompt_tokens: 1,
    completion_tokens: 1,
    cost_usd: 0.00001,
    failures: 0,
    retries: 0,
    blocked: 0,
    contract_hash: CONTRACT,
    worker_id: workerId,
    discarded_assignments: 0,
    new_candidates: 0,
    new_approvals: 0,
    new_rejections: 0,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
