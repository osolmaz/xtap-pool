import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointCoordinator, type CheckpointObjectStore } from "@osolmaz/hf-job-control";

type ProgressMock = {
  checkpointClaims: (completed: number, total: number) => Promise<void>;
  outputClaims: (completed: number, total: number) => Promise<void>;
  checkpointReplay: (completed: number, total: number) => Promise<void>;
  complete: () => Promise<void>;
  blocked: () => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  checkpointStore: vi.fn<() => CheckpointObjectStore>(),
  checkpointWriter: vi.fn<() => CheckpointObjectStore>(),
  config: vi.fn<() => Readonly<Record<string, unknown>>>(),
  rawWriter: vi.fn(() => ({})),
  progressCreate: vi.fn<() => Promise<ProgressMock>>(),
  progress: {
    checkpointClaims: vi.fn(() => Promise.resolve()),
    outputClaims: vi.fn(() => Promise.resolve()),
    checkpointReplay: vi.fn(() => Promise.resolve()),
    complete: vi.fn(() => Promise.resolve()),
    blocked: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("../src/config.js", () => ({ loadConfig: () => mocks.config() }));
vi.mock("../src/enrich-checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/enrich-checkpoint.js")>();
  return {
    ...actual,
    createEnrichmentCheckpointStore: () => mocks.checkpointWriter(),
    createReadOnlyEnrichmentCheckpointStore: () => mocks.checkpointStore(),
  };
});
vi.mock("../src/bucket-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bucket-log.js")>();
  return {
    ...actual,
    BucketLog: class BucketLog {
      readonly fixture = true;

      primeTextCacheFromLatestWrites(): Promise<void> {
        return Promise.resolve();
      }

      replayVerifiedTail(
        _known: readonly unknown[],
        options: { progress?: (completed: number, total: number) => Promise<void> },
      ) {
        return options.progress?.(0, 0) ?? Promise.resolve();
      }
    },
    createRawBucketClient: () => mocks.rawWriter(),
    createRawBucketReader: () => ({}),
  };
});
vi.mock("../src/enrich-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/enrich-config.js")>();
  return {
    ...actual,
    loadEnrichTaxonomy: () => Promise.resolve({ labels: [], version: 1, source: "default" }),
  };
});
vi.mock("../src/job-progress.js", () => ({
  XTapJobProgress: { create: () => mocks.progressCreate() },
}));

import { activateEnrichmentRun } from "../src/enrich-active-run.js";
import { createEnrichmentBatchResult, enrichmentBatchResultKey } from "../src/enrich-batch.js";
import { canonicalBytes, sha256 } from "../src/bucket-log.js";
import { EnrichmentCheckpointAdapter } from "../src/enrich-checkpoint.js";
import {
  runPlannedEnrichmentCommand,
  successorContractForWorker,
  validatePreparedEnrichmentWorkerOutputs,
} from "../src/enrich-planned-command.js";
import { prepareEnrichmentRevision } from "../src/enrich-revision-handoff.js";
import { canonicalPlanBytes, createEnrichmentRunPlan } from "../src/enrich-run-plan.js";
import {
  createEmptyEnrichmentState,
  recordQueueAttempt,
  setPublicationState,
} from "../src/enrich-state.js";
import { contractHashFor } from "../src/enrich-worker.js";
import { TweetStore } from "../src/store.js";

class MemoryObjects implements CheckpointObjectStore {
  readonly bucketId = "memory/checkpoints";
  readonly files = new Map<string, Uint8Array>();

  read(path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
    const existing = this.files.get(path);
    if (existing !== undefined && !Buffer.from(existing).equals(Buffer.from(bytes))) {
      throw new Error("immutable object differs");
    }
    this.files.set(path, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  writePointerHint(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  list(prefix: string): Promise<readonly string[]> {
    return Promise.resolve([...this.files.keys()].filter((key) => key.startsWith(prefix)).sort());
  }
}

const directories: string[] = [];
const CREATED_AT = "2026-08-19T12:00:00.000Z";
const BASE_SHA = "a".repeat(64);
const DATABASE_KEY = `index/databases/${BASE_SHA}.sqlite`;

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("planned enrichment runtime", () => {
  it("stamps successor contracts with the running worker revision", () => {
    const predecessor = createEnrichmentRunPlan({
      schema_version: 1,
      created_at: CREATED_AT,
      source: {
        bucket: "owner/raw",
        snapshot_revision: "1".repeat(64),
        ordered_segments: { key: "segments.json", sha256: "2".repeat(64), bytes: 1 },
      },
      contract: {
        worker_revision: "a".repeat(40),
        contract_sha256: "3".repeat(64),
        taxonomy_version: 1,
        model: "model:provider",
        provider: "provider",
      },
      base_index: {
        key: "index.sqlite",
        sha256: "4".repeat(64),
        bytes: 1,
        source_revision: "5".repeat(64),
        source_segment_count: 0,
        receipt_count: 0,
        registry_revision: 0,
      },
      work: {
        key: "work.sqlite",
        sha256: "6".repeat(64),
        bytes: 1,
        queue_total: 1,
        queue_baseline_done: 0,
        registry_total: 0,
        registry_baseline_scanned: 0,
      },
    });

    expect(successorContractForWorker(predecessor.plan, "b".repeat(40))).toEqual({
      ...predecessor.plan.contract,
      worker_revision: "b".repeat(40),
    });
  });

  it("validates handoff result claims before writers and stops after a blocked successor", async () => {
    const dataDir = join(
      tmpdir(),
      `xtap-planned-${process.pid.toString()}-${Date.now().toString()}`,
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
    const store = new MemoryObjects();
    const contractHash = contractHashFor({
      taxonomy: { labels: [], version: 1, source: "default" },
      model: "model:provider",
    });
    const sourceSegments = canonicalPlanBytes([]);
    const sourceRevision = sha256(
      canonicalBytes({ schema_version: 1, bucket: "owner/raw", files: [] }),
    );
    const current = createEnrichmentRunPlan({
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
        key: DATABASE_KEY,
        sha256: BASE_SHA,
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
    const targetWorkerRevision = "d".repeat(40);
    const successor = createEnrichmentRunPlan({
      ...withoutRunId(current.plan),
      created_at: "2026-08-19T13:00:00.000Z",
      contract: successorContractForWorker(current.plan, targetWorkerRevision),
      work: {
        ...current.plan.work,
        queue_total: 1,
        queue_baseline_done: 0,
      },
    });
    await Promise.all([
      store.writeImmutable(
        `operations/enrichment/runs/${current.plan.run_id}/plan.json`,
        canonicalPlanBytes(current.plan),
      ),
      store.writeImmutable(
        `operations/enrichment/runs/${successor.plan.run_id}/plan.json`,
        canonicalPlanBytes(successor.plan),
      ),
      store.writeImmutable(current.plan.work.key, workBytes),
      store.writeImmutable(current.plan.source.ordered_segments.key, sourceSegments),
    ]);
    const manifest = {
      schema_version: 1 as const,
      source: { bucket: "owner/raw", revision: current.plan.source.snapshot_revision },
      projection: { contract_hash: contractHash },
      database: { key: DATABASE_KEY, sha256: BASE_SHA, predecessors: [] },
      counts: {
        tweets: 0,
        units: 0,
        enrichments: 0,
        attempt_events: 0,
        registry_events: 0,
        receipts: 0,
      },
    };
    const state = setPublicationState(
      createEmptyEnrichmentState({
        runId: current.plan.run_id,
        planSha256: current.sha256,
        queueTotal: 0,
        queueBaselineDone: 0,
        registryTotal: 0,
        registryBaselineScanned: 0,
      }),
      {
        state: "published",
        database_key: DATABASE_KEY,
        database_sha256: BASE_SHA,
        database_bytes: 1,
        manifest,
      },
    );
    const adapter = new EnrichmentCheckpointAdapter({ ...state, sequence: 1 });
    const coordinator = CheckpointCoordinator.create({
      runId: current.plan.run_id,
      attemptId: "bootstrap",
      planSha256: current.sha256,
      store,
      prefix: "operations/enrichment/runs",
      clock: () => new Date(CREATED_AT),
    });
    await coordinator.commit(
      { name: "published", sequence: 1, reached_at: CREATED_AT, metadata: {} },
      adapter,
    );
    const successorState = recordQueueAttempt(
      createEmptyEnrichmentState({
        runId: successor.plan.run_id,
        planSha256: successor.sha256,
        queueTotal: 1,
        queueBaselineDone: 0,
        registryTotal: 0,
        registryBaselineScanned: 0,
      }),
      {
        status: "blocked",
        value: {
          ordinal: 0,
          attempts: 1,
          reason: "permanent",
          evidence_sha256: "d".repeat(64),
        },
      },
    );
    const successorAdapter = new EnrichmentCheckpointAdapter({ ...successorState, sequence: 1 });
    const successorCoordinator = CheckpointCoordinator.create({
      runId: successor.plan.run_id,
      attemptId: "bootstrap",
      planSha256: successor.sha256,
      store,
      prefix: "operations/enrichment/runs",
      clock: () => new Date("2026-08-19T13:00:00.000Z"),
    });
    await successorCoordinator.commit(
      {
        name: "bootstrap",
        sequence: 1,
        reached_at: "2026-08-19T13:00:00.000Z",
        metadata: { imported: true },
      },
      successorAdapter,
    );
    await store.writeImmutable(
      `operations/enrichment/runs/${current.plan.run_id}/successor.json`,
      canonicalPlanBytes({
        schema_version: 1,
        predecessor_run_id: current.plan.run_id,
        predecessor_plan_sha256: current.sha256,
        run_id: successor.plan.run_id,
        plan_sha256: successor.sha256,
        created_at: "2026-08-19T13:00:00.000Z",
      }),
    );
    await activateEnrichmentRun({
      store,
      runId: current.plan.run_id,
      planSha256: current.sha256,
      activatedAt: CREATED_AT,
    });
    mocks.checkpointStore.mockReturnValue(store);
    mocks.checkpointWriter.mockReturnValue(store);
    mocks.progressCreate.mockResolvedValue(mocks.progress);
    mocks.config.mockReturnValue({
      enrichEnabled: true,
      inferenceToken: "inference",
      indexBucket: "owner/index",
      rawBucket: "owner/raw",
      hfToken: "storage",
      dataDir,
      taxonomyVersion: 1,
      llmModel: "model:provider",
    });

    const preparedRevision = await prepareEnrichmentRevision({
      store,
      targetWorkerRevision,
    });
    const runtimeEnv = {
      JOB_ID: "attempt-2",
      XTAP_SOURCE_REVISION: targetWorkerRevision,
    };
    const runtimeOptions = {
      deploymentManifest: {
        source_revision: targetWorkerRevision,
        enrichment_revision_handoff: preparedRevision.handoff,
      },
    };
    const malformedResultKey =
      `operations/enrichment/runs/${current.plan.run_id}/batches/queue/` +
      `${"0".repeat(64)}/result.json`;
    store.files.set(malformedResultKey, Buffer.from("{"));

    const handoffValidation = () =>
      validatePreparedEnrichmentWorkerOutputs({
        preparedRevision,
        checkpointStore: store,
        rawBucket: "owner/raw",
        accessToken: "storage",
        dataDir: join(dataDir, "handoff-validation"),
      });
    await expect(handoffValidation()).rejects.toThrow();
    await expect(runPlannedEnrichmentCommand(runtimeEnv, runtimeOptions)).rejects.toThrow();
    expect(mocks.rawWriter).not.toHaveBeenCalled();
    expect(mocks.progressCreate).not.toHaveBeenCalled();
    expect(mocks.checkpointWriter).not.toHaveBeenCalled();

    store.files.delete(malformedResultKey);
    const uncheckpointed = createEnrichmentBatchResult({
      schema_version: 1,
      run_id: current.plan.run_id,
      phase: "receipt",
      sequence: 1,
      previous_result_sha256: null,
      ordinals: [],
      raw_segment_key: `v1/segments/receipt/2026/08/19/1-${"0".repeat(36)}-${"e".repeat(64)}.json.gz`,
      raw_segment_sha256: "e".repeat(64),
      created_at: CREATED_AT,
    });
    const uncheckpointedKey = enrichmentBatchResultKey(
      "operations/enrichment/runs",
      uncheckpointed.result,
    );
    store.files.set(uncheckpointedKey, uncheckpointed.bytes);
    await expect(handoffValidation()).rejects.toThrow("uncheckpointed receipt result manifest");

    store.files.delete(uncheckpointedKey);
    await expect(handoffValidation()).resolves.toEqual({ claimedSegments: 0, orphanSegments: 0 });
    await runPlannedEnrichmentCommand(runtimeEnv, runtimeOptions);

    expect(mocks.rawWriter).toHaveBeenCalledOnce();
    expect(mocks.progressCreate).toHaveBeenCalledOnce();
    expect(mocks.checkpointWriter).toHaveBeenCalledOnce();
    expect(mocks.progress.complete).toHaveBeenCalledOnce();
    const active: unknown = JSON.parse(
      Buffer.from(
        store.files.get("operations/enrichment/runs/active.json") ?? new Uint8Array(),
      ).toString("utf8"),
    );
    expect(active).toMatchObject({
      generation: 2,
      run_id: successor.plan.run_id,
      plan_sha256: successor.sha256,
    });
  });
});

function withoutRunId(plan: ReturnType<typeof createEnrichmentRunPlan>["plan"]) {
  const { run_id: excluded, ...input } = plan;
  void excluded;
  return input;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
