import { z } from "zod";

import { durableIndexManifestSchema } from "./durable-index.js";

const SHA256 = /^[0-9a-f]{64}$/u;

const retryRecordSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    error_class: z.string().min(1),
    next_retry_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

const blockedRecordSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    attempts: z.number().int().positive(),
    reason: z.string().min(1),
    evidence_sha256: z.string().regex(SHA256),
  })
  .strict();

const outputFrontierSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    chain_sha256: z.string().regex(SHA256).nullable(),
  })
  .strict()
  .superRefine((frontier, context) => {
    if ((frontier.sequence === 0) !== (frontier.chain_sha256 === null)) {
      context.addIssue({
        code: "custom",
        message: "an empty output frontier must have sequence 0 and null chain hash",
      });
    }
  });

export const enrichmentCheckpointMetadataSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string().min(1),
    plan_sha256: z.string().regex(SHA256),
    sequence: z.number().int().nonnegative(),
    queue: z
      .object({
        total: z.number().int().nonnegative(),
        done: z.number().int().nonnegative(),
        retrying: z.array(retryRecordSchema),
        blocked: z.array(blockedRecordSchema),
      })
      .strict(),
    registry: z
      .object({
        total: z.number().int().nonnegative(),
        next_ordinal: z.number().int().nonnegative(),
        approved: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
      })
      .strict(),
    outputs: z
      .object({
        enrichment: outputFrontierSchema,
        attempt: outputFrontierSchema,
        registry: outputFrontierSchema,
        receipt: outputFrontierSchema,
      })
      .strict(),
    publication: z
      .object({
        state: z.enum(["pending", "building", "uploaded", "verified", "published"]),
        database_key: z.string().min(1).nullable(),
        database_sha256: z.string().regex(SHA256).nullable(),
        database_bytes: z.number().int().positive().nullable(),
        manifest: durableIndexManifestSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export type EnrichmentCheckpointMetadata = z.infer<typeof enrichmentCheckpointMetadataSchema>;
export type RetryRecord = z.infer<typeof retryRecordSchema>;
export type BlockedRecord = z.infer<typeof blockedRecordSchema>;
export type OutputKind = keyof EnrichmentCheckpointMetadata["outputs"];
export type EnrichmentCheckpointState = EnrichmentCheckpointMetadata & {
  completed_bitmap: Uint8Array;
};

export function createEmptyEnrichmentState(options: {
  runId: string;
  planSha256: string;
  queueTotal: number;
  queueBaselineDone: number;
  registryTotal: number;
  registryBaselineScanned: number;
}): EnrichmentCheckpointState {
  requireCount(options.queueTotal, "queueTotal");
  requireCount(options.queueBaselineDone, "queueBaselineDone");
  requireCount(options.registryTotal, "registryTotal");
  requireCount(options.registryBaselineScanned, "registryBaselineScanned");
  if (options.queueBaselineDone > options.queueTotal) {
    throw new Error("queue baseline cannot exceed total");
  }
  if (options.registryBaselineScanned > options.registryTotal) {
    throw new Error("registry baseline cannot exceed total");
  }
  const bitmap = new Uint8Array(bitmapBytes(options.queueTotal));
  for (let ordinal = 0; ordinal < options.queueBaselineDone; ordinal += 1) {
    setCompleted(bitmap, ordinal);
  }
  return validateEnrichmentState({
    schema_version: 1,
    run_id: options.runId,
    plan_sha256: options.planSha256,
    sequence: 0,
    completed_bitmap: bitmap,
    queue: {
      total: options.queueTotal,
      done: options.queueBaselineDone,
      retrying: [],
      blocked: [],
    },
    registry: {
      total: options.registryTotal,
      next_ordinal: options.registryBaselineScanned,
      approved: 0,
      rejected: 0,
    },
    outputs: {
      enrichment: { sequence: 0, chain_sha256: null },
      attempt: { sequence: 0, chain_sha256: null },
      registry: { sequence: 0, chain_sha256: null },
      receipt: { sequence: 0, chain_sha256: null },
    },
    publication: {
      state: "pending",
      database_key: null,
      database_sha256: null,
      database_bytes: null,
      manifest: null,
    },
  });
}

// eslint-disable-next-line complexity -- State validation checks each independent durable invariant.
export function validateEnrichmentState(value: {
  schema_version: 1;
  run_id: string;
  plan_sha256: string;
  sequence: number;
  completed_bitmap: Uint8Array;
  queue: EnrichmentCheckpointMetadata["queue"];
  registry: EnrichmentCheckpointMetadata["registry"];
  outputs: EnrichmentCheckpointMetadata["outputs"];
  publication: EnrichmentCheckpointMetadata["publication"];
}): EnrichmentCheckpointState {
  const { completed_bitmap: bitmapValue, ...metadataValue } = value;
  const metadata = enrichmentCheckpointMetadataSchema.parse(metadataValue);
  const bitmap = Uint8Array.from(bitmapValue);
  if (bitmap.byteLength !== bitmapBytes(metadata.queue.total)) {
    throw new Error("queue completion bitmap length mismatch");
  }
  const completed = countCompleted(bitmap, metadata.queue.total);
  if (completed !== metadata.queue.done) {
    throw new Error("queue completion bitmap count mismatch");
  }
  const unresolvedOrdinals = new Set<number>();
  for (const retry of metadata.queue.retrying) {
    requireOrdinal(retry.ordinal, metadata.queue.total, "retry ordinal");
    if (isCompleted(bitmap, retry.ordinal)) {
      throw new Error("completed queue ordinal cannot remain retrying");
    }
    if (unresolvedOrdinals.has(retry.ordinal)) {
      throw new Error("retry ordinals must be unique");
    }
    unresolvedOrdinals.add(retry.ordinal);
  }
  for (const blocked of metadata.queue.blocked) {
    requireOrdinal(blocked.ordinal, metadata.queue.total, "blocked ordinal");
    if (isCompleted(bitmap, blocked.ordinal)) {
      throw new Error("completed queue ordinal cannot remain blocked");
    }
    if (unresolvedOrdinals.has(blocked.ordinal)) {
      throw new Error("blocked ordinals must be unique and disjoint from retries");
    }
    unresolvedOrdinals.add(blocked.ordinal);
  }
  if (metadata.registry.next_ordinal > metadata.registry.total) {
    throw new Error("registry cursor exceeds total");
  }
  const publication = metadata.publication;
  const hasDatabase =
    publication.database_key !== null &&
    publication.database_sha256 !== null &&
    publication.database_bytes !== null &&
    publication.manifest !== null;
  if (["uploaded", "verified", "published"].includes(publication.state) !== hasDatabase) {
    throw new Error("publication database reference does not match publication state");
  }
  return { ...metadata, completed_bitmap: bitmap };
}

export function markQueueCompleted(
  state: EnrichmentCheckpointState,
  ordinals: readonly number[],
): EnrichmentCheckpointState {
  const bitmap = Uint8Array.from(state.completed_bitmap);
  let done = state.queue.done;
  for (const ordinal of ordinals) {
    requireOrdinal(ordinal, state.queue.total, "queue ordinal");
    if (isCompleted(bitmap, ordinal)) continue;
    setCompleted(bitmap, ordinal);
    done += 1;
  }
  const completed = new Set(ordinals);
  return validateEnrichmentState({
    ...state,
    sequence: state.sequence,
    completed_bitmap: bitmap,
    queue: {
      ...state.queue,
      done,
      retrying: state.queue.retrying.filter((record) => !completed.has(record.ordinal)),
      blocked: state.queue.blocked.filter((record) => !completed.has(record.ordinal)),
    },
  });
}

export function recordQueueAttempt(
  state: EnrichmentCheckpointState,
  record: { status: "retrying"; value: RetryRecord } | { status: "blocked"; value: BlockedRecord },
): EnrichmentCheckpointState {
  requireOrdinal(record.value.ordinal, state.queue.total, "queue ordinal");
  if (isCompleted(state.completed_bitmap, record.value.ordinal)) {
    throw new Error("completed queue ordinal cannot receive another attempt");
  }
  return validateEnrichmentState({
    ...state,
    completed_bitmap: state.completed_bitmap,
    queue: {
      ...state.queue,
      retrying:
        record.status === "retrying"
          ? replaceOrdinal(state.queue.retrying, record.value)
          : state.queue.retrying.filter((item) => item.ordinal !== record.value.ordinal),
      blocked:
        record.status === "blocked"
          ? replaceOrdinal(state.queue.blocked, record.value)
          : state.queue.blocked.filter((item) => item.ordinal !== record.value.ordinal),
    },
  });
}

export function advanceRegistryCursor(
  state: EnrichmentCheckpointState,
  decisions: readonly ("candidate" | "approved" | "rejected")[],
): EnrichmentCheckpointState {
  const next = state.registry.next_ordinal + decisions.length;
  if (next > state.registry.total) throw new Error("registry decisions exceed frozen plan");
  return validateEnrichmentState({
    ...state,
    completed_bitmap: state.completed_bitmap,
    registry: {
      ...state.registry,
      next_ordinal: next,
      approved: state.registry.approved + decisions.filter((value) => value === "approved").length,
      rejected: state.registry.rejected + decisions.filter((value) => value === "rejected").length,
    },
  });
}

export function setPublicationState(
  state: EnrichmentCheckpointState,
  publication: EnrichmentCheckpointMetadata["publication"],
): EnrichmentCheckpointState {
  return validateEnrichmentState({
    ...state,
    completed_bitmap: state.completed_bitmap,
    publication,
  });
}

export function advanceOutputFrontier(
  state: EnrichmentCheckpointState,
  kind: OutputKind,
  chainSha256: string,
): EnrichmentCheckpointState {
  if (!SHA256.test(chainSha256)) throw new Error("output chain SHA-256 is invalid");
  const current = state.outputs[kind];
  return validateEnrichmentState({
    ...state,
    sequence: state.sequence,
    completed_bitmap: state.completed_bitmap,
    outputs: {
      ...state.outputs,
      [kind]: { sequence: current.sequence + 1, chain_sha256: chainSha256 },
    },
  });
}

export function withCheckpointSequence(
  state: EnrichmentCheckpointState,
  sequence: number,
): EnrichmentCheckpointState {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("checkpoint sequence must be a nonnegative safe integer");
  }
  return validateEnrichmentState({
    ...state,
    sequence,
    completed_bitmap: state.completed_bitmap,
  });
}

export function serializeEnrichmentMetadata(
  state: EnrichmentCheckpointState,
): EnrichmentCheckpointMetadata {
  const { completed_bitmap: excludedBitmap, ...metadata } = state;
  void excludedBitmap;
  return enrichmentCheckpointMetadataSchema.parse(metadata);
}

export function isCompleted(bitmap: Uint8Array, ordinal: number): boolean {
  const byte = bitmap[Math.floor(ordinal / 8)] ?? 0;
  return (byte & (1 << (ordinal % 8))) !== 0;
}

function setCompleted(bitmap: Uint8Array, ordinal: number): void {
  const index = Math.floor(ordinal / 8);
  const value = bitmap[index] ?? 0;
  bitmap[index] = value | (1 << (ordinal % 8));
}

function replaceOrdinal<T extends { ordinal: number }>(records: readonly T[], value: T): T[] {
  return [...records.filter((record) => record.ordinal !== value.ordinal), value].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
}

function countCompleted(bitmap: Uint8Array, total: number): number {
  let completed = 0;
  for (let ordinal = 0; ordinal < total; ordinal += 1) {
    if (isCompleted(bitmap, ordinal)) completed += 1;
  }
  return completed;
}

function bitmapBytes(total: number): number {
  return Math.ceil(total / 8);
}

function requireOrdinal(value: number, total: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= total) {
    throw new Error(`${name} is outside the frozen plan`);
  }
}

function requireCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
}
