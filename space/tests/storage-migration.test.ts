/* eslint-disable @typescript-eslint/require-await -- In-memory fakes implement asynchronous storage interfaces. */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- Assertions first prove fixture values exist. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BucketLog, sha256 } from "../src/bucket-log.js";
import type { BucketObject, RawBucketClient } from "../src/bucket-log.js";
import { importPinnedDataset, verifyPinnedDataset } from "../src/storage-migration.js";
import type { PinnedDatasetSource, PinnedSourceObject } from "../src/storage-migration.js";
import { makePooled } from "./helpers.js";

const DATASET = "osolmaz/xtap-pool-data";
const RAW = "osolmaz/xtap-pool-data";
const REVISION = "a".repeat(40);

class MemoryBucket implements RawBucketClient {
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

class MemorySource implements PinnedDatasetSource {
  files = new Map<string, Uint8Array>();

  async list(): Promise<readonly PinnedSourceObject[]> {
    return [...this.files].map(([path, content]) => ({
      path,
      oid: sha256(content),
      size: content.byteLength,
    }));
  }

  async download(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing source: ${path}`);
    return new Uint8Array(content);
  }
}

function fixture(): {
  source: MemorySource;
  bucket: MemoryBucket;
  log: BucketLog;
  report: string;
} {
  const source = new MemorySource();
  const bucket = new MemoryBucket();
  const work = mkdtempSync(join(tmpdir(), "xtap-migration-"));
  const tweet = makePooled({ id: "1", contributed_by: "osolmaz" });
  source.files.set(
    "data/osolmaz/2026/08/tweets-2026-08-12.jsonl",
    bytes(`${JSON.stringify(tweet)}\n`),
  );
  source.files.set(
    "config/pool.json",
    bytes(
      '{"version":1,"admins":["osolmaz"],"members":["osolmaz"],"updated_at":"2026-08-12T00:00:00.000Z"}\n',
    ),
  );
  return {
    source,
    bucket,
    log: new BucketLog(RAW, bucket, join(work, "cache")),
    report: join(work, "report.json"),
  };
}

function options(state: ReturnType<typeof fixture>, report = state.report) {
  return {
    dataset: DATASET,
    revision: REVISION,
    log: state.log,
    reportPath: report,
    source: state.source,
  };
}

describe("pinned storage migration", () => {
  it("imports idempotently and verifies every exact row and config byte", async () => {
    const state = fixture();
    const first = await importPinnedDataset(options(state));
    expect(first.reconciliation).toMatchObject({
      rows: { tweet: 1, enrichment: 0, attempt: 0, registry: 0, receipt: 0 },
      unique_tweet_identities: 1,
      passed: true,
    });
    expect(first.source.objects).toBe(2);
    expect(first.target.objects).toBe(2);
    expect(JSON.parse(readFileSync(state.report, "utf8"))).toEqual(first);
    const keys = [...state.bucket.files.keys()];

    const second = await importPinnedDataset(options(state, `${state.report}.retry`));
    expect(second.target.snapshot_revision).toBe(first.target.snapshot_revision);
    expect([...state.bucket.files.keys()]).toEqual(keys);
    await expect(
      verifyPinnedDataset(options(state, `${state.report}.verify`)),
    ).resolves.toMatchObject({ reconciliation: { passed: true } });
  });

  it("refuses an unpinned source before touching storage", async () => {
    const state = fixture();
    await expect(importPinnedDataset({ ...options(state), revision: "main" })).rejects.toThrow(
      "40-character commit SHA",
    );
    expect(state.bucket.files.size).toBe(0);
  });

  it("rejects malformed, deleted, duplicated, and changed source rows", async () => {
    const malformed = fixture();
    malformed.source.files.set("data/osolmaz/2026/08/tweets-2026-08-13.jsonl", bytes("not-json\n"));
    await expect(importPinnedDataset(options(malformed))).rejects.toThrow("invalid JSON");

    const deleted = fixture();
    const imported = await importPinnedDataset(options(deleted));
    const segment = imported.files.find((file) => file.kind === "tweet")?.target_segment;
    expect(segment).toBeDefined();
    deleted.bucket.files.delete(segment!);
    await expect(
      verifyPinnedDataset(options(deleted, `${deleted.report}.deleted`)),
    ).rejects.toThrow("exactly the pinned import segments");

    const duplicate = fixture();
    const tweetPath = "data/osolmaz/2026/08/tweets-2026-08-12.jsonl";
    const one = new TextDecoder().decode(duplicate.source.files.get(tweetPath));
    duplicate.source.files.set(tweetPath, bytes(`${one.trim()}\n${one.trim()}\n`));
    await expect(importPinnedDataset(options(duplicate))).rejects.toThrow("duplicate line");

    const changed = fixture();
    await importPinnedDataset(options(changed));
    const raw = new TextDecoder().decode(changed.source.files.get(tweetPath));
    const changedTweet = JSON.parse(raw) as Record<string, unknown>;
    changedTweet["text"] = "changed";
    changed.source.files.set(tweetPath, bytes(`${JSON.stringify(changedTweet)}\n`));
    await expect(
      verifyPinnedDataset(options(changed, `${changed.report}.changed`)),
    ).rejects.toThrow("exactly the pinned import segments");
  });

  it("fails for unsupported paths, invalid UTF-8, and overwritten reports", async () => {
    const unsupported = fixture();
    unsupported.source.files.set("unknown.jsonl", bytes("{}\n"));
    await importPinnedDataset(options(unsupported));
    expect(unsupported.bucket.files.size).toBeGreaterThan(0);

    const invalid = fixture();
    invalid.source.files.set(
      "data/osolmaz/2026/08/tweets-2026-08-13.jsonl",
      new Uint8Array([0xff]),
    );
    await expect(importPinnedDataset(options(invalid))).rejects.toThrow("not valid UTF-8");

    const state = fixture();
    await importPinnedDataset(options(state));
    await expect(importPinnedDataset(options(state))).rejects.toThrow(/EEXIST/u);
  });
});

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
