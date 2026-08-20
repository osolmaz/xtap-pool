import { createHash } from "node:crypto";

import { z } from "zod";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const objectReferenceSchema = z
  .object({
    key: z.string().min(1),
    sha256: z.string().regex(SHA256),
    bytes: z.number().int().positive(),
  })
  .strict();

const enrichmentRunPlanInputSchema = z
  .object({
    schema_version: z.literal(1),
    created_at: z.iso.datetime({ offset: true }),
    source: z
      .object({
        bucket: z.string().min(3),
        snapshot_revision: z.string().regex(SHA256),
        ordered_segments: objectReferenceSchema,
      })
      .strict(),
    contract: z
      .object({
        worker_revision: z.string().regex(/^[0-9a-f]{40,64}$/u),
        contract_sha256: z.string().regex(SHA256),
        taxonomy_version: z.number().int().positive(),
        model: z.string().min(1),
        provider: z.string().min(1),
      })
      .strict(),
    base_index: objectReferenceSchema.extend({
      source_revision: z.string().regex(SHA256),
      source_segment_count: z.number().int().nonnegative(),
      receipt_count: z.number().int().nonnegative(),
      registry_revision: z.number().int().nonnegative(),
    }),
    work: objectReferenceSchema.extend({
      queue_total: z.number().int().nonnegative(),
      queue_baseline_done: z.number().int().nonnegative(),
      registry_total: z.number().int().nonnegative(),
      registry_baseline_scanned: z.number().int().nonnegative(),
    }),
  })
  .strict();

export const enrichmentRunPlanSchema = enrichmentRunPlanInputSchema
  .extend({ run_id: z.string().regex(SAFE_ID) })
  .superRefine((plan, context) => {
    if (plan.work.queue_baseline_done > plan.work.queue_total) {
      context.addIssue({
        code: "custom",
        path: ["work", "queue_baseline_done"],
        message: "queue baseline cannot exceed total",
      });
    }
    if (plan.work.registry_baseline_scanned > plan.work.registry_total) {
      context.addIssue({
        code: "custom",
        path: ["work", "registry_baseline_scanned"],
        message: "registry baseline cannot exceed total",
      });
    }
  });

export type EnrichmentRunPlan = z.infer<typeof enrichmentRunPlanSchema>;
export type EnrichmentRunPlanInput = z.infer<typeof enrichmentRunPlanInputSchema>;

export function createEnrichmentRunPlan(input: EnrichmentRunPlanInput): {
  plan: EnrichmentRunPlan;
  sha256: string;
} {
  const parsedInput = enrichmentRunPlanInputSchema.parse(input);
  const sha256 = sha256Canonical(parsedInput);
  const plan = enrichmentRunPlanSchema.parse({
    ...parsedInput,
    run_id: `xtap-${sha256.slice(0, 32)}`,
  });
  return { plan, sha256 };
}

export function parseEnrichmentRunPlan(
  value: unknown,
  expectedSha256?: string,
): { plan: EnrichmentRunPlan; sha256: string } {
  const plan = enrichmentRunPlanSchema.parse(value);
  const { run_id: excludedRunId, ...identity } = plan;
  void excludedRunId;
  const sha256 = sha256Canonical(identity);
  if (plan.run_id !== `xtap-${sha256.slice(0, 32)}`) {
    throw new Error("enrichment run ID does not match the plan digest");
  }
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    throw new Error("enrichment run plan SHA-256 mismatch");
  }
  return { plan, sha256 };
}

export function canonicalPlanBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalPlanBytes(value)).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("plan numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(
      entries
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  throw new Error("plan must contain JSON values");
}
