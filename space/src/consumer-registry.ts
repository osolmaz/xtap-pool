import { z } from "zod";
import type { EnrichStore } from "./enrich-store.js";

export const consumerRegistrySchema = z
  .object({
    revision: z.number().int().min(1),
    approved: z
      .array(
        z
          .object({
            name: z.string().min(1),
            first_observed_at: z.iso.datetime({ offset: true }),
            updated_at: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.approved.map((label) => label.name)).size !== value.approved.length)
      context.addIssue({
        code: "custom",
        path: ["approved"],
        message: "approved names must be unique",
      });
  });
export type ConsumerRegistry = z.infer<typeof consumerRegistrySchema>;

/** Capture inside the same indexed-source transaction as the boundary metadata.
 * Raw registry events are not proof of approval: rejected/stale events also exist. */
export function consumerRegistry(enrich: EnrichStore): ConsumerRegistry {
  return consumerRegistrySchema.parse({
    revision: enrich.registryRevision(),
    approved: enrich
      .registrySnapshot()
      .filter((label) => label.status === "approved")
      .map(({ name, first_observed_at, updated_at }) => ({ name, first_observed_at, updated_at }))
      .sort((a, b) => compare(a.name, b.name)),
  });
}

export function changedApprovals(before: ConsumerRegistry, after: ConsumerRegistry): string[] {
  const old = new Set(before.approved.map((label) => label.name));
  const next = new Set(after.approved.map((label) => label.name));
  return [...new Set([...old, ...next])]
    .filter((name) => old.has(name) !== next.has(name))
    .sort(compare);
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
