/* eslint-disable @typescript-eslint/require-await -- In-memory fakes implement asynchronous storage interfaces. */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- Assertions first prove fixture values exist. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BucketLog, sha256 } from "../src/bucket-log.js";
import type { BucketObject, RawBucketClient } from "../src/bucket-log.js";
import {
  createPinnedDatasetSource,
  importPinnedDataset,
  verifyPinnedDataset,
} from "../src/storage-migration.js";
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
  source.files.set("config/service-accounts.json", bytes('{"version":1,"accounts":[]}\n'));
  source.files.set("config/labels.json", bytes('{"version":1,"labels":[]}\n'));
  source.files.set("enrichment/vocabulary.json", bytes('{"version":1,"labels":[]}\n'));
  source.files.set(
    "enrichment/2026/08/enrichment-2026-08-12.jsonl",
    bytes(
      `${JSON.stringify({
        unit_id: "1:author",
        tweet_ids: ["1"],
        input_hash: "input",
        contract_hash: "contract",
        preset_labels: [],
        free_labels: [],
        model: "model",
        taxonomy_version: 1,
        enriched_at: "2026-08-12T00:00:00.000Z",
      })}\n`,
    ),
  );
  source.files.set(
    "enrichment/attempts/2026/08/attempts-2026-08-12.jsonl",
    bytes(
      `${JSON.stringify({
        unit_id: "1:author",
        input_hash: "input",
        contract_hash: "contract",
        attempt: 1,
        outcome: "success",
        at: "2026-08-12T00:00:00.000Z",
      })}\n`,
    ),
  );
  source.files.set(
    "enrichment/registry/2026/08/registry-2026-08-12.jsonl",
    bytes(
      `${JSON.stringify({
        name: "inference",
        status: "approved",
        at: "2026-08-12T00:00:00.000Z",
        contract_hash: "contract",
        registry_revision: 1,
        quotes: [],
        actor: "worker",
      })}\n`,
    ),
  );
  source.files.set(
    "enrichment/receipts/2026-08-12.jsonl",
    bytes(
      `${JSON.stringify({
        started_at: "2026-08-12T00:00:00.000Z",
        finished_at: "2026-08-12T00:01:00.000Z",
        units: 1,
        calls: 1,
        prompt_tokens: 10,
        completion_tokens: 5,
        failures: 0,
        retries: 0,
        blocked: 0,
        contract_hash: "contract",
        worker_id: "worker",
        discarded_assignments: 0,
        new_candidates: 0,
        new_approvals: 0,
        new_rejections: 0,
      })}\n`,
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
      rows: { tweet: 1, enrichment: 1, attempt: 1, registry: 1, receipt: 1 },
      unique_tweet_identities: 1,
      passed: true,
    });
    expect(first.source.objects).toBe(9);
    expect(first.target.objects).toBe(9);
    expect(JSON.parse(readFileSync(state.report, "utf8"))).toEqual(first);
    const keys = [...state.bucket.files.keys()];

    const second = await importPinnedDataset(options(state, `${state.report}.retry`));
    expect(second.target.snapshot_revision).toBe(first.target.snapshot_revision);
    expect([...state.bucket.files.keys()]).toEqual(keys);
    await expect(
      verifyPinnedDataset(options(state, `${state.report}.verify`)),
    ).resolves.toMatchObject({ reconciliation: { passed: true } });
  });

  it("preserves source-shard chronology for monotonic registry replay", async () => {
    const state = fixture();
    for (const [day, revision, status] of [
      ["11", 2, "candidate"],
      ["12", 3, "approved"],
    ] as const) {
      state.source.files.set(
        `enrichment/registry/2026/08/registry-2026-08-${day}.jsonl`,
        bytes(
          `${JSON.stringify({
            name: "inference",
            status,
            at: `2026-08-${day}T00:00:00.000Z`,
            contract_hash: "contract",
            registry_revision: revision,
            quotes: [],
            actor: "worker",
          })}\n`,
        ),
      );
    }

    const report = await importPinnedDataset(options(state));
    const registryKeys = report.files
      .filter((file) => file.kind === "registry")
      .map((file) => file.target_segment);
    expect(registryKeys).toEqual([...registryKeys].sort());
  });

  it("rejects a pinned source that omits required configuration", async () => {
    const state = fixture();
    state.source.files.delete("config/service-accounts.json");

    await expect(importPinnedDataset(options(state))).rejects.toThrow(
      "missing required configuration: config/service-accounts.json",
    );
  });

  it("requires a pinned source and a configured token", async () => {
    const state = fixture();
    await expect(importPinnedDataset({ ...options(state), revision: "main" })).rejects.toThrow(
      "40-character commit SHA",
    );
    expect(state.bucket.files.size).toBe(0);
    expect(() => createPinnedDatasetSource(DATASET, REVISION, "")).toThrow("HF_TOKEN");
    process.env["HF_TOKEN"] = "restore-after-test";
    const originalToken = process.env["HF_TOKEN"];
    delete process.env["HF_TOKEN"];
    expect(() => createPinnedDatasetSource(DATASET, REVISION)).toThrow("HF_TOKEN");
    process.env["HF_TOKEN"] = originalToken;
  });

  it("rejects malformed, deleted, duplicated, and changed source rows", async () => {
    const emptyRows = fixture();
    emptyRows.source.files.set("data/osolmaz/2026/08/tweets-2026-08-13.jsonl", bytes("\n"));
    await expect(importPinnedDataset(options(emptyRows))).rejects.toThrow("no valid records");

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

    const pathContributor = fixture();
    const fallbackTweet = makePooled({ id: "2" }) as unknown as Record<string, unknown>;
    delete fallbackTweet["contributed_by"];
    pathContributor.source.files.set(
      "data/osolmaz/2026/08/tweets-2026-08-13.jsonl",
      bytes(`${JSON.stringify(fallbackTweet)}\n`),
    );
    await expect(importPinnedDataset(options(pathContributor))).resolves.toMatchObject({
      reconciliation: { unique_tweet_identities: 2 },
    });

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

    const empty = fixture();
    empty.source.files.clear();
    await expect(importPinnedDataset(options(empty))).rejects.toThrow(
      "no approved durable objects",
    );

    const invalid = fixture();
    invalid.source.files.set(
      "data/osolmaz/2026/08/tweets-2026-08-13.jsonl",
      new Uint8Array([0xff]),
    );
    await expect(importPinnedDataset(options(invalid))).rejects.toThrow("not valid UTF-8");

    const wrongSize = fixture();
    wrongSize.source.list = async () =>
      (await MemorySource.prototype.list.call(wrongSize.source)).map((object) => ({
        ...object,
        size: object.size + 1,
      }));
    await expect(importPinnedDataset(options(wrongSize))).rejects.toThrow("size mismatch");

    const duplicatePath = fixture();
    duplicatePath.source.list = async () => {
      const listed = await MemorySource.prototype.list.call(duplicatePath.source);
      return [...listed, listed[0]!];
    };
    await expect(importPinnedDataset(options(duplicatePath))).rejects.toThrow(
      "duplicate approved paths",
    );

    const state = fixture();
    await importPinnedDataset(options(state));
    await expect(importPinnedDataset(options(state))).rejects.toThrow(/EEXIST/u);
  });
});

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
