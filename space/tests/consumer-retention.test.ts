import { afterEach, beforeEach, expect, it } from "vitest";
import { consumerFixture, consumerTweet, BOOTSTRAP } from "./consumer-http-fixture.js";
import type { ConsumerFixture } from "./consumer-http-fixture.js";
import { consumerChangesEnvelopeSchema } from "../src/consumer-http-contract.js";
import { CONSUMER_CONTEXT_PREFIX } from "../src/consumer-context.js";

let f: ConsumerFixture;
beforeEach(async () => {
  f = await consumerFixture();
});
afterEach(async () => {
  await f.close();
});

it("keeps raw bases and old page contexts after more than three database publications", async () => {
  await f.post(consumerTweet());
  const first = consumerChangesEnvelopeSchema.parse(await (await f.request(BOOTSTRAP)).json());
  const cursor = f.codec.decode(first.cursor);
  const pinned = await f.options().contexts.read(cursor.target);
  const baseKey = `v1/snapshots/${pinned.context.snapshot.base}.json`;
  expect(f.raw.files.has(baseKey)).toBe(true);
  const original = await f.index.publish();
  for (const id of ["200", "300", "400", "500", "600"]) {
    await f.post(consumerTweet(id));
    await f.index.publish();
  }
  expect(f.bucket.removed).toContain(original.database.key);
  expect(f.bucket.files.has(`${CONSUMER_CONTEXT_PREFIX}${cursor.target}.json`)).toBe(true);
  expect(f.raw.files.has(baseKey)).toBe(true);
  f.restart();
  const resumed = consumerChangesEnvelopeSchema.parse(
    await (await f.request(`/api/units?cursor=${first.cursor}`)).json(),
  );
  expect(resumed.source).toBe(first.source);
  expect(resumed.changes.map((c) => (c.type === "unit_upsert" ? c.unit.id : c.type))).toEqual([
    "100:a",
  ]);
});

it("cleans only expired contexts in bounded batches and never deletes raw bases or segments", async () => {
  const prefix = CONSUMER_CONTEXT_PREFIX;
  const stale = Array.from({ length: 300 }, (_, i) => ({
    path: `${prefix}${i.toString(16).padStart(64, "0")}.json`,
    uploadedAt: "2026-08-01T00:00:00.000Z",
  }));
  const entries = [
    ...stale,
    { path: `${prefix}${"f".repeat(64)}.json`, uploadedAt: f.now().toISOString() },
    { path: `${prefix}${"e".repeat(64)}.json` },
    { path: "index/current.json", uploadedAt: "2000-01-01T00:00:00Z" },
    { path: `v1/snapshots/${"a".repeat(64)}.json`, uploadedAt: "2000-01-01T00:00:00Z" },
  ];
  const removed: string[] = [];
  const cleanup = {
    list: () => Promise.resolve(entries),
    remove: (paths: readonly string[]) => {
      removed.push(...paths);
      return Promise.resolve();
    },
  };
  expect(await f.options().contexts.cleanup(cleanup)).toBe(256);
  expect(removed).toEqual(stale.slice(0, 256).map((file) => file.path));
  expect(await f.options().contexts.cleanup({ ...cleanup, list: () => Promise.resolve([]) })).toBe(
    0,
  );
});
