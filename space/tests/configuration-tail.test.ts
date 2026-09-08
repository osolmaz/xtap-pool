import { describe, expect, it, vi } from "vitest";
import type {
  BucketOperation,
  BucketSegment,
  BucketSnapshot,
  BucketSnapshotFile,
} from "../src/bucket-log.js";
import { hasConfigurationWrites } from "../src/configuration-tail.js";

function file(kind: "config" | "mixed" | "tweet", n: number): BucketSnapshotFile {
  const hash = String(n).padStart(64, "0");
  return {
    key: `v1/segments/${kind}/2026/09/08/1788868800000-00000000-0000-4000-8000-000000000000-${hash}.json.gz`,
    oid: hash,
    size: 100,
    content_sha256: hash,
  };
}
function snapshot(...files: BucketSnapshotFile[]): BucketSnapshot {
  return {
    schema_version: 1,
    bucket: "owner/raw",
    files: files.sort((a, b) => a.key.localeCompare(b.key)),
  };
}
function reader(operations: BucketOperation[]) {
  const segment: BucketSegment = {
    schema_version: 1,
    transaction_id: "00000000-0000-4000-8000-000000000000",
    created_at: "2026-09-08T12:00:00.000Z",
    operations,
  };
  return { loadSegment: vi.fn(() => Promise.resolve(segment)) };
}
const append: BucketOperation = {
  mode: "append",
  path: "enrichment/2026/09/enrichment-2026-09-08.jsonl",
  lines: ["{}"],
};
const write: BucketOperation = { mode: "write", path: "config/labels.json", content: "{}" };

describe("configuration changes in verified source tails", () => {
  it("does not reread old mixed/config segments or new tweet-only segments", async () => {
    const base = snapshot(file("config", 1), file("mixed", 2));
    const log = reader([write]);
    expect(await hasConfigurationWrites(log, base, snapshot(...base.files, file("tweet", 3)))).toBe(
      false,
    );
    expect(log.loadSegment).not.toHaveBeenCalled();
  });

  it("keeps mixed enrichment append batches out of the full configuration refresh", async () => {
    const old = file("mixed", 1),
      added = file("mixed", 2);
    const log = reader([
      append,
      { ...append, path: "enrichment/attempts/2026/09/attempts-2026-09-08.jsonl" },
    ]);
    expect(await hasConfigurationWrites(log, snapshot(old), snapshot(old, added))).toBe(false);
    expect(log.loadSegment).toHaveBeenCalledExactlyOnceWith(added);
  });

  it.each(["config", "mixed"] as const)(
    "detects actual writes in new %s segments, including late arrivals",
    async (kind) => {
      const old = file(kind, 2),
        added = file(kind, 1);
      const log = reader(kind === "mixed" ? [append, write] : [write]);
      expect(await hasConfigurationWrites(log, snapshot(old), snapshot(added, old))).toBe(true);
      expect(log.loadSegment).toHaveBeenCalledExactlyOnceWith(added);
    },
  );

  it("does not mistake an unreadable new segment for unchanged configuration", async () => {
    const log = { loadSegment: vi.fn(() => Promise.reject(new Error("checksum mismatch"))) };
    await expect(
      hasConfigurationWrites(log, snapshot(), snapshot(file("mixed", 1))),
    ).rejects.toThrow("checksum mismatch");
  });
});
