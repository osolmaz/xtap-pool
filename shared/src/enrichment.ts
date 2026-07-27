import { z } from "zod";

import { dayKey } from "./tweet.js";
import type { Tweet } from "./tweet.js";

/** One preset taxonomy entry; the description steers the classifier. */
export const labelConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
});

export type LabelConfig = z.infer<typeof labelConfigSchema>;

/**
 * One piece of textual grounding for a label: the tweet the label was drawn
 * from, plus the exact quote copied out of that tweet's text. The worker
 * rejects any assignment whose quote is not a verbatim substring of the
 * named tweet.
 */
export const evidenceSchema = z
  .object({
    tweet_id: z.string().min(1),
    quote: z.string().min(1),
  })
  .strict();

export type Evidence = z.infer<typeof evidenceSchema>;

/** One label assignment with at least one evidence record. */
export const labelAssignmentSchema = z
  .object({
    name: z.string().min(1),
    evidence: z.array(evidenceSchema).min(1),
  })
  .strict();

export type LabelAssignment = z.infer<typeof labelAssignmentSchema>;

/**
 * One enrichment result for a conversation-author unit, as appended to
 * `enrichment/YYYY/MM/enrichment-YYYY-MM-DD.jsonl` in the pool dataset.
 *
 * A current row has exactly the two evidence-bearing output arrays. Historical
 * output contracts are not parsed into this type and never enter projections.
 */
export const enrichmentRowSchema = z
  .object({
    unit_id: z.string().min(1),
    tweet_ids: z
      .array(z.string().min(1))
      .min(1)
      .refine((tweetIds) => new Set(tweetIds).size === tweetIds.length, {
        message: "tweet_ids must be unique",
      }),
    input_hash: z.string().min(1),
    contract_hash: z.string().min(1),
    preset_labels: z.array(labelAssignmentSchema),
    free_labels: z.array(labelAssignmentSchema).max(5),
    model: z.string().min(1),
    taxonomy_version: z.number().int().min(1),
    enriched_at: z.string().min(1),
  })
  .strict();

export type EnrichmentRow = z.infer<typeof enrichmentRowSchema>;

/**
 * Parse one current enrichment JSONL line. Legacy rows are intentionally
 * ignored instead of being coerced into the current schema.
 */
export function parseEnrichmentRow(candidate: unknown): EnrichmentRow | undefined {
  const parsed = enrichmentRowSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * True when the row was produced under the current evidence-bearing
 * classification contract. Legacy rows without evidence-bearing arrays
 * remain history but do not contribute to active reads.
 */
export function isCurrentEnrichmentRow(row: EnrichmentRow): boolean {
  return enrichmentRowSchema.safeParse(row).success;
}

/**
 * Compact per-attempt event committed alongside enrichment rows so retry and
 * blocked state survive across restarts. Written to
 * `enrichment/attempts/YYYY/MM/attempts-YYYY-MM-DD.jsonl`.
 */
export const attemptOutcomeSchema = z.enum([
  "success",
  "transient_failure",
  "invalid_output",
  "commit_failed",
  "blocked",
]);

export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;

export const errorClassSchema = z.enum([
  "timeout",
  "rate_limit",
  "provider_5xx",
  "provider_4xx",
  "invalid_output",
  "commit_failed",
  "other",
]);

export type ErrorClass = z.infer<typeof errorClassSchema>;

export const attemptEventSchema = z.object({
  unit_id: z.string().min(1),
  input_hash: z.string().min(1),
  contract_hash: z.string().min(1),
  attempt: z.number().int().min(1),
  outcome: attemptOutcomeSchema,
  error_class: errorClassSchema.optional(),
  error_message: z.string().optional(),
  at: z.string().min(1),
  first_queued_at: z.string().min(1).optional(),
  next_retry_at: z.string().min(1).optional(),
});

export type AttemptEvent = z.infer<typeof attemptEventSchema>;

// --- API response payloads ---

export type LabelCount = LabelConfig & { count: number };

export type FreeLabelCount = { name: string; count: number };

export type QueueDepth = {
  pending: number;
  running: number;
  retrying: number;
  blocked: number;
  done: number;
};

export type EnrichmentCoverage = { units_total: number; units_enriched: number };

/** `GET /api/labels` payload. */
export type LabelsSummary = {
  revision: string;
  taxonomy_version: number;
  labels: LabelCount[];
  free_labels: FreeLabelCount[];
  queue: QueueDepth;
  coverage: EnrichmentCoverage;
};

export type RelatedFreeLabel = { name: string; shared_units: number };

/** `GET /api/free-labels/:name` payload. */
export type FreeLabelDetail = {
  revision: string;
  name: string;
  unit_count: number;
  tweet_count: number;
  related: RelatedFreeLabel[];
};

export type GraphNode = { name: string; unit_count: number };

export type GraphLink = { source: string; target: string; weight: number };

/** `GET /api/graph` payload, computed from approved free-label co-occurrence. */
export type FreeLabelGraph = { revision: string; nodes: GraphNode[]; links: GraphLink[] };

/** One recent error observed by the worker, for the admin surface. */
export type ErrorClassBreakdown = { error_class: ErrorClass; count: number };

/**
 * `GET /api/enrichment/status` payload. Counts describe the selected unit
 * set (usually author-filtered). `complete_through` is the highest activity
 * timestamp for which every selected unit has a current result.
 */
export type EnrichmentStatus = {
  revision: string;
  contract_hash: string;
  taxonomy_version: number;
  totals: {
    total: number;
    pending: number;
    running: number;
    retrying: number;
    blocked: number;
    completed: number;
  };
  oldest_pending_at?: string;
  newest_completed_at?: string;
  complete_through?: string;
  worker_active: boolean;
  freshness_lag_seconds?: number;
  recent_errors: readonly ErrorClassBreakdown[];
};

/**
 * One current enrichment run receipt, appended to
 * `enrichment/receipts/<date>.jsonl`.
 *
 * Reader processes use this strict schema before reporting a durable worker
 * heartbeat. Older receipt shapes are intentionally not coerced into the
 * current admin signal.
 */
export const enrichReceiptSchema = z
  .object({
    started_at: z.iso.datetime({ offset: true }),
    finished_at: z.iso.datetime({ offset: true }),
    units: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative().optional(),
    failures: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    contract_hash: z.string().min(1),
    worker_id: z.string().min(1),
    discarded_assignments: z.number().int().nonnegative(),
    new_candidates: z.number().int().nonnegative(),
    new_approvals: z.number().int().nonnegative(),
    new_rejections: z.number().int().nonnegative(),
    stopped_by: z.string().min(1).optional(),
  })
  .strict();

export type EnrichReceipt = z.infer<typeof enrichReceiptSchema>;

/** Parse a current durable receipt, rejecting legacy or malformed rows. */
export function parseEnrichReceipt(candidate: unknown): EnrichReceipt | undefined {
  const parsed = enrichReceiptSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

// --- Derivations shared by ingest, worker and explorer ---

/** Slug identity of a free-label name: lowercase, diacritics stripped, dash-joined. */
export function slugifyFreeLabel(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Classification unit of a tweet: the conversation-author unit. A root post
 * and the same author's replies in that conversation share one unit.
 */
export function unitIdFor(tweet: Tweet): string {
  const raw = tweet["conversation_id"];
  const conversationId =
    typeof raw === "string" && raw.length > 0
      ? raw
      : typeof raw === "number"
        ? String(raw)
        : undefined;
  return `${conversationId ?? tweet.id}:${tweet.author.username.toLowerCase()}`;
}

/** Dataset path of the daily enrichment JSONL shard for a given timestamp. */
export function enrichmentPathFor(enrichedAt: string): string {
  const day = dayKey(enrichedAt);
  const [year, month] = [day.slice(0, 4), day.slice(5, 7)];
  return `enrichment/${year}/${month}/enrichment-${day}.jsonl`;
}

/** Dataset path of the daily attempt-event JSONL shard for a given timestamp. */
export function attemptEventPathFor(at: string): string {
  const day = dayKey(at);
  const [year, month] = [day.slice(0, 4), day.slice(5, 7)];
  return `enrichment/attempts/${year}/${month}/attempts-${day}.jsonl`;
}

/** Dataset path of the daily free-label registry event JSONL shard. */
export function registryEventPathFor(at: string): string {
  const day = dayKey(at);
  const [year, month] = [day.slice(0, 4), day.slice(5, 7)];
  return `enrichment/registry/${year}/${month}/registry-${day}.jsonl`;
}

/** Dataset path of the daily enrichment run receipt file. */
export function receiptPathFor(at: string): string {
  return `enrichment/receipts/${dayKey(at)}.jsonl`;
}
