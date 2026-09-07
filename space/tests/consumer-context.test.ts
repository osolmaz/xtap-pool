import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalBytes, sha256 } from "../src/bucket-log.js";
import type { BucketSnapshot } from "../src/bucket-log.js";
import {
  ConsumerContextStore,
  consumerMetadataHash,
  CONSUMER_CONTEXT_PREFIX,
} from "../src/consumer-context.js";
import type { ConsumerSelection } from "../src/consumer-context.js";
import { ConsumerSourceStore } from "../src/consumer-source.js";
import { CONSUMER_PROJECTION_HASH } from "../src/consumer-index-state.js";
import { CURSOR_RECOVERY_MS } from "../src/consumer-cursor.js";

const snapshot: BucketSnapshot = { schema_version: 1, bucket: "owner/raw", files: [] };
const source = sha256(canonicalBytes(snapshot));
const instant = Date.parse("2026-09-07T00:00:00.000Z");
const contract = "a".repeat(64);
const records = new Map<string, string>();
const log = {
  storeSnapshot: vi.fn((value: BucketSnapshot) =>
    Promise.resolve({ revision: sha256(canonicalBytes(value)), snapshot: structuredClone(value) }),
  ),
  loadSnapshot: vi.fn(() => Promise.resolve(structuredClone(snapshot))),
};
const bucket = {
  readText: (path: string) => Promise.resolve(records.get(path)),
  writeText: (path: string, text: string) => {
    records.set(path, text);
    return Promise.resolve();
  },
};
const selection: ConsumerSelection = {
  author_ids: ["456", "123", "123"],
  labels: ["ai", "ai"],
  label_mode: "any",
  publication: "public-original",
};
const options = () => ({
  boundary: {
    source,
    projection: CONSUMER_PROJECTION_HASH,
    contract,
    registry: { revision: 1, approved: [] },
  },
  snapshot,
  selection,
  taxonomy: { version: 1, labels: [] },
  completeThrough: null,
  observationsThrough: null,
});
const store = (delta = 0, targetContract = contract) =>
  new ConsumerContextStore(
    new ConsumerSourceStore(log),
    bucket,
    targetContract,
    () => new Date(instant + delta),
  );
beforeEach(() => {
  records.clear();
  vi.clearAllMocks();
});

describe("immutable consumer contexts", () => {
  it("saves exact selection and source metadata before issuing a durable reference", async () => {
    const pinned = await store().pin(options());
    expect(pinned.context.selection.author_ids).toEqual(["123", "456"]);
    expect(pinned.context.selection.labels).toEqual(["ai"]);
    expect([...records.keys()]).toEqual([`${CONSUMER_CONTEXT_PREFIX}${pinned.id}.json`]);
    expect(pinned.context.complete_through).toBeNull();
    expect(pinned.context.observations_through).toBeNull();
    expect((await store().pin(options())).id).toBe(pinned.id);
    expect(await store().read(pinned.id)).toEqual({
      ...pinned,
      context: {
        ...pinned.context,
        selection: { ...selection, author_ids: ["123", "456"], labels: ["ai"] },
      },
    });
    expect(log.loadSnapshot).toHaveBeenCalledWith(source);
  });

  it("rejects corrupt, missing, expired, future, and changed-contract contexts", async () => {
    const pinned = await store().pin(options());
    await expect(store().read("../current")).rejects.toThrow();
    await expect(store().read("f".repeat(64))).rejects.toThrow(/expired/);
    await expect(store(CURSOR_RECOVERY_MS).read(pinned.id)).rejects.toThrow(/expired/);
    await expect(store(-60_001).read(pinned.id)).rejects.toThrow(/future/);
    await expect(store(0, "b".repeat(64)).read(pinned.id)).rejects.toThrow(/contract changed/);
    records.set(`${CONSUMER_CONTEXT_PREFIX}${pinned.id}.json`, "{}");
    await expect(store().read(pinned.id)).rejects.toThrow(/checksum/);
  });

  it("does not save metadata for a mismatched boundary or acknowledge failed storage", async () => {
    await expect(
      store().pin({ ...options(), boundary: { ...options().boundary, source: "f".repeat(64) } }),
    ).rejects.toThrow(/verified source/);
    expect(records.size).toBe(0);
    expect(log.storeSnapshot).not.toHaveBeenCalled();
    const unavailable = new ConsumerContextStore(
      new ConsumerSourceStore(log),
      { ...bucket, writeText: () => Promise.resolve() },
      contract,
      () => new Date(instant),
    );
    await expect(unavailable.pin(options())).rejects.toThrow(/read-back mismatch/);
  });

  it("does not turn coverage or registry bookkeeping into changed public metadata", async () => {
    const { context } = await store().pin(options());
    const before = consumerMetadataHash(context);
    expect(
      consumerMetadataHash({
        ...context,
        registry: { ...context.registry, revision: 2 },
        complete_through: new Date(instant).toISOString(),
        observations_through: new Date(instant).toISOString(),
      }),
    ).toBe(before);
    expect(
      consumerMetadataHash({
        ...context,
        registry: {
          revision: 2,
          approved: [
            {
              name: "glm",
              first_observed_at: new Date(instant).toISOString(),
              updated_at: new Date(instant).toISOString(),
            },
          ],
        },
      }),
    ).not.toBe(before);
  });
});
