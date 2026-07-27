import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  attemptEventPathFor,
  attemptEventSchema,
  computeContractHash,
  enrichmentPathFor,
  labelAssignmentSchema,
  PROCESSOR_VERSION,
  receiptPathFor,
  registryEventPathFor,
} from "@xtap-pool/shared";
import type {
  AttemptEvent,
  AttemptOutcome,
  EnrichmentRow,
  EnrichReceipt,
  ErrorClass,
  FreeLabelEvent,
  LabelAssignment,
  LabelConfig,
} from "@xtap-pool/shared";

import type { DatasetMirror } from "./dataset.js";
import type { EnrichTaxonomy } from "./enrich-config.js";
import type { EnrichStore, QueueItem } from "./enrich-store.js";
import {
  HARD_REJECTED_NAMES,
  normalizeFreeLabelName,
  validateEvidenceQuotes,
  validateFreeLabelName,
} from "./free-label-rules.js";

const ROUTER_URL = "https://router.huggingface.co/v1/chat/completions";
const UNIT_TEXT_MAX_CHARS = 4000;
const DEFAULT_UNITS_PER_CALL = 6;
const MAX_FREE_LABELS_PER_UNIT = 5;

/** Contract identifiers that participate in `contract_hash`. */
export const PROMPT_TEMPLATE_ID = "labels-and-free-labels-v1";
export const OUTPUT_SCHEMA_ID = "assignments-v1";
export const NORMALIZATION_ID = "free-label-registry-v1";

export const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
export const DEFAULT_LEASE_MS = 5 * 60_000;

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const BLOCKED_RETRY_MS = 24 * 60 * 60_000;

export type LlmMessage = { role: "system" | "user"; content: string };
export type LlmUsage = { prompt_tokens: number; completion_tokens: number; cost_usd?: number };
export type LlmResult = { content: string; usage: LlmUsage };

export type LlmClient = (messages: readonly LlmMessage[]) => Promise<LlmResult>;
export type LlmPricing = { inputTokenUsd: number; outputTokenUsd: number };

const routerResponseSchema = z.looseObject({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().default(0),
      completion_tokens: z.number().default(0),
    })
    .loose()
    .optional(),
});

export function createRouterLlmClient(options: {
  hfToken: string;
  model: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
  pricing?: LlmPricing;
}): LlmClient {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return async (messages: readonly LlmMessage[]): Promise<LlmResult> => {
    const response = await fetchWithTimeout(fetchFn, options, messages, timeoutMs);
    return handleRouterResponse(response, options.pricing);
  };
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  options: { hfToken: string; model: string },
  messages: readonly LlmMessage[],
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchFn(ROUTER_URL, {
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
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new RouterError("router request timed out", "timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function routerErrorClass(status: number): ErrorClass {
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider_5xx";
  return "provider_4xx";
}

// eslint-disable-next-line complexity
async function handleRouterResponse(response: Response, pricing?: LlmPricing): Promise<LlmResult> {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new RouterError(
      `router request failed (${String(response.status)}): ${detail}`,
      routerErrorClass(response.status),
    );
  }
  const parsed = routerResponseSchema.parse(await response.json());
  const cost = routerCost(parsed, pricing);
  return {
    content: parsed.choices[0]?.message.content ?? "",
    usage: {
      prompt_tokens: parsed.usage?.prompt_tokens ?? 0,
      completion_tokens: parsed.usage?.completion_tokens ?? 0,
      ...(cost === undefined ? {} : { cost_usd: cost }),
    },
  };
}

// eslint-disable-next-line complexity
function routerCost(value: Record<string, unknown>, pricing?: LlmPricing): number | undefined {
  const direct = value["cost"];
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;
  const usage = value["usage"];
  if (typeof usage !== "object" || usage === null) return undefined;
  const cost = (usage as Record<string, unknown>)["cost"];
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) return cost;
  const prompt = (usage as Record<string, unknown>)["prompt_tokens"];
  const completion = (usage as Record<string, unknown>)["completion_tokens"];
  if (
    pricing !== undefined &&
    typeof prompt === "number" &&
    typeof completion === "number" &&
    Number.isFinite(prompt) &&
    Number.isFinite(completion)
  ) {
    return prompt * pricing.inputTokenUsd + completion * pricing.outputTokenUsd;
  }
  return undefined;
}

export class RouterError extends Error {
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
  ) {
    super(message);
    this.name = "RouterError";
  }
}

const reviewSchema = z.object({ decision: z.enum(["approve", "reject", "abstain"]) }).strict();
const HUB_URL = /(?:https?:\/\/)?huggingface\.co\/(?:models\/|datasets\/)?([\w.-]+\/[\w.-]+)/giu;
const HUB_VERIFY_TIMEOUT_MS = 5_000;

/**
 * Verify only an exact public Hub repository reference present in grounded
 * evidence. It sends no credential and never searches or guesses a name.
 */
export function createExactHubVerifier(fetchFn: typeof fetch = fetch): HubVerifier {
  return async (name, assignments): Promise<boolean> => {
    const reference = assignments
      .flatMap((assignment) => assignment.evidence)
      .flatMap((evidence) => [...evidence.quote.matchAll(HUB_URL)].map((match) => match[1]))
      .find((candidate): candidate is string => candidate !== undefined);
    if (reference === undefined || normalizeHubReference(reference) !== name) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, HUB_VERIFY_TIMEOUT_MS);
    try {
      for (const type of ["models", "datasets"]) {
        const response = await fetchFn(`https://huggingface.co/api/${type}/${reference}`, {
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) continue;
        const body = (await response.json()) as { id?: unknown };
        return body.id === reference;
      }
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

function normalizeHubReference(reference: string): string {
  return reference
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A strict, bounded operational review; it cannot create or rename labels. */
export function createFreeLabelJudge(llm: LlmClient): FreeLabelJudge {
  return async (name, evidence) => {
    const bounded = evidence.slice(0, 12).map((item) => ({
      tweet_id: item.tweet_id,
      quote: item.quote.slice(0, 300),
    }));
    const result = await llm([
      {
        role: "system",
        content:
          'Review one existing free-label candidate. Decide only whether this exact name is a specific, useful AI or local-model subject supported by the supplied quotes. Do not propose, rename, or classify labels. Return strict JSON only: {"decision":"approve"|"reject"|"abstain"}.',
      },
      { role: "user", content: JSON.stringify({ name, evidence: bounded }) },
    ]);
    let payload: unknown;
    try {
      payload = JSON.parse(result.content);
    } catch {
      payload = undefined;
    }
    const parsed = reviewSchema.safeParse(payload);
    return {
      verdict:
        !parsed.success || parsed.data.decision === "abstain"
          ? undefined
          : parsed.data.decision === "approve",
      usage: result.usage,
    };
  };
}

export type WorkerCeilings = {
  maxUnits?: number | undefined;
  maxTokens?: number | undefined;
  maxElapsedMs?: number | undefined;
  maxErrorRate?: number | undefined;
  maxCostUsd?: number | undefined;
  /** Conservative configured upper bound for one provider call. */
  maxCostPerCallUsd?: number | undefined;
  maxDiscardedAssignments?: number | undefined;
};

/** Injectable exact-Hub verifier. It receives only bounded label evidence. */
export type HubVerifier = (name: string, evidence: readonly LabelAssignment[]) => Promise<boolean>;

/** A constrained reviewer may decide only approval of the supplied name. */
export type FreeLabelJudgeResult =
  boolean | undefined | { verdict: boolean | undefined; usage: LlmUsage };

export type FreeLabelJudge = (
  name: string,
  evidence: readonly { tweet_id: string; quote: string }[],
) => Promise<FreeLabelJudgeResult>;

export type EnrichWorkerDeps = {
  enrichStore: EnrichStore;
  mirror: DatasetMirror;
  taxonomy: EnrichTaxonomy;
  llm: LlmClient;
  model: string;
  maxUnitsPerTick: number;
  unitsPerCall?: number;
  now: () => Date;
  workerId?: string;
  leaseMs?: number;
  ceilings?: WorkerCeilings;
  verifyHubLabel?: HubVerifier;
  judgeFreeLabel?: FreeLabelJudge;
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
};

const llmUnitSchema = z
  .object({
    preset_labels: z.array(labelAssignmentSchema),
    free_labels: z.array(labelAssignmentSchema).max(MAX_FREE_LABELS_PER_UNIT),
  })
  .strict();

type LlmUnit = z.infer<typeof llmUnitSchema>;

const llmBatchSchema = z.object({ units: z.record(z.string(), llmUnitSchema) }).strict();

type PromptUnit = {
  unitId: string;
  posts: readonly PromptPost[];
};

/** The prompt mirrors every field in `SemanticTweetFields` that can affect a result. */
type PromptPost = {
  tweet_id: string;
  text: string;
  conversation_id: string | undefined;
  author_id: string | undefined;
  author_username: string;
  reply_to: string | undefined;
  quoted_status_id: string | undefined;
  expanded_urls: readonly string[];
  is_subscriber_only: boolean;
  is_retweet: boolean;
};

export function contractHashFor(deps: { taxonomy: EnrichTaxonomy; model: string }): string {
  return computeContractHash({
    taxonomy_version: deps.taxonomy.version,
    labels: [...deps.taxonomy.labels],
    model: deps.model,
    processor_version: PROCESSOR_VERSION,
    prompt_template_id: PROMPT_TEMPLATE_ID,
    output_schema_id: OUTPUT_SCHEMA_ID,
    normalization_id: NORMALIZATION_ID,
  });
}

function initReceipt(contractHash: string, workerId: string, now: () => Date): EnrichReceipt {
  return {
    started_at: now().toISOString(),
    finished_at: now().toISOString(),
    units: 0,
    calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    failures: 0,
    retries: 0,
    blocked: 0,
    contract_hash: contractHash,
    worker_id: workerId,
    discarded_assignments: 0,
    new_candidates: 0,
    new_approvals: 0,
    new_rejections: 0,
  };
}

// eslint-disable-next-line complexity
export async function runEnrichTick(deps: EnrichWorkerDeps): Promise<EnrichReceipt> {
  const workerId = deps.workerId ?? randomUUID();
  const contractHash = contractHashFor(deps);
  deps.enrichStore.setContractHash(contractHash);
  const receipt = initReceipt(contractHash, workerId, deps.now);
  deps.enrichStore.recoverExpiredLeases();
  const claimed = deps.enrichStore.claimBatch({
    limit: deps.maxUnitsPerTick,
    workerId,
    leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS,
  });
  try {
    const size = deps.unitsPerCall ?? DEFAULT_UNITS_PER_CALL;
    const startedAt = deps.now().getTime();
    const stopped = await drainClaimed(deps, claimed, size, receipt, contractHash, startedAt);
    if (stopped !== undefined) receipt.stopped_by = stopped;
    const completedCeiling = ceilingHit(receipt, deps.ceilings ?? {}, deps.now, startedAt);
    if (completedCeiling !== undefined) receipt.stopped_by ??= completedCeiling;
    const registryStopped = await settleRegistryDecisions(deps, receipt);
    if (receipt.stopped_by === undefined && registryStopped !== undefined) {
      receipt.stopped_by = registryStopped;
    }
    receipt.finished_at = deps.now().toISOString();
    if (hasReceiptActivity(receipt)) {
      const lock = deps.lock ?? (async <T>(fn: () => Promise<T>): Promise<T> => fn());
      await lock(() => writeReceipt(deps, receipt));
    }
    return receipt;
  } finally {
    // A ceiling or exception must not strand work until an arbitrary lease expiry.
    deps.enrichStore.releaseClaims(
      workerId,
      claimed.map((item) => item.unitId),
    );
  }
}

async function drainClaimed(
  deps: EnrichWorkerDeps,
  claimed: readonly QueueItem[],
  size: number,
  receipt: EnrichReceipt,
  contractHash: string,
  startedAt: number,
): Promise<string | undefined> {
  const ceilings = deps.ceilings ?? {};
  let start = 0;
  while (start < claimed.length) {
    const stopped = ceilingHit(receipt, ceilings, deps.now, startedAt);
    if (stopped !== undefined) return stopped;
    const costStopped = costCallPreflight(receipt, ceilings);
    if (costStopped !== undefined) return costStopped;
    const remainingUnits =
      ceilings.maxUnits === undefined
        ? size
        : Math.min(size, ceilings.maxUnits - unitsProcessed(receipt));
    if (remainingUnits <= 0) return "max_units";
    const batch = claimed.slice(start, start + remainingUnits);
    await processBatch(deps, batch, receipt, contractHash);
    start += batch.length;
  }
  return undefined;
}

function hasReceiptActivity(receipt: EnrichReceipt): boolean {
  return (
    receipt.calls > 0 ||
    receipt.failures > 0 ||
    receipt.units > 0 ||
    receipt.new_candidates > 0 ||
    receipt.new_approvals > 0 ||
    receipt.new_rejections > 0
  );
}

/** A retry is a failed processed unit, not an additional processed unit. */
function unitsProcessed(receipt: EnrichReceipt): number {
  return receipt.units + receipt.failures;
}

function promptPosts(deps: EnrichWorkerDeps, unitId: string): PromptPost[] {
  const members = deps.enrichStore.unitSemanticMembers(unitId);
  let remaining = UNIT_TEXT_MAX_CHARS;
  const posts: PromptPost[] = [];
  for (const member of members) {
    const clipped = member.text.slice(0, Math.max(0, remaining));
    posts.push({
      tweet_id: member.id,
      text: clipped,
      conversation_id: member.conversation_id,
      author_id: member.author_id,
      author_username: member.author_username,
      reply_to: member.reply_to,
      quoted_status_id: member.quoted_status_id,
      expanded_urls: member.expanded_urls,
      is_subscriber_only: member.is_subscriber_only,
      is_retweet: member.is_retweet,
    });
    remaining -= clipped.length;
  }
  return posts;
}

function tokensUsed(receipt: EnrichReceipt): number {
  return receipt.prompt_tokens + receipt.completion_tokens;
}

function errorRate(receipt: EnrichReceipt): number {
  const processed = unitsProcessed(receipt);
  return processed === 0 ? 0 : receipt.failures / processed;
}

function ceilingHit(
  receipt: EnrichReceipt,
  ceilings: WorkerCeilings,
  now: () => Date,
  startedAt: number,
): string | undefined {
  if (ceilings.maxCostUsd !== undefined && receipt.cost_usd === undefined) return "cost_unmeasured";
  const checks: [number | undefined, number, string][] = [
    [ceilings.maxUnits, unitsProcessed(receipt), "max_units"],
    [ceilings.maxTokens, tokensUsed(receipt), "max_tokens"],
    [ceilings.maxElapsedMs, now().getTime() - startedAt, "max_elapsed"],
    [ceilings.maxErrorRate, errorRate(receipt), "max_error_rate"],
    [ceilings.maxCostUsd, receipt.cost_usd ?? 0, "max_cost_usd"],
    [ceilings.maxDiscardedAssignments, receipt.discarded_assignments, "max_discarded_assignments"],
  ];
  for (const [limit, current, name] of checks) {
    if (limit !== undefined && current >= limit) return name;
  }
  return undefined;
}

function costCallPreflight(receipt: EnrichReceipt, ceilings: WorkerCeilings): string | undefined {
  if (ceilings.maxCostUsd === undefined) return undefined;
  if (receipt.cost_usd === undefined || ceilings.maxCostPerCallUsd === undefined) {
    return "cost_unmeasured";
  }
  return receipt.cost_usd + ceilings.maxCostPerCallUsd > ceilings.maxCostUsd
    ? "max_cost_usd"
    : undefined;
}

async function processBatch(
  deps: EnrichWorkerDeps,
  batch: readonly QueueItem[],
  receipt: EnrichReceipt,
  contractHash: string,
): Promise<void> {
  const units: PromptUnit[] = batch.map((item) => ({
    unitId: item.unitId,
    posts: promptPosts(deps, item.unitId),
  }));
  const outcome = await callLlm(deps, units, receipt);
  if (!outcome.ok) {
    await failBatch(deps, batch, receipt, outcome.error, outcome.errorClass, contractHash);
    return;
  }
  const parsed = parseBatchResponse(outcome.content);
  const expectedUnitIds = new Set(batch.map((item) => item.unitId));
  if (parsed === undefined || Object.keys(parsed).some((unitId) => !expectedUnitIds.has(unitId))) {
    await failBatch(
      deps,
      batch,
      receipt,
      "unparseable model response",
      "invalid_output",
      contractHash,
    );
    return;
  }
  await settleBatch(deps, batch, units, parsed, receipt, contractHash);
}

type LlmOutcome =
  { ok: true; content: string } | { ok: false; error: string; errorClass: ErrorClass };

async function callLlm(
  deps: EnrichWorkerDeps,
  units: readonly PromptUnit[],
  receipt: EnrichReceipt,
): Promise<LlmOutcome> {
  receipt.calls += 1;
  try {
    const rejected = [
      ...new Set([...HARD_REJECTED_NAMES, ...deps.enrichStore.rejectedNames()]),
    ].sort((left, right) => left.localeCompare(right));
    const result = await deps.llm(buildMessages(deps.taxonomy.labels, rejected, units));
    receipt.prompt_tokens += result.usage.prompt_tokens;
    receipt.completion_tokens += result.usage.completion_tokens;
    if (result.usage.cost_usd === undefined && deps.ceilings?.maxCostUsd !== undefined) {
      receipt.cost_usd = undefined;
      return { ok: false, error: "provider cost could not be measured", errorClass: "other" };
    }
    receipt.cost_usd = (receipt.cost_usd ?? 0) + (result.usage.cost_usd ?? 0);
    return { ok: true, content: result.content };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      errorClass: error instanceof RouterError ? error.errorClass : classifyError(error),
    };
  }
}

async function settleBatch(
  deps: EnrichWorkerDeps,
  batch: readonly QueueItem[],
  units: readonly PromptUnit[],
  parsed: Record<string, LlmUnit>,
  receipt: EnrichReceipt,
  contractHash: string,
): Promise<void> {
  const registryEvents: FreeLabelEvent[] = [];
  const { rows, successful, missing } = partitionBatch(
    deps,
    batch,
    units,
    parsed,
    contractHash,
    receipt,
    registryEvents,
  );
  if (rows.length > 0) {
    const commit = await persistAndApply(
      deps,
      batch,
      successful,
      rows,
      registryEvents,
      receipt,
      contractHash,
    );
    if (!commit) return;
  }
  for (const item of missing) await failMissingUnit(deps, item, receipt);
}

function partitionBatch(
  deps: EnrichWorkerDeps,
  batch: readonly QueueItem[],
  units: readonly PromptUnit[],
  parsed: Record<string, LlmUnit>,
  contractHash: string,
  receipt: EnrichReceipt,
  registryEvents: FreeLabelEvent[],
): { rows: EnrichmentRow[]; successful: QueueItem[]; missing: QueueItem[] } {
  const rows: EnrichmentRow[] = [];
  const successful: QueueItem[] = [];
  const missing: QueueItem[] = [];
  for (const item of batch) {
    const promptUnit = units.find((u) => u.unitId === item.unitId);
    if (promptUnit === undefined) continue;
    const entry = parsed[item.unitId];
    if (entry === undefined || promptUnit.posts.length === 0) {
      missing.push(item);
      continue;
    }
    rows.push(buildRow(deps, promptUnit, item, entry, contractHash, receipt, registryEvents));
    successful.push(item);
  }
  return { rows, successful, missing };
}

async function failMissingUnit(
  deps: EnrichWorkerDeps,
  item: QueueItem,
  receipt: EnrichReceipt,
): Promise<void> {
  const nextRetry = backoffDate(deps.now(), item.attempts + 1, "invalid_output");
  receipt.failures += 1;
  receipt.retries += 1;
  const attempt = item.attempts + 1;
  if (attempt >= 5) receipt.blocked += 1;
  await persistAttemptAndApply(deps, {
    unit_id: item.unitId,
    input_hash: item.inputHash,
    contract_hash: item.contractHash,
    attempt,
    outcome: attempt >= 5 ? "blocked" : "invalid_output",
    error_class: "invalid_output",
    error_message: "unit missing from model response",
    at: deps.now().toISOString(),
    first_queued_at: item.firstQueuedAt,
    next_retry_at: nextRetry.toISOString(),
  });
}

/**
 * Build one enrichment row from the model response. Validates preset names,
 * evidence quotes, and free-label deterministic rules.
 */
function buildRow(
  deps: EnrichWorkerDeps,
  unit: PromptUnit,
  item: QueueItem,
  entry: LlmUnit,
  contractHash: string,
  receipt: EnrichReceipt,
  registryEvents: FreeLabelEvent[],
): EnrichmentRow {
  const memberTexts = deps.enrichStore.unitTweetTexts(unit.unitId);
  const presetLabels = validPresetLabels(
    entry.preset_labels,
    deps.taxonomy.labels,
    memberTexts,
    receipt,
  );
  const freeLabels = validFreeLabels(
    entry.free_labels,
    memberTexts,
    deps.enrichStore,
    receipt,
    registryEvents,
  );
  return {
    unit_id: unit.unitId,
    // Prompt text is bounded, but a result must always bind the complete,
    // exact membership that was leased for this input hash.
    tweet_ids: [...item.tweetIds],
    input_hash: item.inputHash,
    contract_hash: contractHash,
    preset_labels: presetLabels,
    free_labels: freeLabels,
    model: deps.model,
    taxonomy_version: deps.taxonomy.version,
    enriched_at: deps.now().toISOString(),
  };
}

function validPresetLabels(
  assignments: readonly LabelAssignment[],
  taxonomy: readonly LabelConfig[],
  memberTexts: ReadonlyMap<string, string>,
  receipt: EnrichReceipt,
): LabelAssignment[] {
  const presetByLower = new Map(taxonomy.map((label) => [label.name.toLowerCase(), label.name]));
  const seen = new Set<string>();
  const kept: LabelAssignment[] = [];
  for (const assignment of assignments) {
    const canonical = presetByLower.get(assignment.name.trim().toLowerCase());
    if (canonical === undefined) {
      receipt.discarded_assignments += 1;
      continue;
    }
    if (seen.has(canonical)) {
      receipt.discarded_assignments += 1;
      continue;
    }
    const evidenceValidation = validateEvidenceQuotes(assignment, memberTexts);
    if (!evidenceValidation.ok) {
      receipt.discarded_assignments += 1;
      continue;
    }
    seen.add(canonical);
    kept.push({ name: canonical, evidence: assignment.evidence });
  }
  return kept;
}

function acceptFreeLabel(
  assignment: LabelAssignment,
  memberTexts: ReadonlyMap<string, string>,
  store: EnrichStore,
  seen: ReadonlySet<string>,
): { name: string; keep: LabelAssignment } | undefined {
  const name = normalizeFreeLabelName(assignment.name);
  if (!validateFreeLabelName(name, assignment.evidence).ok) return undefined;
  if (seen.has(name)) return undefined;
  if (store.registryStatus(name) === "rejected") return undefined;
  if (!validateEvidenceQuotes(assignment, memberTexts).ok) return undefined;
  return { name, keep: { name, evidence: assignment.evidence } };
}

function validFreeLabels(
  assignments: readonly LabelAssignment[],
  memberTexts: ReadonlyMap<string, string>,
  store: EnrichStore,
  receipt: EnrichReceipt,
  registryEvents: FreeLabelEvent[],
): LabelAssignment[] {
  const seen = new Set<string>();
  const kept: LabelAssignment[] = [];
  for (const assignment of assignments) {
    if (kept.length >= MAX_FREE_LABELS_PER_UNIT) {
      receipt.discarded_assignments += 1;
      continue;
    }
    const accepted = acceptFreeLabel(assignment, memberTexts, store, seen);
    if (accepted === undefined) {
      receipt.discarded_assignments += 1;
      continue;
    }
    seen.add(accepted.name);
    kept.push(accepted.keep);
    if (registryEvents.some((event) => event.name === accepted.name)) continue;
    const candidate = store.candidateEventIfNew(accepted.name);
    if (candidate.created && candidate.event !== undefined) {
      receipt.new_candidates += 1;
      registryEvents.push(candidate.event);
    }
  }
  return kept;
}

async function persistAndApply(
  deps: EnrichWorkerDeps,
  batch: readonly QueueItem[],
  successful: readonly QueueItem[],
  rows: readonly EnrichmentRow[],
  registryEvents: readonly FreeLabelEvent[],
  receipt: EnrichReceipt,
  contractHash: string,
): Promise<boolean> {
  const nowIso = deps.now().toISOString();
  const events: AttemptEvent[] = successful.map((item) => ({
    unit_id: item.unitId,
    input_hash: item.inputHash,
    contract_hash: item.contractHash,
    attempt: item.attempts + 1,
    outcome: "success",
    at: nowIso,
    first_queued_at: item.firstQueuedAt,
  }));
  try {
    const lock = deps.lock ?? (async <T>(fn: () => Promise<T>): Promise<T> => fn());
    await lock(async () => {
      const stampedRegistryEvents = stampRegistryEvents(deps, registryEvents);
      await persistRowsAndEvents(deps, rows, events, stampedRegistryEvents);
      for (const event of stampedRegistryEvents) deps.enrichStore.applyRegistryEvent(event);
      for (const row of rows) deps.enrichStore.applyEnrichment(row);
    });
  } catch (error) {
    const errorText = errorMessage(error);
    const cls: ErrorClass = "commit_failed";
    for (const item of batch) {
      const nextRetry = backoffDate(deps.now(), item.attempts + 1, cls);
      await persistAttemptAndApply(deps, {
        unit_id: item.unitId,
        input_hash: item.inputHash,
        contract_hash: contractHash,
        attempt: item.attempts + 1,
        outcome: item.attempts + 1 >= 5 ? "blocked" : "commit_failed",
        error_class: cls,
        error_message: errorText,
        at: nowIso,
        first_queued_at: item.firstQueuedAt,
        next_retry_at: nextRetry.toISOString(),
      });
    }
    receipt.failures += batch.length;
    receipt.retries += batch.length;
    return false;
  }
  receipt.units += rows.length;
  return true;
}

/**
 * Events are allocated under the same lock as their dataset commit. A batch
 * can discover several labels, so `registryRevision() + 1` at construction
 * time is not a revision allocator.
 */
function stampRegistryEvents(
  deps: EnrichWorkerDeps,
  events: readonly FreeLabelEvent[],
): FreeLabelEvent[] {
  const base = deps.enrichStore.registryRevision();
  return events.map((event, index) => ({ ...event, registry_revision: base + index + 1 }));
}

async function failBatch(
  deps: EnrichWorkerDeps,
  batch: readonly QueueItem[],
  receipt: EnrichReceipt,
  error: string,
  errorClass: ErrorClass,
  contractHash: string,
): Promise<void> {
  const at = deps.now().toISOString();
  for (const item of batch) {
    const attempt = item.attempts + 1;
    const nextRetry = backoffDate(deps.now(), attempt, errorClass);
    const outcome: AttemptOutcome =
      attempt >= 5
        ? "blocked"
        : errorClass === "invalid_output"
          ? "invalid_output"
          : "transient_failure";
    await persistAttemptAndApply(deps, {
      unit_id: item.unitId,
      input_hash: item.inputHash,
      contract_hash: contractHash,
      attempt,
      outcome,
      error_class: errorClass,
      error_message: error,
      at,
      first_queued_at: item.firstQueuedAt,
      next_retry_at: nextRetry.toISOString(),
    });
    if (outcome === "blocked") receipt.blocked += 1;
  }
  receipt.failures += batch.length;
  receipt.retries += batch.length;
}

function backoffDate(now: Date, attempt: number, errorClass: ErrorClass): Date {
  if (errorClass === "commit_failed" || errorClass === "invalid_output") {
    if (attempt >= 5) return new Date(now.getTime() + BLOCKED_RETRY_MS);
  }
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = base * 0.2 * Math.random();
  return new Date(now.getTime() + base + jitter);
}

function classifyError(error: unknown): ErrorClass {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("timeout") || message.includes("timed out")) return "timeout";
    if (message.includes("rate")) return "rate_limit";
  }
  return "other";
}

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

function buildMessages(
  labels: readonly LabelConfig[],
  rejectedFreeLabels: readonly string[],
  units: readonly PromptUnit[],
): LlmMessage[] {
  const system = [
    "You classify batches of X/Twitter post units. Each unit is a root post",
    "plus the same author's self-replies. For every unit return exactly two",
    "arrays: preset_labels and free_labels. Both may be empty.",
    "",
    "Every label assignment must carry evidence: at least one {tweet_id,",
    "quote} record where tweet_id is a member of the unit and quote is a",
    "verbatim substring of that tweet's text. The system rejects any",
    "assignment whose quote is not a literal substring.",
    "",
    "Preset labels — use only these exact names, and only when they apply:",
    JSON.stringify(labels, null, 2),
    "",
    "Rules:",
    "- preset_labels: assignments whose `name` exactly matches a preset name.",
    `- free_labels: up to ${String(MAX_FREE_LABELS_PER_UNIT)} lowercase-dash names for specific subjects not covered by presets (e.g. "dgx-spark").`,
    "- Emoji-only replies, retweets without commentary and other units without",
    "  substantive subject should return no free labels.",
    "- Do not emit grammatical categories, discourse forms, pronoun",
    "  categories, quality/philosophy phrases, or industry abstractions",
    "  (manufacturing, technology, industry) unless the literal word is in",
    "  the evidence quote.",
    "- Reject any free label whose name matches these known-bad entries:",
    JSON.stringify(rejectedFreeLabels),
    "",
    "Respond with JSON only, exactly matching:",
    '{"units": {"<unit_id>": {"preset_labels": [{"name": "...", "evidence": [{"tweet_id": "...", "quote": "..."}]}], "free_labels": [{"name": "...", "evidence": [{"tweet_id": "...", "quote": "..."}]}]}}}',
  ].join("\n");
  const user = JSON.stringify({
    units: units.map((unit) => ({
      unit_id: unit.unitId,
      posts: unit.posts,
    })),
  });
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function persistRowsAndEvents(
  deps: EnrichWorkerDeps,
  rows: readonly EnrichmentRow[],
  events: readonly AttemptEvent[],
  registryEvents: readonly FreeLabelEvent[],
): Promise<void> {
  const byPath = new Map<string, string[]>();
  for (const row of rows) {
    const path = enrichmentPathFor(row.enriched_at);
    const bucket = byPath.get(path);
    if (bucket === undefined) byPath.set(path, [JSON.stringify(row)]);
    else bucket.push(JSON.stringify(row));
  }
  for (const event of events) {
    const path = attemptEventPathFor(event.at);
    const bucket = byPath.get(path);
    if (bucket === undefined) byPath.set(path, [JSON.stringify(event)]);
    else bucket.push(JSON.stringify(event));
  }
  for (const event of registryEvents) {
    const path = registryEventPathFor(event.at);
    const bucket = byPath.get(path);
    if (bucket === undefined) byPath.set(path, [JSON.stringify(event)]);
    else bucket.push(JSON.stringify(event));
  }
  await deps.mirror.commitBatch(
    [...byPath.entries()].map(([path, lines]) => ({ path, lines })),
    [],
    `enrich: ${String(rows.length)} units`,
  );
}

/**
 * Promote/reject only from already durable evidence. Hub verification and the
 * constrained review are injected so this module never reaches for ambient
 * credentials or turns a reviewer into another label generator.
 */
// eslint-disable-next-line complexity
async function settleRegistryDecisions(
  deps: EnrichWorkerDeps,
  receipt: EnrichReceipt,
): Promise<string | undefined> {
  const decisions: FreeLabelEvent[] = [];
  for (const name of deps.enrichStore.candidateNames()) {
    const stopped = ceilingHit(
      receipt,
      deps.ceilings ?? {},
      deps.now,
      receipt.started_at ? Date.parse(receipt.started_at) : deps.now().getTime(),
    );
    if (stopped !== undefined) return stopped;
    const signals = deps.enrichStore.promotionSignals(name);
    const assignments = deps.enrichStore.candidateAssignments(name);
    const eventQuotes = deps.enrichStore.candidateDetail(name)?.representative_quotes ?? [];
    if (deps.enrichStore.candidateAgeDays(name) >= 30) {
      const event = deps.enrichStore.rejectionEvent(name, "stale-below-threshold", eventQuotes);
      if (event !== undefined) decisions.push({ ...event, counts: signals });
      continue;
    }
    if (deps.enrichStore.nameAppearsInEvidence(name)) {
      if (signals.units >= 5 && signals.authors >= 3 && signals.days >= 2) {
        const event = deps.enrichStore.promotionEvent(
          name,
          "surface-evidence-threshold",
          eventQuotes,
        );
        if (event !== undefined) decisions.push({ ...event, counts: signals });
      }
      continue;
    }
    if (deps.verifyHubLabel !== undefined && (await deps.verifyHubLabel(name, assignments))) {
      const event = deps.enrichStore.promotionEvent(name, "verified-hub-reference", eventQuotes);
      if (event !== undefined) decisions.push({ ...event, counts: signals });
      continue;
    }
    if (
      signals.units >= 15 &&
      signals.authors >= 8 &&
      signals.days >= 2 &&
      deps.judgeFreeLabel !== undefined
    ) {
      const costStopped = costCallPreflight(receipt, deps.ceilings ?? {});
      if (costStopped !== undefined) return costStopped;
      const reviewed = await deps.judgeFreeLabel(
        name,
        assignments.flatMap((assignment) => assignment.evidence).slice(0, 20),
      );
      const verdict = recordReviewUsage(receipt, reviewed, deps.ceilings);
      if (deps.ceilings?.maxCostUsd !== undefined && receipt.cost_usd === undefined) {
        return "cost_unmeasured";
      }
      const event =
        verdict === true
          ? deps.enrichStore.promotionEvent(name, "constrained-review-approved", eventQuotes)
          : verdict === false
            ? deps.enrichStore.rejectionEvent(name, "constrained-review-rejected", eventQuotes)
            : undefined;
      if (event !== undefined) decisions.push({ ...event, counts: signals });
    }
  }
  if (decisions.length === 0) return undefined;
  const lock = deps.lock ?? (async <T>(fn: () => Promise<T>): Promise<T> => fn());
  await lock(async () => {
    const stamped = stampRegistryEvents(deps, decisions);
    await persistRowsAndEvents(deps, [], [], stamped);
    for (const event of stamped) deps.enrichStore.applyRegistryEvent(event);
  });
  receipt.new_approvals += decisions.filter((event) => event.status === "approved").length;
  receipt.new_rejections += decisions.filter((event) => event.status === "rejected").length;
  return undefined;
}

function recordReviewUsage(
  receipt: EnrichReceipt,
  result: FreeLabelJudgeResult,
  ceilings: WorkerCeilings | undefined,
): boolean | undefined {
  if (typeof result === "boolean" || result === undefined) return result;
  receipt.calls += 1;
  receipt.prompt_tokens += result.usage.prompt_tokens;
  receipt.completion_tokens += result.usage.completion_tokens;
  if (result.usage.cost_usd === undefined && ceilings?.maxCostUsd !== undefined) {
    receipt.cost_usd = undefined;
  } else {
    receipt.cost_usd = (receipt.cost_usd ?? 0) + (result.usage.cost_usd ?? 0);
  }
  return result.verdict;
}

async function persistAttemptAndApply(deps: EnrichWorkerDeps, event: AttemptEvent): Promise<void> {
  const validated = attemptEventSchema.parse(event);
  const lock = deps.lock ?? (async <T>(fn: () => Promise<T>): Promise<T> => fn());
  await lock(async () => {
    await deps.mirror.commitBatch(
      [{ path: attemptEventPathFor(validated.at), lines: [JSON.stringify(validated)] }],
      [],
      `enrich: attempt ${validated.unit_id.slice(0, 40)}`,
    );
    deps.enrichStore.replayAttemptEvent(validated);
  });
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
