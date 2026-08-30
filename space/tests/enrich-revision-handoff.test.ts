/* eslint-disable @typescript-eslint/require-await -- The in-memory store implements an asynchronous interface. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  CheckpointCoordinator,
  checkpointBundleKey,
  checkpointClaimKey,
  checkpointPointerKey,
  createCheckpointBundle,
  parseCheckpointClaim,
  parseCheckpointPointer,
  stableCheckpointJsonBytes,
  type CheckpointObjectStore,
} from "@osolmaz/hf-job-control";
import { enrichmentRevisionHandoffSchema } from "@xtap-pool/shared";

import { activateEnrichmentRun } from "../src/enrich-active-run.js";
import { EnrichmentCheckpointAdapter } from "../src/enrich-checkpoint.js";
import {
  prepareEnrichmentRevision,
  prepareOptionalEnrichmentRevisionHandoff,
  verifyPreparedEnrichmentRevision,
} from "../src/enrich-revision-handoff.js";
import { canonicalPlanBytes, createEnrichmentRunPlan } from "../src/enrich-run-plan.js";
import {
  createEmptyEnrichmentState,
  markQueueCompleted,
  withCheckpointSequence,
} from "../src/enrich-state.js";

const RUN_PREFIX = "operations/enrichment/runs";
const PREDECESSOR_REVISION = "aa7ccee986b7c96b494cc16e17a483740f3afb3d";
const TARGET_REVISION = "c6d07950b31eda8e0ecf74022fa72733a3bc87f8";
const QUEUE_TOTAL = 280_005;
const QUEUE_DONE = 277_572;
const REGISTRY_TOTAL = 27_153;
const REGISTRY_DONE = 27_128;

class MemoryObjects implements CheckpointObjectStore {
  readonly bucketId = "owner/index";
  readonly files = new Map<string, Uint8Array>();
  writes = 0;

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    const existing = this.files.get(path);
    if (existing !== undefined && !Buffer.from(existing).equals(Buffer.from(bytes))) {
      throw new Error("immutable object differs");
    }
    this.files.set(path, Uint8Array.from(bytes));
  }

  async writePointerHint(path: string, bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    this.files.set(path, Uint8Array.from(bytes));
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

function plan(generation: number, workerRevision: string) {
  const digit = generation.toString(16).padStart(2, "0");
  const digest = digit.repeat(32);
  return createEnrichmentRunPlan({
    schema_version: 1,
    created_at: `2026-08-${String(generation).padStart(2, "0")}T12:00:00.000Z`,
    source: {
      bucket: "owner/raw",
      snapshot_revision: "1".repeat(64),
      ordered_segments: {
        key: `snapshots/${String(generation)}.json`,
        sha256: "2".repeat(64),
        bytes: 1,
      },
    },
    contract: {
      worker_revision: workerRevision,
      contract_sha256: "3".repeat(64),
      taxonomy_version: 1,
      model: "zai-org/GLM-5.2:fireworks-ai",
      provider: "fireworks-ai",
    },
    base_index: {
      key: `index/databases/${digest}.sqlite`,
      sha256: digest,
      bytes: 1,
      source_revision: "1".repeat(64),
      source_segment_count: 1,
      receipt_count: 1,
      registry_revision: generation,
    },
    work: {
      key: `operations/enrichment/work/${String(generation)}.sqlite`,
      sha256: "4".repeat(64),
      bytes: 1,
      queue_total: QUEUE_TOTAL,
      queue_baseline_done: QUEUE_DONE,
      registry_total: REGISTRY_TOTAL,
      registry_baseline_scanned: REGISTRY_DONE,
    },
  });
}

async function productionBoundaryFixture() {
  const store = new MemoryObjects();
  let previousPlanSha256: string | undefined;
  let active = plan(1, PREDECESSOR_REVISION);
  for (let generation = 1; generation <= 29; generation += 1) {
    active = plan(generation, PREDECESSOR_REVISION);
    await store.writeImmutable(
      `${RUN_PREFIX}/${active.plan.run_id}/plan.json`,
      canonicalPlanBytes(active.plan),
    );
    await activateEnrichmentRun({
      store,
      runId: active.plan.run_id,
      planSha256: active.sha256,
      activatedAt: `2026-08-${String(generation).padStart(2, "0")}T12:00:00.000Z`,
      ...(previousPlanSha256 === undefined
        ? {}
        : { expectedCurrentPlanSha256: previousPlanSha256 }),
    });
    previousPlanSha256 = active.sha256;
  }

  const adapter = new EnrichmentCheckpointAdapter(
    createEmptyEnrichmentState({
      runId: active.plan.run_id,
      planSha256: active.sha256,
      queueTotal: QUEUE_TOTAL,
      queueBaselineDone: QUEUE_DONE,
      registryTotal: REGISTRY_TOTAL,
      registryBaselineScanned: REGISTRY_DONE,
    }),
  );
  let previousCheckpointSha256: string | null = null;
  for (let sequence = 1; sequence < 807; sequence += 1) {
    const checkpointSha256 = createHash("sha256")
      .update(`checkpoint-${String(sequence)}`)
      .digest("hex");
    const claim = parseCheckpointClaim({
      schema_version: 1,
      run_id: active.plan.run_id,
      attempt_id: "production-attempt",
      sequence,
      plan_sha256: active.sha256,
      previous_checkpoint_sha256: previousCheckpointSha256,
      checkpoint: {
        bucket: store.bucketId,
        key: checkpointBundleKey(RUN_PREFIX, active.plan.run_id, checkpointSha256),
        sha256: checkpointSha256,
        bytes: 1,
      },
      created_at: "2026-08-29T12:00:00.000Z",
    });
    await store.writeImmutable(
      checkpointClaimKey(RUN_PREFIX, claim),
      stableCheckpointJsonBytes(claim),
    );
    previousCheckpointSha256 = checkpointSha256;
  }
  adapter.replace(withCheckpointSequence(adapter.state, 807));
  const boundary = {
    name: "bounded-work",
    sequence: 807,
    reached_at: "2026-08-29T12:00:00.000Z",
    metadata: {},
  };
  const bundle = createCheckpointBundle({
    runId: active.plan.run_id,
    attemptId: "production-attempt",
    adapter: adapter.spec,
    planSha256: active.sha256,
    boundary,
    previousCheckpointSha256,
    payloads: await adapter.save(boundary),
    createdAt: "2026-08-29T12:00:00.000Z",
  });
  const bundleSha256 = createHash("sha256").update(bundle.bytes).digest("hex");
  const checkpoint = {
    bucket: store.bucketId,
    key: checkpointBundleKey(RUN_PREFIX, active.plan.run_id, bundleSha256),
    sha256: bundleSha256,
    bytes: bundle.bytes.byteLength,
  };
  const headClaim = parseCheckpointClaim({
    schema_version: 1,
    run_id: active.plan.run_id,
    attempt_id: "production-attempt",
    sequence: 807,
    plan_sha256: active.sha256,
    previous_checkpoint_sha256: previousCheckpointSha256,
    checkpoint,
    created_at: "2026-08-29T12:00:00.000Z",
  });
  const pointer = parseCheckpointPointer({
    schema_version: 1,
    run_id: active.plan.run_id,
    sequence: 807,
    plan_sha256: active.sha256,
    checkpoint,
    updated_at: "2026-08-29T12:00:00.000Z",
  });
  await store.writeImmutable(checkpoint.key, bundle.bytes);
  await store.writeImmutable(
    checkpointClaimKey(RUN_PREFIX, headClaim),
    stableCheckpointJsonBytes(headClaim),
  );
  await store.writePointerHint(
    checkpointPointerKey(RUN_PREFIX, active.plan.run_id),
    stableCheckpointJsonBytes(pointer),
  );
  return { store, active };
}

function cloneStore(source: MemoryObjects): MemoryObjects {
  const clone = new MemoryObjects();
  for (const [key, value] of source.files) clone.files.set(key, Uint8Array.from(value));
  clone.writes = source.writes;
  return clone;
}

describe("immutable enrichment revision handoff", () => {
  it("returns null without an active run and rejects an invalid target revision", async () => {
    const empty = new MemoryObjects();
    await expect(
      prepareOptionalEnrichmentRevisionHandoff({
        store: empty,
        targetWorkerRevision: TARGET_REVISION,
      }),
    ).resolves.toBeNull();
    await expect(
      prepareEnrichmentRevision({ store: empty, targetWorkerRevision: "main" }),
    ).rejects.toThrow("40-character lowercase Git SHA");
  });

  it("prepares and verifies the exact sequence-807 predecessor handoff without writes", async () => {
    const { store } = await productionBoundaryFixture();
    const writesBefore = store.writes;

    const prepared = await prepareEnrichmentRevision({
      store,
      targetWorkerRevision: TARGET_REVISION,
    });
    await expect(
      prepareOptionalEnrichmentRevisionHandoff({
        store,
        targetWorkerRevision: TARGET_REVISION,
      }),
    ).resolves.toEqual(prepared.handoff);
    const manifest = {
      source_revision: TARGET_REVISION,
      enrichment_revision_handoff: prepared.handoff,
    };

    expect(prepared.active.activeRun.generation).toBe(29);
    expect(prepared.plan.contract.worker_revision).toBe(PREDECESSOR_REVISION);
    expect(prepared.checkpoint.manifest.boundary.sequence).toBe(807);
    expect(prepared.checkpoint.evidence).toMatchObject({
      sequence: 807,
      queue_done: QUEUE_DONE,
      registry_next_ordinal: REGISTRY_DONE,
    });
    await expect(
      verifyPreparedEnrichmentRevision(manifest, prepared, TARGET_REVISION, store),
    ).resolves.toEqual(manifest);
    await expect(
      verifyPreparedEnrichmentRevision(manifest, prepared, "d".repeat(40), store),
    ).rejects.toThrow("deployment manifest source does not match the running worker revision");
    await expect(
      verifyPreparedEnrichmentRevision(
        {
          ...manifest,
          enrichment_revision_handoff: {
            ...enrichmentRevisionHandoffSchema.parse(prepared.handoff),
            checkpoint_sequence: 808,
          },
        },
        prepared,
        TARGET_REVISION,
        store,
      ),
    ).rejects.toThrow("checkpoint chain");
    expect(store.writes).toBe(writesBefore);

    const restoredAgain = await prepareEnrichmentRevision({
      store,
      targetWorkerRevision: TARGET_REVISION,
    });
    expect(restoredAgain.handoff).toEqual(prepared.handoff);
    expect(restoredAgain.adapter.state).toEqual(prepared.adapter.state);
    expect(store.writes).toBe(writesBefore);

    const firstMissingOrdinal = QUEUE_DONE;
    const once = markQueueCompleted(restoredAgain.adapter.state, [firstMissingOrdinal]);
    const twice = markQueueCompleted(once, [firstMissingOrdinal]);
    expect(once.queue.done).toBe(QUEUE_DONE + 1);
    expect(twice.queue.done).toBe(once.queue.done);
  }, 30_000);

  it("accepts the same pinned checkpoint after restore refreshes only the pointer timestamp", async () => {
    const { store, active } = await productionBoundaryFixture();
    const prepared = await prepareEnrichmentRevision({
      store,
      targetWorkerRevision: TARGET_REVISION,
    });
    const handoff = enrichmentRevisionHandoffSchema.parse(prepared.handoff);
    const manifest = {
      source_revision: TARGET_REVISION,
      enrichment_revision_handoff: handoff,
    };
    const pointerKey = checkpointPointerKey(RUN_PREFIX, active.plan.run_id);
    const pointerBefore = Uint8Array.from(store.files.get(pointerKey) ?? new Uint8Array());
    const coordinator = CheckpointCoordinator.create({
      runId: active.plan.run_id,
      attemptId: "interrupted-handoff-attempt",
      planSha256: active.sha256,
      store,
      prefix: RUN_PREFIX,
      clock: () => new Date("2026-08-29T13:00:00.000Z"),
    });

    await coordinator.restoreLatest(prepared.adapter);

    const pointerAfter = store.files.get(pointerKey) ?? new Uint8Array();
    expect(Buffer.from(pointerAfter).equals(Buffer.from(pointerBefore))).toBe(false);
    const retry = await prepareEnrichmentRevision({
      store,
      targetWorkerRevision: TARGET_REVISION,
    });
    const retryHandoff = enrichmentRevisionHandoffSchema.parse(retry.handoff);
    expect(retryHandoff).toMatchObject({
      checkpoint_sequence: handoff.checkpoint_sequence,
      checkpoint_key: handoff.checkpoint_key,
      checkpoint_sha256: handoff.checkpoint_sha256,
      checkpoint_bytes: handoff.checkpoint_bytes,
    });
    expect(retryHandoff.checkpoint_pointer_sha256).not.toBe(handoff.checkpoint_pointer_sha256);
    await expect(
      verifyPreparedEnrichmentRevision(manifest, retry, TARGET_REVISION, store),
    ).resolves.toEqual(manifest);
  }, 30_000);

  it("accepts later checkpoints only when they descend from the reviewed handoff anchor", async () => {
    const { store, active } = await productionBoundaryFixture();
    const prepared = await prepareEnrichmentRevision({
      store,
      targetWorkerRevision: TARGET_REVISION,
    });
    const manifest = {
      source_revision: TARGET_REVISION,
      enrichment_revision_handoff: prepared.handoff,
    };
    const coordinator = CheckpointCoordinator.create({
      runId: active.plan.run_id,
      attemptId: "post-handoff-attempt",
      planSha256: active.sha256,
      store,
      prefix: RUN_PREFIX,
      clock: () => new Date("2026-08-29T13:00:00.000Z"),
    });
    await coordinator.restoreLatest(prepared.adapter);
    prepared.adapter.replace(withCheckpointSequence(prepared.adapter.state, 808));
    await coordinator.commit(
      {
        name: "post-handoff-work",
        sequence: 808,
        reached_at: "2026-08-29T13:00:00.000Z",
        metadata: {},
      },
      prepared.adapter,
    );

    const advanced = await prepareEnrichmentRevision({
      store,
      targetWorkerRevision: TARGET_REVISION,
    });
    expect(advanced.handoff).toMatchObject({ checkpoint_sequence: 808 });
    await expect(
      verifyPreparedEnrichmentRevision(manifest, advanced, TARGET_REVISION, store),
    ).resolves.toEqual(manifest);
    await expect(
      verifyPreparedEnrichmentRevision(
        { source_revision: TARGET_REVISION, enrichment_revision_handoff: null },
        advanced,
        TARGET_REVISION,
        store,
      ),
    ).rejects.toThrow("checkpoint chain");

    const forkedAnchor = cloneStore(store);
    const anchorSequence = `sequence-${String(807).padStart(16, "0")}`;
    const anchorClaimKey = [...forkedAnchor.files.keys()].find((key) =>
      key.includes(anchorSequence),
    );
    expect(anchorClaimKey).toBeDefined();
    const anchorClaim = parseCheckpointClaim(
      JSON.parse(
        Buffer.from(forkedAnchor.files.get(anchorClaimKey ?? "") ?? new Uint8Array()).toString(
          "utf8",
        ),
      ),
    );
    const forkedClaim = parseCheckpointClaim({
      ...anchorClaim,
      attempt_id: "forked-anchor-attempt",
      previous_checkpoint_sha256: "9".repeat(64),
    });
    forkedAnchor.files.set(
      checkpointClaimKey(RUN_PREFIX, forkedClaim),
      stableCheckpointJsonBytes(forkedClaim),
    );
    await expect(
      verifyPreparedEnrichmentRevision(manifest, advanced, TARGET_REVISION, forkedAnchor),
    ).rejects.toThrow("checkpoint predecessor mismatch");

    const mismatchedAnchor = cloneStore(store);
    const mismatchedClaimKey = [...mismatchedAnchor.files.keys()].find((key) =>
      key.includes(anchorSequence),
    );
    expect(mismatchedClaimKey).toBeDefined();
    const mismatchedClaim = parseCheckpointClaim(
      JSON.parse(
        Buffer.from(
          mismatchedAnchor.files.get(mismatchedClaimKey ?? "") ?? new Uint8Array(),
        ).toString("utf8"),
      ),
    );
    mismatchedAnchor.files.set(
      mismatchedClaimKey ?? "",
      stableCheckpointJsonBytes({
        ...mismatchedClaim,
        previous_checkpoint_sha256: "9".repeat(64),
      }),
    );
    await expect(
      verifyPreparedEnrichmentRevision(manifest, advanced, TARGET_REVISION, mismatchedAnchor),
    ).rejects.toThrow("checkpoint bundle identity mismatch");

    const missingAnchor = cloneStore(store);
    const missingAnchorClaim = [...missingAnchor.files.keys()].find((key) =>
      key.includes(anchorSequence),
    );
    expect(missingAnchorClaim).toBeDefined();
    missingAnchor.files.delete(missingAnchorClaim ?? "");
    await expect(
      verifyPreparedEnrichmentRevision(manifest, advanced, TARGET_REVISION, missingAnchor),
    ).rejects.toThrow("checkpoint claim is missing");
  }, 30_000);

  it("rejects stale pointers, checkpoint gaps, and corrupt checkpoint bytes read-only", async () => {
    const fixture = await productionBoundaryFixture();
    const pointerKey = checkpointPointerKey(RUN_PREFIX, fixture.active.plan.run_id);

    const missingPointer = cloneStore(fixture.store);
    missingPointer.files.delete(pointerKey);
    await expect(
      prepareEnrichmentRevision({ store: missingPointer, targetWorkerRevision: TARGET_REVISION }),
    ).rejects.toThrow("required enrichment object is missing");

    const wrongPointer = cloneStore(fixture.store);
    const pointer = parseCheckpointPointer(
      JSON.parse(
        Buffer.from(wrongPointer.files.get(pointerKey) ?? new Uint8Array()).toString("utf8"),
      ),
    );
    wrongPointer.files.set(
      pointerKey,
      stableCheckpointJsonBytes({
        ...pointer,
        checkpoint: { ...pointer.checkpoint, bucket: "other/index" },
      }),
    );
    await expect(
      prepareEnrichmentRevision({ store: wrongPointer, targetWorkerRevision: TARGET_REVISION }),
    ).rejects.toThrow("pointer identity mismatch");

    const gap = cloneStore(fixture.store);
    const firstClaim = [...gap.files.keys()].find((key) =>
      key.includes("sequence-0000000000000001/"),
    );
    expect(firstClaim).toBeDefined();
    gap.files.delete(firstClaim ?? "");
    await expect(
      prepareEnrichmentRevision({ store: gap, targetWorkerRevision: TARGET_REVISION }),
    ).rejects.toThrow("sequence gap");

    const wrongClaimIdentity = cloneStore(fixture.store);
    const identityClaimKey = [...wrongClaimIdentity.files.keys()].find((key) =>
      key.includes("sequence-0000000000000001/"),
    );
    const identityClaim = parseCheckpointClaim(
      JSON.parse(
        Buffer.from(
          wrongClaimIdentity.files.get(identityClaimKey ?? "") ?? new Uint8Array(),
        ).toString("utf8"),
      ),
    );
    wrongClaimIdentity.files.set(
      identityClaimKey ?? "",
      stableCheckpointJsonBytes({ ...identityClaim, plan_sha256: "9".repeat(64) }),
    );
    await expect(
      prepareEnrichmentRevision({
        store: wrongClaimIdentity,
        targetWorkerRevision: TARGET_REVISION,
      }),
    ).rejects.toThrow("claim identity mismatch");

    const conflict = cloneStore(fixture.store);
    const conflictClaim = parseCheckpointClaim({
      ...identityClaim,
      attempt_id: "conflicting-attempt",
      checkpoint: {
        ...identityClaim.checkpoint,
        key: checkpointBundleKey(RUN_PREFIX, fixture.active.plan.run_id, "9".repeat(64)),
        sha256: "9".repeat(64),
      },
    });
    conflict.files.set(
      checkpointClaimKey(RUN_PREFIX, conflictClaim),
      stableCheckpointJsonBytes(conflictClaim),
    );
    await expect(
      prepareEnrichmentRevision({ store: conflict, targetWorkerRevision: TARGET_REVISION }),
    ).rejects.toThrow("conflicting checkpoint claims");

    const shortCheckpoint = cloneStore(fixture.store);
    const headPointer = parseCheckpointPointer(
      JSON.parse(
        Buffer.from(shortCheckpoint.files.get(pointerKey) ?? new Uint8Array()).toString("utf8"),
      ),
    );
    shortCheckpoint.files.set(headPointer.checkpoint.key, new Uint8Array());
    await expect(
      prepareEnrichmentRevision({
        store: shortCheckpoint,
        targetWorkerRevision: TARGET_REVISION,
      }),
    ).rejects.toThrow("byte count mismatch");

    const corrupt = cloneStore(fixture.store);
    corrupt.files.set(headPointer.checkpoint.key, new Uint8Array(headPointer.checkpoint.bytes));
    await expect(
      prepareEnrichmentRevision({ store: corrupt, targetWorkerRevision: TARGET_REVISION }),
    ).rejects.toThrow("SHA-256 mismatch");
  });

  it("rejects every unverified identity before continuation can create a provider", async () => {
    const { store } = await productionBoundaryFixture();
    const prepared = await prepareEnrichmentRevision({
      store,
      targetWorkerRevision: TARGET_REVISION,
    });
    let providerCalls = 0;
    const continueAfterVerification = async (manifest: unknown): Promise<void> => {
      await verifyPreparedEnrichmentRevision(manifest, prepared, TARGET_REVISION, store);
      providerCalls += 1;
    };

    await expect(
      continueAfterVerification({
        source_revision: TARGET_REVISION,
        enrichment_revision_handoff: null,
      }),
    ).rejects.toThrow("does not match the active plan and checkpoint");
    await expect(
      continueAfterVerification({
        source_revision: TARGET_REVISION,
        enrichment_revision_handoff: {
          ...prepared.handoff,
          checkpoint_sequence: 806,
        },
      }),
    ).rejects.toThrow("checkpoint claim identity mismatch");
    await expect(
      continueAfterVerification({
        source_revision: TARGET_REVISION,
        enrichment_revision_handoff: {
          ...prepared.handoff,
          contract_sha256: "9".repeat(64),
        },
      }),
    ).rejects.toThrow("does not match the active plan and checkpoint");
    expect(providerCalls).toBe(0);
  }, 30_000);

  it("keeps the reviewed handoff valid after a fenced current-revision successor activates", async () => {
    const { store, active } = await productionBoundaryFixture();
    const prepared = await prepareEnrichmentRevision({
      store,
      targetWorkerRevision: TARGET_REVISION,
    });
    const manifest = {
      source_revision: TARGET_REVISION,
      enrichment_revision_handoff: prepared.handoff,
    };
    const successor = plan(30, TARGET_REVISION);
    await store.writeImmutable(
      `${RUN_PREFIX}/${successor.plan.run_id}/plan.json`,
      canonicalPlanBytes(successor.plan),
    );
    await activateEnrichmentRun({
      store,
      runId: successor.plan.run_id,
      planSha256: successor.sha256,
      activatedAt: "2026-08-30T12:00:00.000Z",
      expectedCurrentPlanSha256: active.sha256,
    });
    const successorAdapter = new EnrichmentCheckpointAdapter(
      withCheckpointSequence(
        createEmptyEnrichmentState({
          runId: successor.plan.run_id,
          planSha256: successor.sha256,
          queueTotal: QUEUE_TOTAL,
          queueBaselineDone: QUEUE_DONE,
          registryTotal: REGISTRY_TOTAL,
          registryBaselineScanned: REGISTRY_DONE,
        }),
        1,
      ),
    );
    const successorCoordinator = CheckpointCoordinator.create({
      runId: successor.plan.run_id,
      attemptId: "successor-bootstrap",
      planSha256: successor.sha256,
      store,
      prefix: RUN_PREFIX,
      clock: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    await successorCoordinator.commit(
      {
        name: "bootstrap",
        sequence: 1,
        reached_at: "2026-08-30T12:00:00.000Z",
        metadata: {},
      },
      successorAdapter,
    );

    const current = await prepareEnrichmentRevision({
      store,
      targetWorkerRevision: TARGET_REVISION,
    });
    expect(current.handoff).toBeNull();
    await expect(
      verifyPreparedEnrichmentRevision(
        {
          source_revision: TARGET_REVISION,
          enrichment_revision_handoff: null,
        },
        current,
        TARGET_REVISION,
        store,
      ),
    ).resolves.toMatchObject({ enrichment_revision_handoff: null });
    await expect(
      verifyPreparedEnrichmentRevision(manifest, current, TARGET_REVISION, store),
    ).resolves.toEqual(manifest);
  }, 30_000);
});
