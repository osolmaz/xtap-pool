import { createHash } from "node:crypto";

import type { CheckpointObjectStore } from "@osolmaz/hf-job-control";
import { z } from "zod";

import { canonicalPlanBytes } from "./enrich-run-plan.js";

const SHA256 = /^[0-9a-f]{64}$/u;

export const enrichmentBatchResultSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string().min(1),
    phase: z.enum(["queue", "attempt", "registry", "receipt"]),
    sequence: z.number().int().positive(),
    previous_result_sha256: z.string().regex(SHA256).nullable(),
    ordinals: z.array(z.number().int().nonnegative()),
    raw_segment_key: z.string().min(1),
    raw_segment_sha256: z.string().regex(SHA256),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((result, context) => {
    const sorted = [...result.ordinals].sort((left, right) => left - right);
    if (
      sorted.some((ordinal, index) => ordinal !== result.ordinals[index]) ||
      new Set(sorted).size !== sorted.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["ordinals"],
        message: "batch ordinals must be sorted and unique",
      });
    }
  });

export type EnrichmentBatchResult = z.infer<typeof enrichmentBatchResultSchema>;

export function enrichmentBatchIdentity(options: {
  runId: string;
  phase: EnrichmentBatchResult["phase"];
  sequence: number;
}): string {
  if (!Number.isSafeInteger(options.sequence) || options.sequence < 1) {
    throw new Error("batch sequence must be a positive safe integer");
  }
  return `${options.runId}:${options.phase}:${String(options.sequence)}`;
}

export function enrichmentBatchResultKey(
  prefix: string,
  result: Pick<EnrichmentBatchResult, "run_id" | "phase" | "sequence">,
): string {
  const normalized = prefix.replace(/^\/+|\/+$/gu, "");
  const suffix = `${result.run_id}/batches/${result.phase}/${String(result.sequence).padStart(16, "0")}/result.json`;
  return normalized.length === 0 ? suffix : `${normalized}/${suffix}`;
}

export async function publishEnrichmentBatchResult(options: {
  store: CheckpointObjectStore;
  prefix: string;
  value: EnrichmentBatchResult;
}): Promise<{ result: EnrichmentBatchResult; bytes: Uint8Array; sha256: string }> {
  const created = createEnrichmentBatchResult(options.value);
  const key = enrichmentBatchResultKey(options.prefix, created.result);
  await options.store.writeImmutable(key, created.bytes);
  const stored = await options.store.read(key);
  if (stored === null || !Buffer.from(stored).equals(Buffer.from(created.bytes))) {
    throw new Error("enrichment batch result read-back mismatch");
  }
  return created;
}

export function createEnrichmentBatchResult(value: EnrichmentBatchResult): {
  result: EnrichmentBatchResult;
  bytes: Uint8Array;
  sha256: string;
} {
  const result = enrichmentBatchResultSchema.parse(value);
  const bytes = canonicalPlanBytes(result);
  return {
    result,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
