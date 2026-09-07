import { z } from "zod";
import { consumerContextSchema } from "./consumer-context.js";
import { bucketSnapshotSchema } from "./bucket-log.js";
import { observationPositionSchema, consumerCursorSchema } from "./consumer-cursor.js";
import { consumerStepSchema } from "./consumer-page.js";
import { consumerObservationSchema } from "./consumer-observations.js";

import { reconciliationPageSchema } from "./consumer-privacy.js";

const resolved = z.object({
  id: z.string(),
  context: consumerContextSchema,
  snapshot: bucketSnapshotSchema,
});
export const consumerWorkerTaskSchema = z.object({
  path: z.string(),
  identity: z.string(),
  source: z.string(),
  contract: z.string(),
  target: resolved,
  base: resolved.optional(),
  privacy: resolved.optional(),
  reconciliation: resolved.optional(),
  cursor: consumerCursorSchema,
  limit: z.number().int().min(1).max(500),
  operation: z.enum(["coverage", "page", "privacy", "reconcile"]),
});
export type ConsumerWorkerTask = z.infer<typeof consumerWorkerTaskSchema>;
export const observationPageSchema = z.object({
  observations: z.array(consumerObservationSchema),
  coverage: z.array(
    z.object({
      post_id: z.string(),
      state: z.enum(["available", "no_history", "unavailable"]),
      count: z.number().nullable(),
      earliest: z.string().nullable(),
      latest: z.string().nullable(),
    }),
  ),
  next: observationPositionSchema.optional(),
});
export const workerResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("privacy") }),
  z.object({ kind: z.literal("reconcile"), page: reconciliationPageSchema }),
  z.object({
    kind: z.literal("coverage"),
    mode: z.enum(["reuse", "metrics", "semantic"]),
    completeThrough: z.string().nullable(),
    observationsThrough: z.string().nullable(),
  }),
  z.object({ kind: z.literal("changes"), step: consumerStepSchema }),
  z.object({ kind: z.literal("history"), page: observationPageSchema }),
]);
export type ConsumerWorkerResult = z.infer<typeof workerResultSchema>;
