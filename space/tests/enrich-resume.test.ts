import { describe, expect, it } from "vitest";

import {
  CheckpointCoordinator,
  type CheckpointManifest,
  type CheckpointObjectStore,
} from "@osolmaz/hf-job-control";

import {
  createEnrichmentBatchResult,
  enrichmentBatchIdentity,
  enrichmentBatchResultKey,
  publishEnrichmentBatchResult,
} from "../src/enrich-batch.js";
import { EnrichmentCheckpointAdapter } from "../src/enrich-checkpoint.js";
import {
  canonicalPlanBytes,
  createEnrichmentRunPlan,
  parseEnrichmentRunPlan,
} from "../src/enrich-run-plan.js";
import {
  advanceOutputFrontier,
  advanceRegistryCursor,
  createEmptyEnrichmentState,
  isCompleted,
  markQueueCompleted,
  recordQueueAttempt,
  setPublicationState,
  validateEnrichmentState,
  withCheckpointSequence,
} from "../src/enrich-state.js";

const SHA = "a".repeat(64);
const CREATED_AT = "2026-08-19T12:00:00.000Z";

function planInput() {
  return {
    schema_version: 1 as const,
    created_at: CREATED_AT,
    source: {
      bucket: "owner/raw",
      snapshot_revision: "b".repeat(64),
      ordered_segments: { key: "plans/segments.json", sha256: "c".repeat(64), bytes: 10 },
    },
    contract: {
      worker_revision: "d".repeat(64),
      contract_sha256: "e".repeat(64),
      taxonomy_version: 1,
      model: "model",
      provider: "provider",
    },
    base_index: {
      key: "index/databases/base.sqlite",
      sha256: "f".repeat(64),
      bytes: 100,
      source_segment_count: 10,
      receipt_count: 2,
      registry_revision: 7,
    },
    work: {
      key: "plans/work.sqlite",
      sha256: "1".repeat(64),
      bytes: 50,
      queue_total: 17,
      queue_baseline_done: 10,
      registry_total: 8,
      registry_baseline_scanned: 3,
    },
  };
}

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

describe("small enrichment checkpoints", () => {
  it("derives a stable logical run from frozen plan bytes", () => {
    const first = createEnrichmentRunPlan(planInput());
    const second = createEnrichmentRunPlan(planInput());
    expect(second).toEqual(first);
    expect(
      parseEnrichmentRunPlan(JSON.parse(Buffer.from(canonicalPlanBytes(first.plan)).toString())),
    ).toEqual(first);
  });

  it("keeps completion in a compact bitmap", () => {
    const initial = createEmptyEnrichmentState({
      runId: "run",
      planSha256: SHA,
      queueTotal: 17,
      queueBaselineDone: 10,
      registryTotal: 8,
      registryBaselineScanned: 3,
    });
    const completed = markQueueCompleted(initial, [10, 11]);
    expect(completed.completed_bitmap.byteLength).toBe(3);
    expect(completed.queue.done).toBe(12);
    expect(isCompleted(completed.completed_bitmap, 11)).toBe(true);
    expect(isCompleted(completed.completed_bitmap, 12)).toBe(false);
  });

  it("rejects checkpoint boundary, payload, and identity mismatches", () => {
    const initial = createEmptyEnrichmentState({
      runId: "run",
      planSha256: SHA,
      queueTotal: 3,
      queueBaselineDone: 1,
      registryTotal: 2,
      registryBaselineScanned: 0,
    });
    const adapter = new EnrichmentCheckpointAdapter(initial);
    expect(() =>
      adapter.save({
        name: "wrong",
        sequence: 1,
        reached_at: CREATED_AT,
        metadata: {},
      }),
    ).toThrow("boundary");
    const manifest: CheckpointManifest = {
      schema_version: 1,
      run_id: "run",
      attempt_id: "attempt-1",
      adapter: adapter.spec,
      plan_sha256: SHA,
      boundary: {
        name: "batch",
        sequence: 0,
        reached_at: CREATED_AT,
        metadata: {},
      },
      previous_checkpoint_sha256: null,
      payloads: [],
      created_at: CREATED_AT,
    };
    expect(() => adapter.restore(manifest, new Map())).toThrow("payload set");
    const payloads = new Map([
      ["state.json", canonicalPlanBytes({ ...initial, completed_bitmap: undefined })],
      ["queue-completed.bin", initial.completed_bitmap],
    ]);
    expect(() => adapter.restore({ ...manifest, run_id: "other" }, payloads)).toThrow();
  });

  it("restores application state from a replacement physical attempt", async () => {
    const store = new MemoryObjects();
    const initial = createEmptyEnrichmentState({
      runId: "run",
      planSha256: SHA,
      queueTotal: 17,
      queueBaselineDone: 10,
      registryTotal: 8,
      registryBaselineScanned: 3,
    });
    const state = advanceOutputFrontier(
      markQueueCompleted(initial, [10, 11]),
      "enrichment",
      "2".repeat(64),
    );
    expect(state.sequence).toBe(0);
    const firstAdapter = new EnrichmentCheckpointAdapter(state);
    const first = CheckpointCoordinator.create({
      runId: "run",
      attemptId: "attempt-1",
      planSha256: SHA,
      store,
      clock: () => new Date(CREATED_AT),
    });
    await first.commit(
      {
        name: "enrichment-batch",
        sequence: 1,
        reached_at: CREATED_AT,
        metadata: {},
      },
      new EnrichmentCheckpointAdapter({ ...state, sequence: 1 }),
    );

    const replacementState = createEmptyEnrichmentState({
      runId: "run",
      planSha256: SHA,
      queueTotal: 17,
      queueBaselineDone: 10,
      registryTotal: 8,
      registryBaselineScanned: 3,
    });
    const replacementAdapter = new EnrichmentCheckpointAdapter(replacementState);
    const replacement = CheckpointCoordinator.create({
      runId: "run",
      attemptId: "attempt-2",
      planSha256: SHA,
      store,
    });
    const restored = await replacement.restoreLatest(replacementAdapter);
    expect(restored?.evidence.queue_done).toBe(12);
    expect(replacementAdapter.state.outputs.enrichment.sequence).toBe(1);
    expect(firstAdapter.state.sequence).toBe(0);
  });

  it("rejects corrupt bitmap, cursor, frontier, and publication state", () => {
    expect(() =>
      createEmptyEnrichmentState({
        runId: "run",
        planSha256: SHA,
        queueTotal: -1,
        queueBaselineDone: 0,
        registryTotal: 1,
        registryBaselineScanned: 0,
      }),
    ).toThrow("queueTotal");
    expect(() =>
      createEmptyEnrichmentState({
        runId: "run",
        planSha256: SHA,
        queueTotal: 1,
        queueBaselineDone: 2,
        registryTotal: 1,
        registryBaselineScanned: 0,
      }),
    ).toThrow("queue baseline");
    expect(() =>
      createEmptyEnrichmentState({
        runId: "run",
        planSha256: SHA,
        queueTotal: 1,
        queueBaselineDone: 0,
        registryTotal: 1,
        registryBaselineScanned: 2,
      }),
    ).toThrow("registry baseline");
    const initial = createEmptyEnrichmentState({
      runId: "run",
      planSha256: SHA,
      queueTotal: 3,
      queueBaselineDone: 1,
      registryTotal: 2,
      registryBaselineScanned: 0,
    });
    expect(() =>
      validateEnrichmentState({ ...initial, completed_bitmap: new Uint8Array() }),
    ).toThrow("bitmap length");
    expect(() =>
      validateEnrichmentState({ ...initial, queue: { ...initial.queue, done: 0 } }),
    ).toThrow("bitmap count");
    expect(() =>
      validateEnrichmentState({
        ...initial,
        registry: { ...initial.registry, next_ordinal: 3 },
      }),
    ).toThrow("cursor exceeds");
    expect(() =>
      validateEnrichmentState({
        ...initial,
        outputs: {
          ...initial.outputs,
          attempt: { sequence: 1, chain_sha256: null },
        },
      }),
    ).toThrow("empty output frontier");
    expect(() =>
      setPublicationState(initial, {
        state: "uploaded",
        database_key: null,
        database_sha256: null,
        database_bytes: null,
        manifest: null,
      }),
    ).toThrow("database reference");
  });

  it("rejects invalid queue updates and checkpoint sequences", () => {
    const initial = createEmptyEnrichmentState({
      runId: "run",
      planSha256: SHA,
      queueTotal: 3,
      queueBaselineDone: 1,
      registryTotal: 2,
      registryBaselineScanned: 0,
    });
    expect(() => markQueueCompleted(initial, [3])).toThrow("outside the frozen plan");
    expect(() => markQueueCompleted(initial, [-1])).toThrow("outside the frozen plan");
    expect(() => markQueueCompleted(initial, [1.5])).toThrow("outside the frozen plan");
    expect(isCompleted(new Uint8Array(), 5)).toBe(false);
    expect(markQueueCompleted(initial, [0]).queue.done).toBe(1);
    expect(() =>
      recordQueueAttempt(initial, {
        status: "retrying",
        value: {
          ordinal: 0,
          attempts: 1,
          error_class: "timeout",
          next_retry_at: null,
        },
      }),
    ).toThrow("completed queue ordinal");
    let retried = recordQueueAttempt(initial, {
      status: "retrying",
      value: {
        ordinal: 1,
        attempts: 1,
        error_class: "timeout",
        next_retry_at: null,
      },
    });
    retried = recordQueueAttempt(retried, {
      status: "blocked",
      value: {
        ordinal: 1,
        attempts: 5,
        reason: "invalid_output",
        evidence_sha256: SHA,
      },
    });
    expect(retried.queue.retrying).toHaveLength(0);
    expect(retried.queue.blocked).toHaveLength(1);
    expect(advanceRegistryCursor(initial, ["rejected"]).registry.rejected).toBe(1);
    expect(() => advanceRegistryCursor(initial, ["approved", "approved", "approved"])).toThrow(
      "exceed frozen plan",
    );
    expect(() => advanceOutputFrontier(initial, "attempt", "bad")).toThrow("SHA-256");
    expect(() => withCheckpointSequence(initial, -1)).toThrow("checkpoint sequence");
    expect(
      setPublicationState(initial, {
        state: "uploaded",
        database_key: `index/databases/${"4".repeat(64)}.sqlite`,
        database_sha256: "4".repeat(64),
        database_bytes: 10,
        manifest: {
          schema_version: 1,
          source: { bucket: "owner/raw", revision: "5".repeat(64) },
          projection: { contract_hash: "6".repeat(64) },
          database: {
            key: `index/databases/${"4".repeat(64)}.sqlite`,
            sha256: "4".repeat(64),
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
        },
      }).publication.state,
    ).toBe("uploaded");
  });

  it("rejects inconsistent plans and batch order", () => {
    expect(Buffer.from(canonicalPlanBytes([1, true, null])).toString("utf8")).toContain("true");
    expect(() => canonicalPlanBytes(Number.NaN)).toThrow("finite");
    expect(() => canonicalPlanBytes(() => undefined)).toThrow("JSON values");
    expect(() =>
      createEnrichmentRunPlan({
        ...planInput(),
        work: { ...planInput().work, queue_baseline_done: 18 },
      }),
    ).toThrow("baseline");
    const created = createEnrichmentRunPlan(planInput());
    expect(() => parseEnrichmentRunPlan({ ...created.plan, run_id: "wrong" })).toThrow("run ID");
    expect(() => parseEnrichmentRunPlan(created.plan, "f".repeat(64))).toThrow("SHA-256 mismatch");
    expect(() =>
      createEnrichmentBatchResult({
        schema_version: 1,
        run_id: "run",
        phase: "queue",
        sequence: 1,
        previous_result_sha256: null,
        ordinals: [2, 1],
        raw_segment_key: "segment",
        raw_segment_sha256: "3".repeat(64),
        created_at: CREATED_AT,
      }),
    ).toThrow("sorted and unique");
    expect(() => enrichmentBatchIdentity({ runId: "run", phase: "queue", sequence: 0 })).toThrow(
      "positive safe integer",
    );
  });

  it("publishes and verifies a deterministic result manifest", async () => {
    const store = new MemoryObjects();
    const published = await publishEnrichmentBatchResult({
      store,
      prefix: "operations",
      value: {
        schema_version: 1,
        run_id: "run",
        phase: "attempt",
        sequence: 1,
        previous_result_sha256: null,
        ordinals: [1],
        raw_segment_key: "segment",
        raw_segment_sha256: "3".repeat(64),
        created_at: CREATED_AT,
      },
    });
    expect(store.files.size).toBe(1);
    expect(published.sha256).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      publishEnrichmentBatchResult({
        store: {
          bucketId: store.bucketId,
          read: () => Promise.resolve(null),
          writeImmutable: () => Promise.resolve(),
          writePointerHint: () => Promise.resolve(),
          list: () => Promise.resolve([]),
        },
        prefix: "operations",
        value: published.result,
      }),
    ).rejects.toThrow("read-back mismatch");
  });

  it("uses deterministic result identities and chain hashes", () => {
    const created = createEnrichmentBatchResult({
      schema_version: 1,
      run_id: "run",
      phase: "queue",
      sequence: 1,
      previous_result_sha256: null,
      ordinals: [10, 11],
      raw_segment_key: "v1/segments/enrichment/result.json.gz",
      raw_segment_sha256: "3".repeat(64),
      created_at: CREATED_AT,
    });
    expect(enrichmentBatchIdentity({ runId: "run", phase: "queue", sequence: 1 })).toBe(
      "run:queue:1",
    );
    expect(enrichmentBatchResultKey("operations", created.result)).toBe(
      "operations/run/batches/queue/0000000000000001/result.json",
    );
    expect(enrichmentBatchResultKey("", created.result)).toBe(
      "run/batches/queue/0000000000000001/result.json",
    );
    expect(created.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});
