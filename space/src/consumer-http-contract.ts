import { z } from "zod";
import { consumerChangeSchema } from "./consumer-page.js";
import { observationPageSchema } from "./consumer-worker-task.js";

const bounds = {
  schema_version: z.literal(1),
  source: z.string().regex(/^[a-f0-9]{64}$/u),
  history_since: z.iso.datetime(),
  history_until: z.iso.datetime(),
  has_more: z.boolean(),
};
export const consumerChangesEnvelopeSchema = z
  .object({
    ...bounds,
    complete_through: z.iso.datetime().nullable(),
    observations_through: z.iso.datetime().nullable(),
    cursor: z.string(),
    changes: z.array(consumerChangeSchema).max(500),
  })
  .strict();
export const consumerHistoryEnvelopeSchema = z
  .object({
    ...bounds,
    observations: observationPageSchema.shape.observations,
    coverage: observationPageSchema.shape.coverage,
    next_cursor: z.string().nullable(),
  })
  .strict();
