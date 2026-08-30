import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  checkpointClaimKey,
  checkpointClaimPrefix,
  checkpointPointerKey,
  parseCheckpointClaim,
  parseCheckpointPointer,
  verifyCheckpointBundle,
  type CheckpointClaim,
  type CheckpointObjectStore,
  type CheckpointReference,
  type RestoreResult,
} from "@osolmaz/hf-job-control";
import {
  canonicalJson,
  deploymentManifestSchema,
  enrichmentRevisionHandoffSchema,
  type DeploymentManifest,
  type EnrichmentRevisionHandoff,
} from "@xtap-pool/shared";

import {
  resolveActiveEnrichmentRunEvidence,
  type ActiveEnrichmentRunEvidence,
} from "./enrich-active-run.js";
import {
  EnrichmentCheckpointAdapter,
  type EnrichmentRestoreEvidence,
} from "./enrich-checkpoint.js";
import { parseEnrichmentRunPlan, type EnrichmentRunPlan } from "./enrich-run-plan.js";
import { createEmptyEnrichmentState } from "./enrich-state.js";

const RUN_PREFIX = "operations/enrichment/runs";
const ACTIVATION_PREFIX = `${RUN_PREFIX}/activations`;
const GIT_REVISION = /^[0-9a-f]{40}$/u;

export type PreparedEnrichmentRevision = {
  active: ActiveEnrichmentRunEvidence;
  plan: EnrichmentRunPlan;
  handoff: EnrichmentRevisionHandoff | null;
  checkpointPointerBytes: Uint8Array;
  checkpoint: RestoreResult<EnrichmentRestoreEvidence>;
  adapter: EnrichmentCheckpointAdapter;
};

export async function prepareOptionalEnrichmentRevision(options: {
  store: CheckpointObjectStore;
  targetWorkerRevision: string;
}): Promise<PreparedEnrichmentRevision | null> {
  requireTargetRevision(options.targetWorkerRevision);
  const activationKeys = await options.store.list(ACTIVATION_PREFIX);
  if (activationKeys.length === 0) return null;
  return prepareEnrichmentRevision(options);
}

export async function prepareOptionalEnrichmentRevisionHandoff(options: {
  store: CheckpointObjectStore;
  targetWorkerRevision: string;
}): Promise<EnrichmentRevisionHandoff | null> {
  return (await prepareOptionalEnrichmentRevision(options))?.handoff ?? null;
}

export async function prepareEnrichmentRevision(options: {
  store: CheckpointObjectStore;
  targetWorkerRevision: string;
}): Promise<PreparedEnrichmentRevision> {
  requireTargetRevision(options.targetWorkerRevision);
  const active = await resolveActiveEnrichmentRunEvidence(options.store);
  const runId = active.activeRun.run_id;
  const planSha256 = active.activeRun.plan_sha256;
  const planBytes = await requiredObject(options.store, `${RUN_PREFIX}/${runId}/plan.json`);
  const parsedPlan: unknown = JSON.parse(Buffer.from(planBytes).toString("utf8"));
  const { plan } = parseEnrichmentRunPlan(parsedPlan, planSha256);
  if (plan.run_id !== runId) throw new Error("active enrichment run ID mismatch");

  const pointerKey = checkpointPointerKey(RUN_PREFIX, runId);
  const pointerBytes = await requiredObject(options.store, pointerKey);
  const pointer = parseCheckpointPointer(
    JSON.parse(Buffer.from(pointerBytes).toString("utf8")) as unknown,
  );
  if (
    pointer.run_id !== runId ||
    pointer.plan_sha256 !== planSha256 ||
    pointer.checkpoint.bucket !== options.store.bucketId
  ) {
    throw new Error("enrichment checkpoint pointer identity mismatch");
  }

  const adapter = new EnrichmentCheckpointAdapter(
    createEmptyEnrichmentState({
      runId,
      planSha256,
      queueTotal: plan.work.queue_total,
      queueBaselineDone: plan.work.queue_baseline_done,
      registryTotal: plan.work.registry_total,
      registryBaselineScanned: plan.work.registry_baseline_scanned,
    }),
  );
  const checkpoint = await restoreLatestCheckpointReadOnly(
    options.store,
    runId,
    planSha256,
    adapter,
  );
  if (
    pointer.sequence !== checkpoint.manifest.boundary.sequence ||
    !sameCheckpointReference(pointer.checkpoint, checkpoint.checkpoint)
  ) {
    throw new Error("enrichment checkpoint pointer does not match the verified chain head");
  }

  const handoff =
    plan.contract.worker_revision === options.targetWorkerRevision
      ? null
      : enrichmentRevisionHandoffSchema.parse({
          active_generation: active.activeRun.generation,
          activation_sha256: active.sha256,
          run_id: runId,
          plan_sha256: planSha256,
          plan_worker_revision: plan.contract.worker_revision,
          target_worker_revision: options.targetWorkerRevision,
          contract_sha256: plan.contract.contract_sha256,
          source_snapshot_revision: plan.source.snapshot_revision,
          checkpoint_pointer_sha256: sha256(pointerBytes),
          checkpoint_sequence: checkpoint.manifest.boundary.sequence,
          checkpoint_key: checkpoint.checkpoint.key,
          checkpoint_sha256: checkpoint.checkpoint.sha256,
          checkpoint_bytes: checkpoint.checkpoint.bytes,
        });
  return {
    active,
    plan,
    handoff,
    checkpointPointerBytes: Uint8Array.from(pointerBytes),
    checkpoint,
    adapter,
  };
}

export async function verifyPreparedEnrichmentRevision(
  manifestValue: unknown,
  prepared: PreparedEnrichmentRevision,
  targetWorkerRevision: string,
  store: CheckpointObjectStore,
): Promise<DeploymentManifest> {
  requireTargetRevision(targetWorkerRevision);
  const manifest = deploymentManifestSchema.parse(manifestValue);
  if (manifest.source_revision !== targetWorkerRevision) {
    throw new Error("deployment manifest source does not match the running worker revision");
  }
  if (canonicalJson(manifest.enrichment_revision_handoff) === canonicalJson(prepared.handoff)) {
    return manifest;
  }
  const handoff = manifest.enrichment_revision_handoff;
  if (await acceptsAdvancedHandoff(store, prepared, handoff)) return manifest;
  if (await acceptsCompletedHandoff(store, prepared, handoff, targetWorkerRevision)) {
    return manifest;
  }
  throw new Error(
    "deployment revision handoff does not match the active plan and checkpoint chain",
  );
}

async function acceptsAdvancedHandoff(
  store: CheckpointObjectStore,
  prepared: PreparedEnrichmentRevision,
  handoff: EnrichmentRevisionHandoff | null,
): Promise<boolean> {
  if (handoff === null || prepared.handoff === null) return false;
  if (!sameHandoffPlanIdentity(handoff, prepared.handoff)) return false;
  const currentSequence = prepared.checkpoint.manifest.boundary.sequence;
  if (handoff.checkpoint_sequence > currentSequence) return false;
  if (
    handoff.checkpoint_sequence === currentSequence &&
    !sameHandoffCheckpointReference(handoff, prepared.checkpoint.checkpoint)
  ) {
    return false;
  }
  await verifyRevisionHandoffAnchor(store, handoff);
  return true;
}

async function acceptsCompletedHandoff(
  store: CheckpointObjectStore,
  prepared: PreparedEnrichmentRevision,
  handoff: EnrichmentRevisionHandoff | null,
  targetWorkerRevision: string,
): Promise<boolean> {
  if (handoff === null || prepared.handoff !== null) return false;
  if (prepared.plan.contract.worker_revision !== targetWorkerRevision) return false;
  if (handoff.active_generation >= prepared.active.activeRun.generation) return false;
  await verifyRevisionHandoffAnchor(store, handoff);
  return true;
}

// eslint-disable-next-line complexity -- Read-only restore verifies every claim, chain, object, and adapter identity without repair writes.
async function restoreLatestCheckpointReadOnly(
  store: CheckpointObjectStore,
  runId: string,
  planSha256: string,
  adapter: EnrichmentCheckpointAdapter,
): Promise<RestoreResult<EnrichmentRestoreEvidence>> {
  const claimPrefix = checkpointClaimPrefix(RUN_PREFIX, runId);
  const claimKeys = (await store.list(claimPrefix)).filter((key) =>
    /\/checkpoints\/claims\/sequence-\d{16}\/[^/]+\.json$/u.test(`/${key}`),
  );
  const claims: CheckpointClaim[] = [];
  for (const key of claimKeys) {
    const bytes = await requiredObject(store, key);
    const claim = parseCheckpointClaim(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (claim.run_id !== runId || claim.plan_sha256 !== planSha256) {
      throw new Error("checkpoint claim identity mismatch");
    }
    if (checkpointClaimKey(RUN_PREFIX, claim) !== key) {
      throw new Error(`checkpoint claim path mismatch: ${key}`);
    }
    claims.push(claim);
  }
  const bySequence = new Map<number, CheckpointClaim[]>();
  for (const claim of claims) {
    const values = bySequence.get(claim.sequence) ?? [];
    values.push(claim);
    bySequence.set(claim.sequence, values);
  }
  const sequences = [...bySequence.keys()].sort((left, right) => left - right);
  if (sequences.length === 0) throw new Error("planned enrichment has no bootstrap checkpoint");
  let previousSha256: string | null = null;
  let head: CheckpointClaim | null = null;
  for (const [index, sequence] of sequences.entries()) {
    if (sequence !== index + 1) throw new Error("checkpoint claim sequence gap");
    const candidates = bySequence.get(sequence) ?? [];
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("checkpoint claim sequence is empty");
    if (
      candidates.some(
        (value) =>
          !sameCheckpointReference(value.checkpoint, candidate.checkpoint) ||
          value.previous_checkpoint_sha256 !== previousSha256,
      )
    ) {
      throw new Error(`conflicting checkpoint claims at sequence ${String(sequence)}`);
    }
    if (candidate.previous_checkpoint_sha256 !== previousSha256) {
      throw new Error("checkpoint predecessor claim mismatch");
    }
    head = candidate;
    previousSha256 = candidate.checkpoint.sha256;
  }
  if (head === null) throw new Error("planned enrichment has no bootstrap checkpoint");
  const checkpointBytes = await readCheckpointReference(store, head.checkpoint);
  const verified = verifyCheckpointBundle(checkpointBytes);
  if (
    verified.manifest.run_id !== runId ||
    verified.manifest.plan_sha256 !== planSha256 ||
    verified.manifest.boundary.sequence !== head.sequence ||
    verified.manifest.previous_checkpoint_sha256 !== head.previous_checkpoint_sha256 ||
    verified.manifest.adapter.name !== adapter.spec.name ||
    verified.manifest.adapter.version !== adapter.spec.version ||
    verified.manifest.adapter.resume_mode !== adapter.spec.resume_mode
  ) {
    throw new Error("checkpoint manifest identity mismatch");
  }
  const evidence = await adapter.restore(verified.manifest, verified.payloads);
  return { checkpoint: head.checkpoint, manifest: verified.manifest, evidence };
}

function sameHandoffCheckpointReference(
  handoff: EnrichmentRevisionHandoff,
  checkpoint: CheckpointReference,
): boolean {
  return (
    handoff.checkpoint_key === checkpoint.key &&
    handoff.checkpoint_sha256 === checkpoint.sha256 &&
    handoff.checkpoint_bytes === checkpoint.bytes
  );
}

function sameHandoffPlanIdentity(
  anchor: EnrichmentRevisionHandoff,
  current: EnrichmentRevisionHandoff,
): boolean {
  return (
    anchor.active_generation === current.active_generation &&
    anchor.activation_sha256 === current.activation_sha256 &&
    anchor.run_id === current.run_id &&
    anchor.plan_sha256 === current.plan_sha256 &&
    anchor.plan_worker_revision === current.plan_worker_revision &&
    anchor.target_worker_revision === current.target_worker_revision &&
    anchor.contract_sha256 === current.contract_sha256 &&
    anchor.source_snapshot_revision === current.source_snapshot_revision
  );
}

// eslint-disable-next-line complexity -- Handoff verification checks every immutable historical identity at the reviewed checkpoint anchor.
async function verifyRevisionHandoffAnchor(
  store: CheckpointObjectStore,
  handoff: EnrichmentRevisionHandoff,
): Promise<void> {
  const activationKey = `${ACTIVATION_PREFIX}/${String(handoff.active_generation).padStart(12, "0")}.json`;
  const activationBytes = await requiredObject(store, activationKey);
  if (sha256(activationBytes) !== handoff.activation_sha256) {
    throw new Error("completed revision handoff activation digest mismatch");
  }
  const activation = JSON.parse(Buffer.from(activationBytes).toString("utf8")) as {
    generation?: unknown;
    run_id?: unknown;
    plan_sha256?: unknown;
  };
  if (
    activation.generation !== handoff.active_generation ||
    activation.run_id !== handoff.run_id ||
    activation.plan_sha256 !== handoff.plan_sha256
  ) {
    throw new Error("completed revision handoff activation identity mismatch");
  }
  const planBytes = await requiredObject(store, `${RUN_PREFIX}/${handoff.run_id}/plan.json`);
  const parsedPlan: unknown = JSON.parse(Buffer.from(planBytes).toString("utf8"));
  const { plan } = parseEnrichmentRunPlan(parsedPlan, handoff.plan_sha256);
  if (
    plan.contract.worker_revision !== handoff.plan_worker_revision ||
    plan.contract.contract_sha256 !== handoff.contract_sha256 ||
    plan.source.snapshot_revision !== handoff.source_snapshot_revision
  ) {
    throw new Error("completed revision handoff plan identity mismatch");
  }
  const claimPrefix = checkpointClaimPrefix(RUN_PREFIX, handoff.run_id);
  const sequencePath = `/sequence-${String(handoff.checkpoint_sequence).padStart(16, "0")}/`;
  const claimKeys = (await store.list(claimPrefix)).filter((key) =>
    `/${key}`.includes(sequencePath),
  );
  if (claimKeys.length === 0) {
    throw new Error("completed revision handoff checkpoint claim is missing");
  }
  let previousCheckpointSha256: string | null | undefined;
  for (const key of claimKeys) {
    const claimBytes = await requiredObject(store, key);
    const claim = parseCheckpointClaim(JSON.parse(Buffer.from(claimBytes).toString("utf8")));
    if (
      claim.run_id !== handoff.run_id ||
      claim.plan_sha256 !== handoff.plan_sha256 ||
      claim.sequence !== handoff.checkpoint_sequence ||
      claim.checkpoint.key !== handoff.checkpoint_key ||
      claim.checkpoint.sha256 !== handoff.checkpoint_sha256 ||
      claim.checkpoint.bytes !== handoff.checkpoint_bytes ||
      claim.checkpoint.bucket !== store.bucketId
    ) {
      throw new Error("completed revision handoff checkpoint claim identity mismatch");
    }
    if (previousCheckpointSha256 === undefined) {
      previousCheckpointSha256 = claim.previous_checkpoint_sha256;
    } else if (claim.previous_checkpoint_sha256 !== previousCheckpointSha256) {
      throw new Error("completed revision handoff checkpoint predecessor mismatch");
    }
  }
  const checkpointBytes = await requiredObject(store, handoff.checkpoint_key);
  if (
    checkpointBytes.byteLength !== handoff.checkpoint_bytes ||
    sha256(checkpointBytes) !== handoff.checkpoint_sha256
  ) {
    throw new Error("completed revision handoff checkpoint object mismatch");
  }
  const bundle = verifyCheckpointBundle(checkpointBytes);
  if (
    bundle.manifest.run_id !== handoff.run_id ||
    bundle.manifest.plan_sha256 !== handoff.plan_sha256 ||
    bundle.manifest.boundary.sequence !== handoff.checkpoint_sequence ||
    bundle.manifest.previous_checkpoint_sha256 !== previousCheckpointSha256
  ) {
    throw new Error("completed revision handoff checkpoint bundle identity mismatch");
  }
}

function requireTargetRevision(value: string): void {
  if (!GIT_REVISION.test(value)) {
    throw new Error("target worker revision must be a 40-character lowercase Git SHA");
  }
}

async function readCheckpointReference(
  store: CheckpointObjectStore,
  reference: CheckpointReference,
): Promise<Uint8Array> {
  if (reference.bucket !== store.bucketId) throw new Error("checkpoint bucket mismatch");
  const bytes = await requiredObject(store, reference.key);
  if (bytes.byteLength !== reference.bytes) {
    throw new Error("checkpoint object byte count mismatch");
  }
  if (sha256(bytes) !== reference.sha256) {
    throw new Error("checkpoint object SHA-256 mismatch");
  }
  return bytes;
}

function sameCheckpointReference(
  left: { bucket: string; key: string; sha256: string; bytes: number },
  right: { bucket: string; key: string; sha256: string; bytes: number },
): boolean {
  return (
    left.bucket === right.bucket &&
    left.key === right.key &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes
  );
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function requiredObject(store: CheckpointObjectStore, key: string): Promise<Uint8Array> {
  const value = await store.read(key);
  if (value === null) throw new Error(`required enrichment object is missing: ${key}`);
  return value;
}
