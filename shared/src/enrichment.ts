import { z } from "zod";

import { dayKey } from "./tweet.js";
import type { Tweet } from "./tweet.js";

/** One preset taxonomy entry; the description steers the classifier. */
export const labelConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
});

export type LabelConfig = z.infer<typeof labelConfigSchema>;

/** A blog-style concept: a short noun phrase plus surface-form aliases. */
export const conceptSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
});

export type Concept = z.infer<typeof conceptSchema>;

/**
 * One enrichment result for a conversation-author unit, as appended to
 * `enrichment/YYYY/MM/enrichment-YYYY-MM-DD.jsonl` in the pool dataset.
 */
export const enrichmentRowSchema = z.object({
  unit_id: z.string().min(1),
  tweet_ids: z.array(z.string().min(1)).min(1),
  labels: z.array(z.string()),
  free_labels: z.array(z.string()),
  concepts: z.array(conceptSchema),
  model: z.string().min(1),
  taxonomy_version: z.number().int().min(1),
  enriched_at: z.string().min(1),
});

export type EnrichmentRow = z.infer<typeof enrichmentRowSchema>;

/** One concept in the global vocabulary, keyed by its slugified name. */
export const vocabularyEntrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
});

export type VocabularyEntry = z.infer<typeof vocabularyEntrySchema>;

/** Shape of `enrichment/vocabulary.json` in the pool dataset. */
export const vocabularyFileSchema = z.object({
  version: z.literal(1),
  updated_at: z.string(),
  concepts: z.array(vocabularyEntrySchema).default([]),
});

export type VocabularyFile = z.infer<typeof vocabularyFileSchema>;

/** Parse `enrichment/vocabulary.json` content; invalid input yields an empty list. */
export function parseVocabularyJson(raw: string): VocabularyEntry[] {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = vocabularyFileSchema.safeParse(candidate);
  return parsed.success ? parsed.data.concepts : [];
}

// --- API response payloads ---

export type LabelCount = LabelConfig & { count: number };

export type FreeLabelCount = { name: string; count: number };

export type QueueDepth = { queued: number; failed: number; done: number };

export type EnrichmentCoverage = { units_total: number; units_enriched: number };

/** `GET /api/labels` payload. */
export type LabelsSummary = {
  taxonomy_version: number;
  labels: LabelCount[];
  free_labels: FreeLabelCount[];
  queue: QueueDepth;
  coverage: EnrichmentCoverage;
};

export type ConceptCount = VocabularyEntry & { unit_count: number };

/** `GET /api/concepts` payload. */
export type ConceptsSummary = { concepts: ConceptCount[] };

export type RelatedConcept = { slug: string; name: string; shared_units: number };

/** `GET /api/concepts/:slug` payload. */
export type ConceptSummary = ConceptCount & {
  tweet_count: number;
  related: RelatedConcept[];
};

export type GraphNode = { slug: string; name: string; unit_count: number };

export type GraphLink = { source: string; target: string; weight: number };

/** `GET /api/graph` payload. */
export type ConceptGraph = { nodes: GraphNode[]; links: GraphLink[] };

/** One enrichment run receipt, appended to `enrichment/receipts/<date>.jsonl`. */
export type EnrichReceipt = {
  started_at: string;
  finished_at: string;
  units: number;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  failures: number;
};

// --- Derivations shared by ingest, worker and explorer ---

/** Dataset path of the concept vocabulary file. */
export const VOCABULARY_PATH = "enrichment/vocabulary.json";

/** Slug identity of a concept name: lowercase, diacritics stripped, dash-joined. */
export function slugifyConcept(name: string): string {
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

/** Dataset path of the daily enrichment run receipt file. */
export function receiptPathFor(at: string): string {
  return `enrichment/receipts/${dayKey(at)}.jsonl`;
}

/**
 * Merge an incoming concept into an existing vocabulary entry (same slug).
 * The existing canonical name wins; aliases are unioned case-insensitively
 * and the canonical name never appears among its own aliases.
 */
export function mergeConceptEntry(
  existing: { name: string; aliases: readonly string[] } | undefined,
  incoming: Concept,
): { name: string; aliases: string[] } {
  const name = existing?.name ?? incoming.name.trim();
  const candidates = [...(existing?.aliases ?? []), ...incoming.aliases, incoming.name];
  const seen = new Set([name.toLowerCase()]);
  const aliases: string[] = [];
  for (const raw of candidates) {
    const alias = raw.trim();
    const key = alias.toLowerCase();
    if (alias.length === 0 || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return { name, aliases };
}
