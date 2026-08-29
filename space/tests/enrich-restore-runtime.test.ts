import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointCoordinator, type CheckpointObjectStore } from "@osolmaz/hf-job-control";

const mocks = vi.hoisted(() => ({
  checkpointStore: vi.fn<() => CheckpointObjectStore>(),
  config: vi.fn<() => Readonly<Record<string, unknown>>>(),
  rawList: vi.fn(() => Promise.resolve([])),
  rawDownload: vi.fn(() => Promise.reject(new Error("raw download must not run"))),
  taxonomy: vi.fn<(options: unknown) => Promise<unknown>>(),
}));

vi.mock("../src/config.js", () => ({ loadConfig: () => mocks.config() }));
vi.mock("../src/enrich-taxonomy-contract.js", () => ({
  resolveEnrichmentTaxonomyForContract: (options: unknown) => mocks.taxonomy(options),
}));
vi.mock("../src/enrich-checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/enrich-checkpoint.js")>();
  return {
    ...actual,
    createEnrichmentCheckpointStore: () => mocks.checkpointStore(),
    createReadOnlyEnrichmentCheckpointStore: () => {
      const store = mocks.checkpointStore();
      return {
        bucketId: store.bucketId,
        read: store.read.bind(store),
        list: store.list.bind(store),
        writeImmutable: () => Promise.reject(new Error("checkpoint store is read-only")),
        writePointerHint: () => Promise.resolve(),
      };
    },
  };
});
vi.mock("../src/bucket-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bucket-log.js")>();
  return {
    ...actual,
    createRawBucketReader: () => ({ list: mocks.rawList, download: mocks.rawDownload }),
  };
});
vi.mock("../src/job-progress.js", () => ({
  XTapJobProgress: { create: () => Promise.reject(new Error("progress writer must not run")) },
}));

import { activateEnrichmentRun } from "../src/enrich-active-run.js";
import { canonicalBytes, sha256 } from "../src/bucket-log.js";
import { EnrichmentCheckpointAdapter } from "../src/enrich-checkpoint.js";
import { DEFAULT_TAXONOMY } from "../src/enrich-config.js";
import { runPlannedEnrichmentCommand } from "../src/enrich-planned-command.js";
import { canonicalPlanBytes, createEnrichmentRunPlan } from "../src/enrich-run-plan.js";
import { createEmptyEnrichmentState } from "../src/enrich-state.js";
import { contractHashFor } from "../src/enrich-worker.js";
import { TweetStore } from "../src/store.js";

const CREATED_AT = "2026-08-21T16:16:39.793Z";
const directories: string[] = [];

class MemoryObjects implements CheckpointObjectStore {
  readonly bucketId = "owner/index";
  readonly files = new Map<string, Uint8Array>();
  writes = 0;

  read(path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    this.files.set(path, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  writePointerHint(path: string, bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    this.files.set(path, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  list(prefix: string): Promise<readonly string[]> {
    return Promise.resolve([...this.files.keys()].filter((key) => key.startsWith(prefix)).sort());
  }
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(async (path) => rm(path, { recursive: true })));
});

describe("planned enrichment restore-only runtime", () => {
  it("restores the exact checkpoint and verifies an empty tail without provider setup or writes", async () => {
    const dataDir = join(
      tmpdir(),
      `xtap-restore-${process.pid.toString()}-${Date.now().toString()}`,
    );
    directories.push(dataDir);
    await mkdir(dataDir, { recursive: true });
    const workPath = join(dataDir, "work.sqlite");
    const tweets = new TweetStore(workPath);
    tweets.close();
    const work = new Database(workPath);
    work.exec(`
      CREATE TABLE worker_queue_plan (
        ordinal INTEGER PRIMARY KEY, unit_id TEXT UNIQUE, input_hash TEXT,
        taxonomy_version INTEGER, initial_status TEXT, attempts INTEGER, next_retry_at TEXT
      );
      CREATE TABLE worker_registry_plan (ordinal INTEGER PRIMARY KEY, name TEXT UNIQUE);
    `);
    work.close();
    const workBytes = new Uint8Array(await readFile(workPath));
    const sourceSegments = canonicalPlanBytes([]);
    const sourceRevision = sha256(
      canonicalBytes({ schema_version: 1, bucket: "owner/raw", files: [] }),
    );
    const taxonomy = { labels: DEFAULT_TAXONOMY, version: 1, source: "default" as const };
    const contractHash = contractHashFor({ taxonomy, model: "model:provider" });
    mocks.taxonomy.mockResolvedValue({ taxonomy, contractHash });
    const created = createEnrichmentRunPlan({
      schema_version: 1,
      created_at: CREATED_AT,
      source: {
        bucket: "owner/raw",
        snapshot_revision: sourceRevision,
        ordered_segments: {
          key: "objects/segments.json",
          sha256: digest(sourceSegments),
          bytes: sourceSegments.byteLength,
        },
      },
      contract: {
        worker_revision: "c".repeat(40),
        contract_sha256: contractHash,
        taxonomy_version: 1,
        model: "model:provider",
        provider: "provider",
      },
      base_index: {
        key: `index/databases/${"a".repeat(64)}.sqlite`,
        sha256: "a".repeat(64),
        bytes: 1,
        source_revision: sourceRevision,
        source_segment_count: 0,
        receipt_count: 0,
        registry_revision: 1,
      },
      work: {
        key: "objects/work.sqlite",
        sha256: digest(workBytes),
        bytes: workBytes.byteLength,
        queue_total: 0,
        queue_baseline_done: 0,
        registry_total: 0,
        registry_baseline_scanned: 0,
      },
    });
    const store = new MemoryObjects();
    await Promise.all([
      store.writeImmutable(
        `operations/enrichment/runs/${created.plan.run_id}/plan.json`,
        canonicalPlanBytes(created.plan),
      ),
      store.writeImmutable(created.plan.work.key, workBytes),
      store.writeImmutable(created.plan.source.ordered_segments.key, sourceSegments),
      store.writeImmutable(
        "index/current.json",
        canonicalPlanBytes({
          schema_version: 1,
          source: { bucket: "owner/raw", revision: sourceRevision },
          projection: { contract_hash: contractHash },
          database: {
            key: created.plan.base_index.key,
            sha256: created.plan.base_index.sha256,
            predecessors: [],
          },
          counts: {
            tweets: 0,
            units: 0,
            enrichments: 0,
            attempt_events: 0,
            registry_events: 0,
            receipts: 0,
          },
        }),
      ),
    ]);
    await activateEnrichmentRun({
      store,
      runId: created.plan.run_id,
      planSha256: created.sha256,
      activatedAt: CREATED_AT,
    });
    const adapter = new EnrichmentCheckpointAdapter({
      ...createEmptyEnrichmentState({
        runId: created.plan.run_id,
        planSha256: created.sha256,
        queueTotal: 0,
        queueBaselineDone: 0,
        registryTotal: 0,
        registryBaselineScanned: 0,
      }),
      sequence: 1,
    });
    const coordinator = CheckpointCoordinator.create({
      runId: created.plan.run_id,
      attemptId: "bootstrap",
      planSha256: created.sha256,
      store,
      prefix: "operations/enrichment/runs",
      clock: () => new Date(CREATED_AT),
    });
    await coordinator.commit(
      { name: "bootstrap", sequence: 1, reached_at: CREATED_AT, metadata: { imported: true } },
      adapter,
    );
    const writesBeforeRestore = store.writes;
    mocks.checkpointStore.mockReturnValue(store);
    mocks.config.mockReturnValue({
      enrichEnabled: false,
      inferenceToken: undefined,
      indexBucket: "owner/index",
      rawBucket: "owner/raw",
      hfToken: "storage",
      dataDir,
      taxonomyVersion: 1,
      llmModel: "model:provider",
    });

    await runPlannedEnrichmentCommand(
      {
        XTAP_RESTORE_ONLY: "true",
        XTAP_SOURCE_REVISION: created.plan.contract.worker_revision,
      },
      {
        deploymentManifest: {
          source_revision: created.plan.contract.worker_revision,
          enrichment_revision_handoff: null,
        },
      },
    );

    expect(store.writes).toBe(writesBeforeRestore);
    expect(mocks.rawList).toHaveBeenCalledTimes(1);
    expect(mocks.rawDownload).not.toHaveBeenCalled();
  });
});

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
