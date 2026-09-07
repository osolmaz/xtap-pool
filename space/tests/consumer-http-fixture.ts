import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { computeInputHash, unitIdFor } from "@xtap-pool/shared";
import type { PooledTweet } from "@xtap-pool/shared";
import { BucketLog } from "../src/bucket-log.js";
import { DurableIndex } from "../src/durable-index.js";
import { ConsumerContextStore } from "../src/consumer-context.js";
import { ConsumerSourceStore } from "../src/consumer-source.js";
import { ConsumerCursorCodec } from "../src/consumer-cursor.js";
import { ConsumerRuntime } from "../src/consumer-runtime.js";
import type { ConsumerRuntimeOptions } from "../src/consumer-runtime.js";
import { ConsumerWorkers } from "../src/consumer-workers.js";
import { registerConsumerRoutes } from "../src/consumer-routes.js";
import { ServiceAccountRegistry } from "../src/service-accounts.js";
import { Mutex } from "../src/ingest.js";
import { MemoryRawBucket, MemoryIndexBucket } from "./memory-buckets.js";
import { FakeLog } from "./fake-log.js";
import { makePooled } from "./helpers.js";

export const HTTP_NOW = "2026-09-07T12:00:00.000Z";
export const HTTP_CONTRACT = "a".repeat(64);
export const BOOTSTRAP = "/api/units?author_ids=11&labels=ai&publication=public-original";
export function consumerTweet(id = "100", patch: Record<string, unknown> = {}): PooledTweet {
  return makePooled({
    id,
    conversation_id: id,
    text: "model release",
    author: { id: "11", username: "a" },
    captured_at: "2026-09-06T00:00:00.000Z",
    pooled_at: "2026-09-06T00:01:00.000Z",
    ...patch,
  });
}
export async function consumerFixture() {
  const directory = mkdtempSync(join(tmpdir(), "xtap-consumer-http-"));
  let time = new Date(HTTP_NOW);
  const now = () => time;
  const raw = new MemoryRawBucket();
  const bucket = new MemoryIndexBucket();
  const log = new BucketLog("owner/raw", raw, join(directory, "cache"), now);
  const databasePath = join(directory, "index.sqlite");
  const index = await DurableIndex.bootstrap({
    rawBucket: "owner/raw",
    indexBucket: "owner/index",
    accessToken: "fixture",
    databasePath,
    log,
    taxonomyVersion: 1,
    contractHash: HTTP_CONTRACT,
    bucketClient: bucket,
  });
  const accounts = await ServiceAccountRegistry.load({ log: new FakeLog(), now });
  const credential = await accounts.issue("operator", "consumer", [
    "units:read",
    "taxonomy:read",
    "observations:read",
  ]);
  const headers = { authorization: `Bearer ${credential.token}` };
  const mutex = new Mutex();
  const workers = new ConsumerWorkers();
  const codec = new ConsumerCursorCodec("fixture-signing-key".repeat(3), now);
  const stores = () =>
    new ConsumerContextStore(new ConsumerSourceStore(log), bucket, HTTP_CONTRACT, now);
  let contexts = stores();
  const options = (): ConsumerRuntimeOptions => ({
    contexts,
    codec,
    workers,
    locked: (op) => mutex.run(op),
    now,
    current: () => ({
      boundary: index.consumerBoundary(),
      snapshot: index.sourceSnapshot(),
      taxonomy: { version: 1, labels: [{ name: "ai", description: "AI" }] },
      databasePath,
    }),
  });
  let runtime = new ConsumerRuntime(options());
  const app = () => {
    const app = new Hono();
    registerConsumerRoutes(app, runtime, () => false, accounts);
    return app;
  };
  return {
    directory,
    raw,
    bucket,
    log,
    index,
    workers,
    codec,
    accounts,
    credential,
    headers,
    mutex,
    options,
    now,
    advanceTime: (milliseconds: number) => {
      time = new Date(time.getTime() + milliseconds);
    },
    request: (path: string, requestHeaders = headers) =>
      app().request(path, { headers: requestHeaders }),
    restart: () => {
      contexts = stores();
      runtime = new ConsumerRuntime(options());
    },
    setRuntime: (value: ConsumerRuntime) => {
      runtime = value;
    },
    async post(value: PooledTweet, complete = true) {
      await log.appendTweets([value]);
      await index.advanceToLatest();
      if (!complete) return;
      const id = unitIdFor(value);
      const row = {
        unit_id: id,
        tweet_ids: index.enrichStore.unitMemberIds(id),
        input_hash: computeInputHash(id, index.enrichStore.unitSemanticMembers(id)),
        contract_hash: HTTP_CONTRACT,
        preset_labels: [{ name: "ai", evidence: [{ tweet_id: value.id, quote: "model" }] }],
        free_labels: [],
        model: "fixture",
        taxonomy_version: 1,
        enriched_at: now().toISOString(),
      };
      await log.commitBatch(
        [{ path: "enrichment/2026/09/enrichment-2026-09-07.jsonl", lines: [JSON.stringify(row)] }],
        [],
      );
      await index.advanceToLatest();
    },
    async close() {
      await workers.close();
      index.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export type ConsumerFixture = Awaited<ReturnType<typeof consumerFixture>>;
