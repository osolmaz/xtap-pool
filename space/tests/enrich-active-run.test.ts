import { describe, expect, it } from "vitest";
import type { CheckpointObjectStore } from "@osolmaz/hf-job-control";

import { activateEnrichmentRun, resolveActiveEnrichmentRun } from "../src/enrich-active-run.js";
import { canonicalPlanBytes, createEnrichmentRunPlan } from "../src/enrich-run-plan.js";

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

class CorruptActivationReadObjects extends MemoryObjects {
  override read(path: string): Promise<Uint8Array | null> {
    if (path.includes("/activations/")) return Promise.resolve(new Uint8Array());
    return super.read(path);
  }
}

const SHA = "a".repeat(64);

function plan(createdAt: string, baseSha: string) {
  return createEnrichmentRunPlan({
    schema_version: 1,
    created_at: createdAt,
    source: {
      bucket: "owner/raw",
      snapshot_revision: "b".repeat(64),
      ordered_segments: { key: "segments.json", sha256: "c".repeat(64), bytes: 1 },
    },
    contract: {
      worker_revision: "d".repeat(40),
      contract_sha256: SHA,
      taxonomy_version: 1,
      model: "model:provider",
      provider: "provider",
    },
    base_index: {
      key: `index/databases/${baseSha}.sqlite`,
      sha256: baseSha,
      bytes: 1,
      source_revision: "b".repeat(64),
      source_segment_count: 1,
      receipt_count: 1,
      registry_revision: 1,
    },
    work: {
      key: "work.sqlite",
      sha256: "e".repeat(64),
      bytes: 1,
      queue_total: 1,
      queue_baseline_done: 0,
      registry_total: 0,
      registry_baseline_scanned: 0,
    },
  });
}

async function putPlan(store: MemoryObjects, value: ReturnType<typeof plan>): Promise<void> {
  await store.writeImmutable(
    `operations/enrichment/runs/${value.plan.run_id}/plan.json`,
    canonicalPlanBytes(value.plan),
  );
}

describe("active enrichment run history", () => {
  it("rejects empty history and missing plans, and keeps activation idempotent", async () => {
    const store = new MemoryObjects();
    await expect(resolveActiveEnrichmentRun(store)).rejects.toThrow("history is empty");
    await expect(
      activateEnrichmentRun({
        store,
        runId: "missing",
        planSha256: "1".repeat(64),
        activatedAt: "2026-08-19T12:00:00.000Z",
      }),
    ).rejects.toThrow("required enrichment object is missing");
    const first = plan("2026-08-19T12:00:00.000Z", "f".repeat(64));
    await putPlan(store, first);
    const activated = await activateEnrichmentRun({
      store,
      runId: first.plan.run_id,
      planSha256: first.sha256,
      activatedAt: "2026-08-19T12:00:00.000Z",
    });
    await expect(
      activateEnrichmentRun({
        store,
        runId: first.plan.run_id,
        planSha256: first.sha256,
        activatedAt: "2026-08-19T13:00:00.000Z",
        expectedCurrentPlanSha256: first.sha256,
      }),
    ).resolves.toEqual(activated);
    expect([...store.files.keys()].filter((key) => key.includes("/activations/"))).toHaveLength(1);
  });

  it("rejects activation claims with invalid root and generation identities", async () => {
    const created = plan("2026-08-19T12:00:00.000Z", "f".repeat(64));
    const wrongRoot = new MemoryObjects();
    await putPlan(wrongRoot, created);
    wrongRoot.files.set(
      "operations/enrichment/runs/activations/000000000001.json",
      canonicalPlanBytes({
        schema_version: 1,
        generation: 1,
        run_id: created.plan.run_id,
        plan_sha256: created.sha256,
        previous_plan_sha256: "9".repeat(64),
        activated_at: "2026-08-19T12:00:00.000Z",
      }),
    );
    await expect(resolveActiveEnrichmentRun(wrongRoot)).rejects.toThrow(
      "must not have a predecessor",
    );

    const wrongGeneration = new MemoryObjects();
    await putPlan(wrongGeneration, created);
    wrongGeneration.files.set(
      "operations/enrichment/runs/activations/000000000001.json",
      canonicalPlanBytes({
        schema_version: 1,
        generation: 2,
        run_id: created.plan.run_id,
        plan_sha256: created.sha256,
        previous_plan_sha256: null,
        activated_at: "2026-08-19T12:00:00.000Z",
      }),
    );
    await expect(resolveActiveEnrichmentRun(wrongGeneration)).rejects.toThrow(
      "generation does not match",
    );

    const wrongEdge = new MemoryObjects();
    const successor = plan("2026-08-19T13:00:00.000Z", "1".repeat(64));
    await putPlan(wrongEdge, created);
    await putPlan(wrongEdge, successor);
    await activateEnrichmentRun({
      store: wrongEdge,
      runId: created.plan.run_id,
      planSha256: created.sha256,
      activatedAt: "2026-08-19T12:00:00.000Z",
    });
    wrongEdge.files.set(
      "operations/enrichment/runs/activations/000000000002.json",
      canonicalPlanBytes({
        schema_version: 1,
        generation: 2,
        run_id: successor.plan.run_id,
        plan_sha256: successor.sha256,
        previous_plan_sha256: "8".repeat(64),
        activated_at: "2026-08-19T13:00:00.000Z",
      }),
    );
    await expect(resolveActiveEnrichmentRun(wrongEdge)).rejects.toThrow("predecessor mismatch");
  });

  it("rejects mismatched plan paths and activation read-back", async () => {
    const created = plan("2026-08-19T12:00:00.000Z", "f".repeat(64));
    const alias = new MemoryObjects();
    await alias.writeImmutable(
      "operations/enrichment/runs/alias/plan.json",
      canonicalPlanBytes(created.plan),
    );
    await expect(
      activateEnrichmentRun({
        store: alias,
        runId: "alias",
        planSha256: created.sha256,
        activatedAt: "2026-08-19T12:00:00.000Z",
      }),
    ).rejects.toThrow("plan ID mismatch");

    const corrupt = new CorruptActivationReadObjects();
    await putPlan(corrupt, created);
    await expect(
      activateEnrichmentRun({
        store: corrupt,
        runId: created.plan.run_id,
        planSha256: created.sha256,
        activatedAt: "2026-08-19T12:00:00.000Z",
      }),
    ).rejects.toThrow("read-back mismatch");
  });

  it("resolves immutable activation claims instead of trusting the mutable pointer", async () => {
    const store = new MemoryObjects();
    const first = plan("2026-08-19T12:00:00.000Z", "f".repeat(64));
    const second = plan("2026-08-19T13:00:00.000Z", "1".repeat(64));
    await putPlan(store, first);
    await putPlan(store, second);
    await activateEnrichmentRun({
      store,
      runId: first.plan.run_id,
      planSha256: first.sha256,
      activatedAt: "2026-08-19T12:00:00.000Z",
    });
    await activateEnrichmentRun({
      store,
      runId: second.plan.run_id,
      planSha256: second.sha256,
      activatedAt: "2026-08-19T13:00:00.000Z",
      expectedCurrentPlanSha256: first.sha256,
    });
    store.files.set("operations/enrichment/runs/active.json", Buffer.from("not trusted", "utf8"));
    await expect(resolveActiveEnrichmentRun(store)).resolves.toMatchObject({
      generation: 2,
      run_id: second.plan.run_id,
      plan_sha256: second.sha256,
      previous_plan_sha256: first.sha256,
    });
  });

  it("rejects a stale successor and a broken activation chain", async () => {
    const store = new MemoryObjects();
    const first = plan("2026-08-19T12:00:00.000Z", "f".repeat(64));
    const second = plan("2026-08-19T13:00:00.000Z", "1".repeat(64));
    await putPlan(store, first);
    await putPlan(store, second);
    await activateEnrichmentRun({
      store,
      runId: first.plan.run_id,
      planSha256: first.sha256,
      activatedAt: "2026-08-19T12:00:00.000Z",
    });
    await expect(
      activateEnrichmentRun({
        store,
        runId: second.plan.run_id,
        planSha256: second.sha256,
        activatedAt: "2026-08-19T13:00:00.000Z",
        expectedCurrentPlanSha256: "9".repeat(64),
      }),
    ).rejects.toThrow("changed before successor activation");

    store.files.set(
      "operations/enrichment/runs/activations/000000000003.json",
      Buffer.from("{}", "utf8"),
    );
    await expect(resolveActiveEnrichmentRun(store)).rejects.toThrow("not contiguous");
  });
});
