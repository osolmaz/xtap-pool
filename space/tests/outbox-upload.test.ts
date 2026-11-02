import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BucketLog, sha256 } from "../src/bucket-log.js";
import type { RawBucketClient } from "../src/bucket-log.js";
import {
  OUTBOX_FILE_PATTERN,
  outboxSealTime,
  REJECTED_DIR,
  uploadOutbox,
} from "../src/outbox-upload.js";
import { makeTweet } from "./helpers.js";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const SEALED_MS = Date.parse("2026-11-02T09:30:00.000Z");
const FILE = `${String(SEALED_MS)}-0b7c3c55-8d0e-4b8e-9f00-3d1d6c7e2a10.jsonl`;

type MemoryBucket = {
  client: RawBucketClient;
  objects: Map<string, Uint8Array>;
  uploads: string[];
};

function memoryBucket(options: { failUploads?: boolean } = {}): MemoryBucket {
  const objects = new Map<string, Uint8Array>();
  const uploads: string[] = [];
  return {
    objects,
    uploads,
    client: {
      list: (prefix) =>
        Promise.resolve(
          [...objects]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, oid: sha256(value), size: value.byteLength })),
        ),
      download: (key) => Promise.resolve(objects.get(key)),
      upload: (key, content) => {
        if (options.failUploads === true) return Promise.reject(new Error("hub unavailable"));
        uploads.push(key);
        objects.set(key, content);
        return Promise.resolve();
      },
    },
  };
}

function segmentLines(bucket: MemoryBucket): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const value of bucket.objects.values()) {
    const segment = JSON.parse(gunzipSync(value).toString("utf8")) as {
      operations: { lines: string[] }[];
    };
    for (const operation of segment.operations)
      for (const line of operation.lines) lines.push(JSON.parse(line) as Record<string, unknown>);
  }
  return lines;
}

function jsonl(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

let outboxDir: string;

beforeEach(() => {
  outboxDir = mkdtempSync(join(tmpdir(), "xtap-pool-outbox-"));
});

afterEach(() => {
  rmSync(outboxDir, { recursive: true, force: true });
});

function upload(bucket: MemoryBucket): ReturnType<typeof uploadOutbox> {
  return uploadOutbox({
    outboxDir,
    log: new BucketLog("osolmaz/xtap-pool-data", bucket.client, join(outboxDir, ".cache")),
    contributor: "osolmaz",
    now: () => NOW,
  });
}

describe("outbox file names", () => {
  it("accepts only sealed handoff names and reads their seal time", () => {
    expect(OUTBOX_FILE_PATTERN.test(FILE)).toBe(true);
    expect(outboxSealTime(FILE)?.getTime()).toBe(SEALED_MS);
    expect(outboxSealTime(`${FILE}.tmp`)).toBeUndefined();
    expect(outboxSealTime("tweets-2026-11-02.jsonl")).toBeUndefined();
  });
});

describe("uploadOutbox", () => {
  it("uploads one verified segment with verified attribution and deletes the file", async () => {
    const bucket = memoryBucket();
    writeFileSync(
      join(outboxDir, FILE),
      jsonl([{ ...makeTweet({ id: "1" }), contributed_by: "mallory" }, makeTweet({ id: "2" })]),
    );

    const result = await upload(bucket);

    expect(result.files).toEqual([
      { name: FILE, uploaded: 2, rejected: 0, segment: expect.any(String) as string },
    ]);
    expect(bucket.uploads).toEqual([result.files[0]?.segment]);
    expect(bucket.uploads[0]).toMatch(/^v1\/segments\/tweet\/2026\/11\/02\/1793611800000-/);
    expect(segmentLines(bucket)).toEqual([
      expect.objectContaining({
        id: "1",
        contributed_by: "osolmaz",
        pooled_at: "2026-11-02T09:30:00.000Z",
      }),
      expect.objectContaining({ id: "2", contributed_by: "osolmaz" }),
    ]);
    expect(readdirSync(outboxDir)).toEqual([]);
  });

  it("gives a retried file the same segment key and stores no second object", async () => {
    const bucket = memoryBucket();
    const content = jsonl([makeTweet({ id: "1" })]);
    writeFileSync(join(outboxDir, FILE), content);
    const first = await upload(bucket);

    // A handoff retry after the first upload recreates the same sealed file.
    writeFileSync(join(outboxDir, FILE), content);
    const second = await upload(bucket);

    expect(second.files[0]?.segment).toBe(first.files[0]?.segment);
    expect(bucket.uploads).toHaveLength(1);
    expect(bucket.objects.size).toBe(1);
  });

  it("sets invalid lines aside with their line numbers and uploads the rest", async () => {
    const bucket = memoryBucket();
    writeFileSync(
      join(outboxDir, FILE),
      `${JSON.stringify(makeTweet({ id: "1" }))}\nnot json\n${JSON.stringify({ id: 7 })}\n`,
    );

    const result = await upload(bucket);

    expect(result.files[0]).toMatchObject({ uploaded: 1, rejected: 2 });
    const rejected = JSON.parse(
      readFileSync(join(outboxDir, REJECTED_DIR, `${FILE}.json`), "utf8"),
    ) as { line: number; reason: string; record: string }[];
    expect(rejected).toEqual([
      { line: 2, reason: "malformed JSON", record: "not json" },
      { line: 3, reason: expect.any(String) as string, record: '{"id":7}' },
    ]);
    expect(segmentLines(bucket).map((line) => line["id"])).toEqual(["1"]);
    expect(readdirSync(outboxDir)).toEqual([REJECTED_DIR]);
  });

  it("writes no segment when every line is invalid", async () => {
    const bucket = memoryBucket();
    writeFileSync(join(outboxDir, FILE), "not json\n");

    const result = await upload(bucket);

    expect(result.files[0]).toEqual({ name: FILE, uploaded: 0, rejected: 1, segment: undefined });
    expect(bucket.objects.size).toBe(0);
  });

  it("processes sealed files in seal order and ignores other entries", async () => {
    const bucket = memoryBucket();
    const later = `${String(SEALED_MS + 1)}-1b7c3c55-8d0e-4b8e-9f00-3d1d6c7e2a10.jsonl`;
    writeFileSync(join(outboxDir, later), jsonl([makeTweet({ id: "2" })]));
    writeFileSync(join(outboxDir, FILE), jsonl([makeTweet({ id: "1" })]));
    writeFileSync(join(outboxDir, `${FILE}.tmp`), "partial");
    mkdirSync(join(outboxDir, REJECTED_DIR));

    const result = await upload(bucket);

    expect(result.files.map((file) => file.name)).toEqual([FILE, later]);
    expect(result.ignored).toEqual([`${FILE}.tmp`]);
    expect(readdirSync(outboxDir).sort()).toEqual([`${FILE}.tmp`, REJECTED_DIR]);
  });

  it("keeps the file when the upload fails", async () => {
    const bucket = memoryBucket({ failUploads: true });
    writeFileSync(join(outboxDir, FILE), jsonl([makeTweet({ id: "1" })]));

    await expect(upload(bucket)).rejects.toThrow("hub unavailable");

    expect(readdirSync(outboxDir)).toEqual([FILE]);
  });
});
