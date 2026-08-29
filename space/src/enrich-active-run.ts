import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { CheckpointObjectStore } from "@osolmaz/hf-job-control";
import { z } from "zod";

import { canonicalPlanBytes, parseEnrichmentRunPlan } from "./enrich-run-plan.js";

const RUN_PREFIX = "operations/enrichment/runs";
const ACTIVATION_PREFIX = `${RUN_PREFIX}/activations`;
const ACTIVE_POINTER_KEY = `${RUN_PREFIX}/active.json`;
const CLAIM_KEY = /^operations\/enrichment\/runs\/activations\/(\d{12})\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const activeRunSchema = z
  .object({
    schema_version: z.literal(1),
    generation: z.number().int().positive(),
    run_id: z.string().regex(SAFE_ID),
    plan_sha256: z.string().regex(SHA256),
    previous_plan_sha256: z.string().regex(SHA256).nullable(),
    activated_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type ActiveEnrichmentRun = z.infer<typeof activeRunSchema>;

export type ActiveEnrichmentRunEvidence = {
  activeRun: ActiveEnrichmentRun;
  key: string;
  bytes: Uint8Array;
  sha256: string;
};

export async function resolveActiveEnrichmentRun(
  store: CheckpointObjectStore,
): Promise<ActiveEnrichmentRun> {
  return (await resolveActiveEnrichmentRunEvidence(store)).activeRun;
}

// eslint-disable-next-line complexity -- Every activation identity and chain edge is verified independently.
export async function resolveActiveEnrichmentRunEvidence(
  store: CheckpointObjectStore,
): Promise<ActiveEnrichmentRunEvidence> {
  const keys = (await store.list(ACTIVATION_PREFIX)).filter((key) => CLAIM_KEY.test(key)).sort();
  if (keys.length === 0) throw new Error("enrichment run activation history is empty");
  let previous: ActiveEnrichmentRun | null = null;
  let currentKey: string | null = null;
  let currentBytes: Uint8Array | null = null;
  for (const [index, key] of keys.entries()) {
    const generation = index + 1;
    if (key !== activationKey(generation)) {
      throw new Error("enrichment run activation history is not contiguous");
    }
    const value = await requiredObject(store, key);
    const claim = activeRunSchema.parse(JSON.parse(Buffer.from(value).toString("utf8")));
    if (claim.generation !== generation) {
      throw new Error("enrichment run activation generation does not match its path");
    }
    if (claim.previous_plan_sha256 !== previous?.plan_sha256 && previous !== null) {
      throw new Error("enrichment run activation predecessor mismatch");
    }
    if (previous === null && claim.previous_plan_sha256 !== null) {
      throw new Error("first enrichment run activation must not have a predecessor");
    }
    await verifyPlan(store, claim);
    previous = claim;
    currentKey = key;
    currentBytes = Uint8Array.from(value);
  }
  if (previous === null || currentKey === null || currentBytes === null) {
    throw new Error("enrichment run activation history is empty");
  }
  return {
    activeRun: previous,
    key: currentKey,
    bytes: currentBytes,
    sha256: createHash("sha256").update(currentBytes).digest("hex"),
  };
}

// eslint-disable-next-line complexity -- Activation handles first-run, idempotent, and fenced successor writes.
export async function activateEnrichmentRun(options: {
  store: CheckpointObjectStore;
  runId: string;
  planSha256: string;
  activatedAt: string;
  expectedCurrentPlanSha256?: string;
}): Promise<ActiveEnrichmentRun> {
  const current = await resolveOptionalActiveRun(options.store);
  if (
    options.expectedCurrentPlanSha256 !== undefined &&
    current?.plan_sha256 !== options.expectedCurrentPlanSha256
  ) {
    throw new Error("active enrichment run changed before successor activation");
  }
  if (current?.plan_sha256 === options.planSha256 && current.run_id === options.runId) {
    return current;
  }
  const claim = activeRunSchema.parse({
    schema_version: 1,
    generation: (current?.generation ?? 0) + 1,
    run_id: options.runId,
    plan_sha256: options.planSha256,
    previous_plan_sha256: current?.plan_sha256 ?? null,
    activated_at: options.activatedAt,
  });
  await verifyPlan(options.store, claim);
  const bytes = canonicalPlanBytes(claim);
  await options.store.writeImmutable(activationKey(claim.generation), bytes);
  await options.store.writePointerHint(ACTIVE_POINTER_KEY, bytes);
  const stored = await requiredObject(options.store, activationKey(claim.generation));
  if (!Buffer.from(stored).equals(Buffer.from(bytes))) {
    throw new Error("enrichment run activation read-back mismatch");
  }
  return resolveActiveEnrichmentRun(options.store);
}

async function resolveOptionalActiveRun(
  store: CheckpointObjectStore,
): Promise<ActiveEnrichmentRun | null> {
  const keys = (await store.list(ACTIVATION_PREFIX)).filter((key) => CLAIM_KEY.test(key));
  return keys.length === 0 ? null : resolveActiveEnrichmentRun(store);
}

async function verifyPlan(
  store: CheckpointObjectStore,
  claim: Pick<ActiveEnrichmentRun, "run_id" | "plan_sha256">,
): Promise<void> {
  const value = await requiredObject(store, `${RUN_PREFIX}/${claim.run_id}/plan.json`);
  const parsed: unknown = JSON.parse(Buffer.from(value).toString("utf8"));
  const { plan } = parseEnrichmentRunPlan(parsed, claim.plan_sha256);
  if (plan.run_id !== claim.run_id) throw new Error("activated enrichment run plan ID mismatch");
}

function activationKey(generation: number): string {
  return `${ACTIVATION_PREFIX}/${String(generation).padStart(12, "0")}.json`;
}

async function requiredObject(store: CheckpointObjectStore, key: string): Promise<Uint8Array> {
  const value = await store.read(key);
  if (value === null) throw new Error(`required enrichment object is missing: ${key}`);
  return value;
}
