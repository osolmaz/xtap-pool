import { beforeEach, describe, expect, it, vi } from "vitest";
import { bucketSnapshotSchema, canonicalBytes, sha256 } from "../src/bucket-log.js";
import type { BucketSnapshot, BucketSnapshotFile } from "../src/bucket-log.js";
import { ConsumerSourceStore } from "../src/consumer-source.js";

const files = new Map<string, BucketSnapshot>();
const log = {
  storeSnapshot: vi.fn((input: BucketSnapshot) => {
    const snapshot = bucketSnapshotSchema.parse(input);
    const revision = sha256(canonicalBytes(snapshot));
    files.set(revision, snapshot);
    return Promise.resolve({ revision, snapshot });
  }),
  loadSnapshot: vi.fn((revision: string) => {
    const snapshot = files.get(revision);
    return snapshot === undefined
      ? Promise.reject(new Error("missing snapshot"))
      : Promise.resolve(structuredClone(snapshot));
  }),
};
function file(n: number): BucketSnapshotFile {
  const hash = n.toString(16).padStart(64, "0");
  return {
    key: `v1/segments/tweet/2026/09/07/${String(n).padStart(13, "0")}-00000000-0000-4000-8000-000000000000-${hash}.json.gz`,
    oid: hash,
    size: 400,
    content_sha256: hash,
  };
}
function snapshot(...ids: number[]): BucketSnapshot {
  return { schema_version: 1, bucket: "owner/raw", files: ids.sort((a, b) => a - b).map(file) };
}
beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
});

describe("compact verified source membership", () => {
  it("stores an immutable base before a cursor can refer to it and survives restart", async () => {
    const writer = new ConsumerSourceStore(log);
    const base = await writer.describe(snapshot(900));
    const target = snapshot(100, 900);
    const described = await writer.describe(target);
    expect(log.storeSnapshot).toHaveBeenCalledTimes(1);
    expect(described.source.base).toBe(base.revision);
    expect(described.source.additions.map((entry) => entry.key)).toEqual([file(100).key]);
    expect(
      await new ConsumerSourceStore(log).resolve(described.revision, described.source),
    ).toEqual(target);
    expect(log.loadSnapshot).toHaveBeenCalledWith(base.revision);
  });

  it("rejects missing or mutated old files rather than using a key watermark or full-read fallback", async () => {
    const store = new ConsumerSourceStore(log);
    await store.describe(snapshot(1, 2));
    await expect(store.describe(snapshot(2))).rejects.toThrow(/immutable file/);
    const changed = snapshot(1, 2);
    const first = changed.files[0];
    if (first === undefined) throw new Error("missing fixture file");
    first.oid = "c".repeat(64);
    await expect(store.describe(changed)).rejects.toThrow(/immutable file/);
    await expect(store.describe({ ...snapshot(1, 2), bucket: "other/raw" })).rejects.toThrow(
      /Bucket changed/,
    );
  });

  it("rolls the metadata base only when the explicit additions exceed their bounds", async () => {
    const store = new ConsumerSourceStore(log);
    await store.describe(snapshot(0));
    const bounded = snapshot(...Array.from({ length: 1025 }, (_, i) => i));
    expect((await store.describe(bounded)).source.additions).toHaveLength(1024);
    const larger = snapshot(...Array.from({ length: 1026 }, (_, i) => i));
    const rolled = await store.describe(larger);
    expect(rolled.source.additions).toEqual([]);
    expect(log.storeSnapshot).toHaveBeenCalledTimes(2);
    expect(await new ConsumerSourceStore(log).resolve(rolled.revision, rolled.source)).toEqual(
      larger,
    );
  });

  it("verifies the full source checksum and rejects duplicate additions", async () => {
    const store = new ConsumerSourceStore(log);
    const base = await store.describe(snapshot(1));
    const target = await store.describe(snapshot(1, 2));
    await expect(store.resolve("f".repeat(64), target.source)).rejects.toThrow(
      /membership checksum/,
    );
    await expect(
      store.resolve(target.revision, { ...target.source, additions: [file(1)] }),
    ).rejects.toThrow(/unique/);
    await expect(
      store.resolve(base.revision, { ...base.source, base: "e".repeat(64) }),
    ).rejects.toThrow(/missing snapshot/);
    files.set(base.revision, snapshot(3));
    await expect(
      new ConsumerSourceStore(log).resolve(target.revision, target.source),
    ).rejects.toThrow(/base checksum/);
  });

  it("does not acknowledge a failed base save", async () => {
    const store = new ConsumerSourceStore({
      ...log,
      storeSnapshot: () => Promise.reject(new Error("storage failed")),
    });
    await expect(store.describe(snapshot(1))).rejects.toThrow("storage failed");
    const changed = new ConsumerSourceStore({
      ...log,
      storeSnapshot: () => Promise.resolve({ revision: "f".repeat(64), snapshot: snapshot(1) }),
    });
    await expect(changed.describe(snapshot(1))).rejects.toThrow(/changed during storage/);
  });
});
