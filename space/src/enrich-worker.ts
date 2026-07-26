import { z } from "zod";

import {
  conceptSchema,
  enrichmentPathFor,
  mergeConceptEntry,
  receiptPathFor,
  slugifyConcept,
  VOCABULARY_PATH,
} from "@xtap-pool/shared";
import type {
  ConceptCount,
  EnrichmentRow,
  EnrichReceipt,
  LabelConfig,
  VocabularyEntry,
} from "@xtap-pool/shared";

import type { DatasetMirror } from "./dataset.js";
import type { EnrichTaxonomy } from "./enrich-config.js";
import type { EnrichStore, QueueItem } from "./enrich-store.js";

const ROUTER_URL = "https://router.huggingface.co/v1/chat/completions";
const UNIT_TEXT_MAX_CHARS = 4000;
const VOCABULARY_PROMPT_CAP = 150;
// 20-unit batches exceed the router's gateway timeout with GLM 5.2
// (reasoning models spend ~1.3k completion tokens per unit); 6 keeps
// calls comfortably under it. Verified live 2026-07-26.
const DEFAULT_UNITS_PER_CALL = 6;
const MAX_FREE_LABELS = 5;
const MAX_CONCEPTS = 8;

export type LlmMessage = { role: "system" | "user"; content: string };

export type LlmUsage = { prompt_tokens: number; completion_tokens: number };

export type LlmResult = { content: string; usage: LlmUsage };

/** One chat completion call; injected so tests never touch the network. */
export type LlmClient = (messages: readonly LlmMessage[]) => Promise<LlmResult>;

const routerResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().default(0),
      completion_tokens: z.number().default(0),
    })
    .optional(),
});

/** Chat-completions client against the HF Inference Providers router. */
export function createRouterLlmClient(options: {
  hfToken: string;
  model: string;
  fetchFn?: typeof fetch;
}): LlmClient {
  const fetchFn = options.fetchFn ?? fetch;
  return async (messages: readonly LlmMessage[]): Promise<LlmResult> => {
    const response = await fetchFn(ROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.hfToken}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`router request failed (${String(response.status)}): ${detail}`);
    }
    const parsed = routerResponseSchema.parse(await response.json());
    return {
      content: parsed.choices[0]?.message.content ?? "",
      usage: {
        prompt_tokens: parsed.usage?.prompt_tokens ?? 0,
        completion_tokens: parsed.usage?.completion_tokens ?? 0,
      },
    };
  };
}

export type EnrichWorkerDeps = {
  enrichStore: EnrichStore;
  mirror: DatasetMirror;
  taxonomy: EnrichTaxonomy;
  llm: LlmClient;
  /** Model identifier recorded on enrichment rows. */
  model: string;
  maxUnitsPerTick: number;
  unitsPerCall?: number;
  now: () => Date;
};

const llmUnitSchema = z.object({
  labels: z.array(z.string()).default([]),
  free_labels: z.array(z.string()).default([]),
  concepts: z.array(conceptSchema).default([]),
});

type LlmUnit = z.infer<typeof llmUnitSchema>;

const llmBatchSchema = z.object({ units: z.record(z.string(), llmUnitSchema) });

type PromptUnit = { unitId: string; tweetIds: readonly string[]; text: string };

/**
 * Drain one tick of the enrichment queue: batch queued units into LLM calls,
 * persist each processed batch to the dataset (rows + vocabulary) before
 * updating SQLite, and append a run receipt when any call was made.
 */
export async function runEnrichTick(deps: EnrichWorkerDeps): Promise<EnrichReceipt> {
  const receipt: EnrichReceipt = {
    started_at: deps.now().toISOString(),
    finished_at: deps.now().toISOString(),
    units: 0,
    calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    failures: 0,
  };
  const claimed = deps.enrichStore.claimQueued(deps.maxUnitsPerTick);
  const size = deps.unitsPerCall ?? DEFAULT_UNITS_PER_CALL;
  for (let start = 0; start < claimed.length; start += size) {
    await processBatch(deps, claimed.slice(start, start + size), receipt);
  }
  receipt.finished_at = deps.now().toISOString();
  if (receipt.calls > 0) await writeReceipt(deps, receipt);
  return receipt;
}

/** Interval loop gated by ENRICH_ENABLED; each tick runs the provided drain. */
export function startEnrichWorker(options: {
  intervalMs: number;
  run: () => Promise<EnrichReceipt>;
}): { stop: () => void } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await options.run();
    } catch (error) {
      console.error(`[xtap-pool] enrich tick failed: ${errorMessage(error)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs);
  return {
    stop: (): void => {
      clearInterval(timer);
    },
  };
}

async function processBatch(
  deps: EnrichWorkerDeps,
  batch: readonly QueueItem[],
  receipt: EnrichReceipt,
): Promise<void> {
  const units: PromptUnit[] = batch.map((item) => ({
    unitId: item.unitId,
    tweetIds: deps.enrichStore.unitMemberIds(item.unitId),
    text: deps.enrichStore.unitText(item.unitId, UNIT_TEXT_MAX_CHARS),
  }));
  const outcome = await callLlm(deps, units, receipt);
  if (!outcome.ok) {
    failBatch(deps, batch, receipt, outcome.error);
    return;
  }
  const parsed = parseBatchResponse(outcome.content);
  if (parsed === undefined) {
    failBatch(deps, batch, receipt, "unparseable model response");
    return;
  }
  await settleBatch(deps, units, parsed, receipt);
}

type LlmOutcome = { ok: true; content: string } | { ok: false; error: string };

async function callLlm(
  deps: EnrichWorkerDeps,
  units: readonly PromptUnit[],
  receipt: EnrichReceipt,
): Promise<LlmOutcome> {
  receipt.calls += 1;
  try {
    const vocabulary = retrieveVocabulary(
      deps.enrichStore.vocabularyEntries(),
      units.map((unit) => unit.text).join("\n"),
      VOCABULARY_PROMPT_CAP,
    );
    const result = await deps.llm(buildMessages(deps.taxonomy.labels, vocabulary, units));
    receipt.prompt_tokens += result.usage.prompt_tokens;
    receipt.completion_tokens += result.usage.completion_tokens;
    return { ok: true, content: result.content };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function settleBatch(
  deps: EnrichWorkerDeps,
  units: readonly PromptUnit[],
  parsed: Record<string, LlmUnit>,
  receipt: EnrichReceipt,
): Promise<void> {
  const rows: EnrichmentRow[] = [];
  const missing: string[] = [];
  for (const unit of units) {
    const entry = parsed[unit.unitId];
    if (entry === undefined || unit.tweetIds.length === 0) missing.push(unit.unitId);
    else rows.push(toEnrichmentRow(deps, unit, entry));
  }
  if (rows.length > 0 && !(await persistAndApply(deps, units, rows, receipt))) return;
  for (const unitId of missing) {
    deps.enrichStore.markFailed(unitId, "unit missing from model response");
    receipt.failures += 1;
  }
}

/** Dataset commit first, SQLite after; a failed commit fails the whole batch. */
async function persistAndApply(
  deps: EnrichWorkerDeps,
  units: readonly PromptUnit[],
  rows: readonly EnrichmentRow[],
  receipt: EnrichReceipt,
): Promise<boolean> {
  try {
    await persistRows(deps, rows);
  } catch (error) {
    for (const unit of units) deps.enrichStore.markFailed(unit.unitId, errorMessage(error));
    receipt.failures += units.length;
    return false;
  }
  for (const row of rows) deps.enrichStore.applyEnrichment(row);
  receipt.units += rows.length;
  return true;
}

function failBatch(
  deps: EnrichWorkerDeps,
  batch: readonly QueueItem[],
  receipt: EnrichReceipt,
  error: string,
): void {
  for (const item of batch) deps.enrichStore.markFailed(item.unitId, error);
  receipt.failures += batch.length;
}

/** Extract and validate the JSON contract, tolerating code fences and prose. */
export function parseBatchResponse(content: string): Record<string, LlmUnit> | undefined {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let candidate: unknown;
  try {
    candidate = JSON.parse(content.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const parsed = llmBatchSchema.safeParse(candidate);
  return parsed.success ? parsed.data.units : undefined;
}

function toEnrichmentRow(deps: EnrichWorkerDeps, unit: PromptUnit, entry: LlmUnit): EnrichmentRow {
  const presetByLower = new Map(
    deps.taxonomy.labels.map((label) => [label.name.toLowerCase(), label.name]),
  );
  const labels = dedupe(
    entry.labels
      .map((label) => presetByLower.get(label.trim().toLowerCase()))
      .filter((label): label is string => label !== undefined),
  );
  const freeLabels = dedupe(
    entry.free_labels.map(slugifyConcept).filter((label) => label.length > 0),
  ).slice(0, MAX_FREE_LABELS);
  const unitTextLower = unit.text.toLowerCase();
  const concepts = entry.concepts
    .filter((concept) => slugifyConcept(concept.name).length > 0)
    .slice(0, MAX_CONCEPTS)
    .map((concept) => ({
      name: concept.name.trim(),
      // the contract requires aliases to be surface forms present in the
      // unit; hallucinated aliases would mislink unrelated tweets globally
      aliases: dedupe(
        concept.aliases
          .map((alias) => alias.trim())
          .filter((a) => a.length > 0 && unitTextLower.includes(a.toLowerCase())),
      ),
    }));
  return {
    unit_id: unit.unitId,
    tweet_ids: [...unit.tweetIds],
    labels,
    free_labels: freeLabels,
    concepts,
    model: deps.model,
    taxonomy_version: deps.taxonomy.version,
    enriched_at: deps.now().toISOString(),
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Lexical vocabulary retrieval: only entries whose name or alias tokens
 * overlap the batch text are sent to the model, capped to keep prompts
 * bounded as the vocabulary grows.
 */
export function retrieveVocabulary(
  entries: readonly ConceptCount[],
  batchText: string,
  cap: number,
): VocabularyEntry[] {
  const tokens = new Set(tokenize(batchText));
  const scored = entries
    .map((entry) => ({ entry, score: overlapScore(entry, tokens) }))
    .filter((candidate) => candidate.score > 0);
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.entry.unit_count - left.entry.unit_count ||
      left.entry.slug.localeCompare(right.entry.slug),
  );
  return scored
    .slice(0, cap)
    .map(({ entry }) => ({ slug: entry.slug, name: entry.name, aliases: [...entry.aliases] }));
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

function overlapScore(entry: ConceptCount, tokens: ReadonlySet<string>): number {
  const candidates = new Set(tokenize([entry.name, ...entry.aliases].join(" ")));
  let score = 0;
  for (const candidate of candidates) if (tokens.has(candidate)) score += 1;
  return score;
}

function buildMessages(
  labels: readonly LabelConfig[],
  vocabulary: readonly VocabularyEntry[],
  units: readonly PromptUnit[],
): LlmMessage[] {
  const system = [
    "You classify batches of X/Twitter post units. Each unit is a root post",
    "plus the same author's self-replies. For every unit return preset labels,",
    "free labels and concepts.",
    "",
    "Preset labels — use only these exact names, and only when they apply:",
    JSON.stringify(labels, null, 2),
    "",
    "Rules:",
    "- labels: zero or more preset label names. An empty array is valid.",
    `- free_labels: up to ${String(MAX_FREE_LABELS)} lowercase-dash slugs for salient topics not covered by presets (e.g. "dgx-spark").`,
    `- concepts: 3 to ${String(MAX_CONCEPTS)} per unit; names are short Wikipedia-title noun phrases; aliases only list surface forms that literally appear in the unit's text.`,
    "- Reuse names and aliases from the known vocabulary below when they fit.",
    "",
    "Known concept vocabulary:",
    JSON.stringify(vocabulary),
    "",
    "Respond with JSON only, exactly matching:",
    '{"units": {"<unit_id>": {"labels": ["<preset>"], "free_labels": ["<slug>"], "concepts": [{"name": "...", "aliases": ["..."]}]}}}',
  ].join("\n");
  const user = JSON.stringify({
    units: units.map((unit) => ({ unit_id: unit.unitId, text: unit.text })),
  });
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function persistRows(deps: EnrichWorkerDeps, rows: readonly EnrichmentRow[]): Promise<void> {
  const byPath = new Map<string, string[]>();
  for (const row of rows) {
    const path = enrichmentPathFor(row.enriched_at);
    const bucket = byPath.get(path);
    if (bucket === undefined) byPath.set(path, [JSON.stringify(row)]);
    else bucket.push(JSON.stringify(row));
  }
  const vocabulary = previewVocabulary(deps.enrichStore.vocabularyEntries(), rows);
  const content = `${JSON.stringify(
    { version: 1, updated_at: deps.now().toISOString(), concepts: vocabulary },
    null,
    2,
  )}\n`;
  await deps.mirror.commitBatch(
    [...byPath.entries()].map(([path, lines]) => ({ path, lines })),
    [{ path: VOCABULARY_PATH, content }],
    `enrich: ${String(rows.length)} units`,
  );
}

/** The vocabulary as it will look after the rows are applied to SQLite. */
function previewVocabulary(
  current: readonly ConceptCount[],
  rows: readonly EnrichmentRow[],
): VocabularyEntry[] {
  const bySlug = new Map<string, VocabularyEntry>(
    current.map((entry) => [
      entry.slug,
      { slug: entry.slug, name: entry.name, aliases: [...entry.aliases] },
    ]),
  );
  for (const row of rows) {
    for (const concept of row.concepts) {
      const slug = slugifyConcept(concept.name);
      if (slug.length === 0) continue;
      const merged = mergeConceptEntry(bySlug.get(slug), concept);
      bySlug.set(slug, { slug, ...merged });
    }
  }
  return [...bySlug.values()].sort((left, right) => left.slug.localeCompare(right.slug));
}

async function writeReceipt(deps: EnrichWorkerDeps, receipt: EnrichReceipt): Promise<void> {
  await deps.mirror.commitBatch(
    [{ path: receiptPathFor(receipt.finished_at), lines: [JSON.stringify(receipt)] }],
    [],
    `enrich: receipt ${receipt.finished_at.slice(0, 10)}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
