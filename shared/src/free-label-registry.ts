import { z } from "zod";

/**
 * Free labels live in an append-only registry that gates their public
 * visibility. The classifier response never carries a lifecycle state —
 * registry events do. Consumer APIs surface only `approved` labels;
 * `candidate` labels are visible only to administrators; `rejected` labels
 * are prevented from reappearing until an explicit re-open under a new
 * registry revision.
 */

export const freeLabelStatusSchema = z.enum(["candidate", "approved", "rejected"]);

export type FreeLabelStatus = z.infer<typeof freeLabelStatusSchema>;

/**
 * One registry lifecycle event committed alongside enrichment rows in
 * `enrichment/registry/YYYY/MM/registry-YYYY-MM-DD.jsonl`. Replay of these
 * events plus the current unit evidence rebuilds the SQLite projection.
 */
export const freeLabelEventSchema = z
  .object({
    name: z.string().min(1),
    status: freeLabelStatusSchema,
    at: z.string().min(1),
    contract_hash: z.string().min(1),
    registry_revision: z.number().int().min(1),
    /** Discovery/verification note or rejection rule identifier. */
    reason: z.string().optional(),
    /** Representative unit-quote pairs at the time of the transition. */
    quotes: z
      .array(
        z.object({
          unit_id: z.string().min(1),
          tweet_id: z.string().min(1),
          quote: z.string().min(1),
        }),
      )
      .default([]),
    /** Evidence totals that made this lifecycle decision reproducible. */
    counts: z
      .object({
        units: z.number().int().nonnegative(),
        authors: z.number().int().nonnegative(),
        days: z.number().int().nonnegative(),
      })
      .optional(),
    /** Author (admin username or "worker"); tests use "worker". */
    actor: z.string().min(1).default("worker"),
  })
  .strict();

export type FreeLabelEvent = z.infer<typeof freeLabelEventSchema>;

export type FreeLabelSummary = {
  name: string;
  status: FreeLabelStatus;
  unit_count: number;
  first_observed_at: string;
  updated_at: string;
  reason?: string;
};

export type FreeLabelRegistrySnapshot = {
  registry_revision: number;
  labels: readonly FreeLabelSummary[];
};

/**
 * A representative candidate row for the Admin UI. Includes the top authors
 * and a couple of representative quotes so a reviewer can sanity-check the
 * discovery before promotion.
 */
export type FreeLabelCandidateDetail = FreeLabelSummary & {
  distinct_authors: number;
  distinct_days: number;
  representative_quotes: readonly {
    unit_id: string;
    tweet_id: string;
    quote: string;
  }[];
};
