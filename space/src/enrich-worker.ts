import { Buffer } from "node:buffer";
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
const PROMPT_TOKEN_OVERHEAD = 256;
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
export type LlmCallOptions = { maxCompletionTokens?: number };

export type LlmClient = (
  messages: readonly LlmMessage[],
  options?: LlmCallOptions,
) => Promise<LlmResult>;
export type LlmPricing = { inputTokenUsd: number; outputTokenUsd: number };

const routerResponseSchema = z.looseObject({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .loose(),
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
  return async (
    messages: readonly LlmMessage[],
    callOptions?: LlmCallOptions,
  ): Promise<LlmResult> => {
    const response = await fetchWithTimeout(fetchFn, options, messages, timeoutMs, callOptions);
    return handleRouterResponse(response, options.pricing);
  };
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  options: { hfToken: string; model: string },
  messages: readonly LlmMessage[],
  timeoutMs: number,
  callOptions?: LlmCallOptions,
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
        ...(callOptions?.maxCompletionTokens === undefined
          ? {}
          : { max_tokens: callOptions.maxCompletionTokens }),
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
      prompt_tokens: parsed.usage.prompt_tokens,
      completion_tokens: parsed.usage.completion_tokens,
      ...(cost === undefined ? {} : { cost_usd: cost }),
    },
  };
}

// eslint-disable-next-line complexity -- Provider-reported and configured pricing paths are validated together to fail closed.
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
  return async (name, evidence, maxTokens) => {
    const bounded = evidence.slice(0, 12).map((item) => ({
      tweet_id: item.tweet_id,
      quote: item.quote.slice(0, 300),
    }));
    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          'Review one existing free-label candidate. Decide only whether this exact name is a specific, useful AI or local-model subject supported by the supplied quotes. Do not propose, rename, or classify labels. Return strict JSON only: {"decision":"approve"|"reject"|"abstain"}.',
      },
      { role: "user", content: JSON.stringify({ name, evidence: bounded }) },
    ];
    const maxCompletionTokens = completionTokensForRemaining(messages, maxTokens);
    if (maxCompletionTokens === 0) {
      return {
        verdict: undefined,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        stopped_by: "max_tokens" as const,
      };
    }
    const result = await llm(
      messages,
      maxCompletionTokens === undefined ? undefined : { maxCompletionTokens },
    );
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
  | boolean
  | undefined
  | {
      verdict: boolean | undefined;
      usage: LlmUsage;
      stopped_by?: "max_tokens";
    };

export type FreeLabelJudge = (
  name: string,
  evidence: readonly { tweet_id: string; quote: string }[],
  maxTokens?: number,
) => Promise<FreeLabelJudgeResult>;

export type EnrichWorkerDeps = {
  enrichStore: EnrichStore;
  mirror: DatasetMirror;
  taxonomy: EnrichTaxonomy;
  llm: LlmClient;
  model: string;
  maxUnitsPerTick: number;
  /** Maximum simultaneous provider requests in this one physical Job. */
  maxConcurrentCalls?: number;
  unitsPerCall?: number;
  now: () => Date;
  workerId?: string;
  writeEmptyReceipt?: boolean;
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

function initReceipt(
  contractHash: string,
  workerId: string,
  now: () => Date,
  configuredConcurrency: number,
): EnrichReceipt {
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
    configured_concurrency: configuredConcurrency,
    peak_concurrency: 0,
    provider_backoffs: 0,
    reservation_peak_usd: 0,
    commit_queue_peak: 0,
  };
}

// eslint-disable-next-line complexity -- One transaction-aware coordinator must enforce all shared run ceilings and durable transitions.
export async function runEnrichTick(deps: EnrichWorkerDeps): Promise<EnrichReceipt> {
  const workerId = deps.workerId ?? randomUUID();
  const maxConcurrentCalls = configuredConcurrency(deps.maxConcurrentCalls);
  const contractHash = contractHashFor(deps);
  deps.enrichStore.setContractHash(contractHash);
  const receipt = initReceipt(contractHash, workerId, deps.now, maxConcurrentCalls);
  deps.enrichStore.recoverExpiredLeases();
  const claimed = deps.enrichStore.claimBatch({
    limit: deps.maxUnitsPerTick,
    workerId,
    leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS,
  });
  try {
    const size = deps.unitsPerCall ?? DEFAULT_UNITS_PER_CALL;
    const startedAt = deps.now().getTime();
    const stopped = await drainClaimed(
      deps,
      claimed,
      size,
      receipt,
      contractHash,
      startedAt,
      maxConcurrentCalls,
    );
    if (stopped !== undefined) receipt.stopped_by = stopped;
    const completedCeiling = ceilingHit(receipt, deps.ceilings ?? {}, deps.now, startedAt);
    if (completedCeiling !== undefined) receipt.stopped_by ??= completedCeiling;
    const registryStopped = await settleRegistryDecisions(deps, receipt);
    if (receipt.stopped_by === undefined && registryStopped !== undefined) {
      receipt.stopped_by = registryStopped;
    }
    receipt.finished_at = deps.now().toISOString();
    if (deps.writeEmptyReceipt === true || hasReceiptActivity(receipt)) {
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

function configuredConcurrency(value: number | undefined): number {
  const configured = value ?? 1;
  if (!Number.isInteger(configured) || configured < 1 || configured > 32) {
    throw new Error("maxConcurrentCalls must be an integer from 1 through 32.");
  }
  return configured;
}

async function drainClaimed(
  deps: EnrichWorkerDeps,
  claimed: readonly QueueItem[],
  size: number,
  receipt: EnrichReceipt,
  contractHash: string,
  startedAt: number,
  maxConcurrentCalls: number,
): Promise<string | undefined> {
  if (maxConcurrentCalls === 1) {
    return drainClaimedSequential(deps, claimed, size, receipt, contractHash, startedAt);
  }
  return drainClaimedConcurrent(
    deps,
    claimed,
    size,
    receipt,
    contractHash,
    startedAt,
    maxConcurrentCalls,
  );
}

async function drainClaimedSequential(
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
    const batchStopped = await processBatch(deps, batch, receipt, contractHash);
    if (batchStopped !== undefined) return batchStopped;
    start += batch.length;
  }
  return undefined;
}

type PreparedBatch = {
  batch: readonly QueueItem[];
  units: readonly PromptUnit[];
  messages: readonly LlmMessage[];
  maxCompletionTokens?: number;
};

/**
 * Starts a full bounded wave immediately, then commits its outcomes in the
 * original dispatch order. Keeping the commit lane ordered preserves durable
 * registry revisions while one slow provider request naturally backpressures
 * the next wave.
 */
// eslint-disable-next-line complexity -- Concurrent admission coordinates every shared ceiling, reservation, outcome, and ordered commit.
async function drainClaimedConcurrent(
  deps: EnrichWorkerDeps,
  claimed: readonly QueueItem[],
  size: number,
  receipt: EnrichReceipt,
  contractHash: string,
  startedAt: number,
  configured: number,
): Promise<string | undefined> {
  const ceilings = deps.ceilings ?? {};
  let start = 0;
  let activeLimit = configured;
  let stoppedBy: string | undefined;
  while (start < claimed.length && stoppedBy === undefined) {
    const ceiling = ceilingHit(receipt, ceilings, deps.now, startedAt);
    if (ceiling !== undefined) return ceiling;
    const wave: PreparedBatch[] = [];
    let reservedCostUsd = 0;
    let reservedTokens = 0;
    let reservedUnits = 0;
    while (wave.length < activeLimit && start + reservedUnits < claimed.length) {
      const costStopped = costCallPreflight(receipt, ceilings, reservedCostUsd);
      if (costStopped !== undefined) {
        // Settle an affordable partial wave before declaring the run exhausted.
        // A full wave may not fit even though one or more calls still do.
        if (wave.length === 0) stoppedBy = costStopped;
        break;
      }
      const remainingUnits =
        ceilings.maxUnits === undefined
          ? size
          : Math.min(size, ceilings.maxUnits - unitsProcessed(receipt) - reservedUnits);
      if (remainingUnits <= 0) {
        stoppedBy = "max_units";
        break;
      }
      const batch = claimed.slice(start + reservedUnits, start + reservedUnits + remainingUnits);
      const units = batch.map((item) => ({
        unitId: item.unitId,
        posts: promptPosts(deps, item.unitId),
      }));
      const messages = messagesForUnits(deps, units);
      const maxCompletionTokens = concurrentCompletionTokenLimit(
        messages,
        receipt,
        ceilings,
        reservedTokens,
        wave.length,
        activeLimit,
      );
      if (maxCompletionTokens === 0) {
        if (wave.length === 0 && activeLimit > 1) {
          // A smaller wave may fit under the remaining token ceiling. Do not
          // release and repeatedly reclaim this head batch without trying it.
          activeLimit = Math.max(1, Math.floor(activeLimit / 2));
          continue;
        }
        if (wave.length === 0) {
          // Reuse the sequential splitter/blocker when even one slot cannot
          // admit this batch, so a truly oversized unit cannot stall later Jobs.
          const batchStopped = await processBatch(deps, batch, receipt, contractHash, true);
          start += batch.length;
          if (batchStopped !== undefined) return batchStopped;
          break;
        }
        stoppedBy = "max_tokens";
        break;
      }
      wave.push({
        batch,
        units,
        messages,
        ...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
      });
      reservedUnits += batch.length;
      reservedTokens += promptTokenUpperBound(messages) + (maxCompletionTokens ?? 0);
      reservedCostUsd += ceilings.maxCostPerCallUsd ?? 0;
    }
    if (wave.length === 0) {
      if (stoppedBy !== undefined) return stoppedBy;
      // A token-split fallback settled the head batch; continue with the
      // remaining claimed units rather than ending the tick prematurely.
      continue;
    }
    receipt.peak_concurrency = Math.max(receipt.peak_concurrency ?? 0, wave.length);
    receipt.commit_queue_peak = Math.max(receipt.commit_queue_peak ?? 0, wave.length);
    receipt.reservation_peak_usd = Math.max(receipt.reservation_peak_usd ?? 0, reservedCostUsd);
    await persistDispatchReservations(deps, wave, ceilings);
    const outcomes = await Promise.all(
      wave.map((prepared) => callLlm(deps, prepared.messages, prepared.maxCompletionTokens)),
    );
    for (const [index, prepared] of wave.entries()) {
      const outcome = outcomes[index];
      if (outcome === undefined) throw new Error("missing concurrent provider outcome");
      const batchStopped = await settleLlmOutcome(
        deps,
        prepared.batch,
        prepared.units,
        recordLlmOutcome(receipt, outcome, ceilings),
        receipt,
        contractHash,
      );
      if (isProviderPressure(outcome)) {
        activeLimit = Math.max(1, Math.floor(activeLimit / 2));
        receipt.provider_backoffs = (receipt.provider_backoffs ?? 0) + 1;
      }
      stoppedBy ??= batchStopped;
    }
    start += reservedUnits;
  }
  return stoppedBy;
}

function concurrentCompletionTokenLimit(
  messages: readonly LlmMessage[],
  receipt: EnrichReceipt,
  ceilings: WorkerCeilings,
  reservedTokens: number,
  reservedCalls: number,
  activeLimit: number,
): number | undefined {
  if (ceilings.maxTokens === undefined) return undefined;
  const slots = Math.max(1, activeLimit - reservedCalls);
  const remaining = ceilings.maxTokens - tokensUsed(receipt) - reservedTokens;
  return Math.max(0, Math.floor(remaining / slots) - promptTokenUpperBound(messages));
}

function isProviderPressure(outcome: LlmOutcome): boolean {
  return (
    !outcome.ok &&
    "errorClass" in outcome &&
    (outcome.errorClass === "timeout" ||
      outcome.errorClass === "rate_limit" ||
      outcome.errorClass === "provider_5xx")
  );
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
  return deps.enrichStore.unitSemanticMembers(unitId).map((member) => ({
    tweet_id: member.id,
    text: member.text,
    conversation_id: member.conversation_id,
    author_id: member.author_id,
    author_username: member.author_username,
    reply_to: member.reply_to,
    quoted_status_id: member.quoted_status_id,
    expanded_urls: member.expanded_urls,
    is_subscriber_only: member.is_subscriber_only,
    is_retweet: member.is_retweet,
  }));
}

function tokensUsed(receipt: EnrichReceipt): number {
  return receipt.prompt_tokens + receipt.completion_tokens;
}

function promptTokenUpperBound(messages: readonly LlmMessage[]): number {
  return (
    PROMPT_TOKEN_OVERHEAD +
    messages.reduce(
      (total, message) =>
        total + Buffer.byteLength(message.role) + Buffer.byteLength(message.content),
      0,
    )
  );
}

function completionTokensForRemaining(
  messages: readonly LlmMessage[],
  remainingTokens: number | undefined,
): number | undefined {
  if (remainingTokens === undefined) return undefined;
  return Math.max(0, Math.floor(remainingTokens - promptTokenUpperBound(messages)));
}

function completionTokenLimit(
  messages: readonly LlmMessage[],
  receipt: EnrichReceipt,
  ceilings: WorkerCeilings | undefined,
): number | undefined {
  const remaining =
    ceilings?.maxTokens === undefined ? undefined : ceilings.maxTokens - tokensUsed(receipt);
  return completionTokensForRemaining(messages, remaining);
}

function errorRate(receipt: EnrichReceipt): number {
  const processed = unitsProcessed(receipt);
  return processed === 0 ? 0 : receipt.failures / processed;
}

function qualityCeilingHit(receipt: EnrichReceipt, ceilings: WorkerCeilings): string | undefined {
  if (
    ceilings.maxErrorRate !== undefined &&
    receipt.failures > 0 &&
    errorRate(receipt) >= ceilings.maxErrorRate
  ) {
    return "max_error_rate";
  }
  if (
    ceilings.maxDiscardedAssignments !== undefined &&
    receipt.discarded_assignments > 0 &&
    receipt.discarded_assignments >= ceilings.maxDiscardedAssignments
  ) {
    return "max_discarded_assignments";
  }
  return undefined;
}

function ceilingHit(
  receipt: EnrichReceipt,
  ceilings: WorkerCeilings,
  now: () => Date,
  startedAt: number,
): string | undefined {
  if (ceilings.maxCostUsd !== undefined && receipt.cost_usd === undefined) return "cost_unmeasured";
  const qualityStopped = qualityCeilingHit(receipt, ceilings);
  if (qualityStopped !== undefined) return qualityStopped;
  const checks: [number | undefined, number, string][] = [
    [ceilings.maxUnits, unitsProcessed(receipt), "max_units"],
    [ceilings.maxTokens, tokensUsed(receipt), "max_tokens"],
    [ceilings.maxElapsedMs, now().getTime() - startedAt, "max_elapsed"],
    [ceilings.maxCostUsd, receipt.cost_usd ?? 0, "max_cost_usd"],
  ];
  for (const [limit, current, name] of checks) {
    if (limit !== undefined && current >= limit) return name;
  }
  return undefined;
}

function costCallPreflight(
  receipt: EnrichReceipt,
  ceilings: WorkerCeilings,
  reservedCostUsd = 0,
): string | undefined {
  if (ceilings.maxCostUsd === undefined) return undefined;
  if (receipt.cost_usd === undefined || ceilings.maxCostPerCallUsd === undefined) {
    return "cost_unmeasured";
  }
  return receipt.cost_usd + reservedCostUsd + ceilings.maxCostPerCallUsd > ceilings.maxCostUsd
    ? "max_cost_usd"
    : undefined;
}

async function processBatch(
  deps: EnrichWorkerDeps,
  batch: readonly QueueItem[],
  receipt: EnrichReceipt,
  contractHash: string,
  reserveDispatch = false,
): Promise<string | undefined> {
  const units: PromptUnit[] = batch.map((item) => ({
    unitId: item.unitId,
    posts: promptPosts(deps, item.unitId),
  }));
  const messages = messagesForUnits(deps, units);
  const maxCompletionTokens = completionTokenLimit(messages, receipt, deps.ceilings);
  if (maxCompletionTokens === 0) {
    return handlePromptTokenStop(deps, batch, units, receipt, contractHash, reserveDispatch);
  }
  if (reserveDispatch) {
    await persistDispatchReservations(
      deps,
      [
        {
          batch,
          units,
          messages,
          ...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
        },
      ],
      deps.ceilings ?? {},
    );
  }
  const outcome = recordLlmOutcome(
    receipt,
    await callLlm(deps, messages, maxCompletionTokens),
    deps.ceilings ?? {},
  );
  return settleLlmOutcome(deps, batch, units, outcome, receipt, contractHash);
}

type LlmOutcome =
  | { ok: true; content: string; usage: LlmUsage }
  | { ok: false; error: string; errorClass: ErrorClass };

async function settleLlmOutcome(
  deps: EnrichWorkerDeps,
  batch: readonly QueueItem[],
  units: readonly PromptUnit[],
  outcome: LlmOutcome,
  receipt: EnrichReceipt,
  contractHash: string,
): Promise<string | undefined> {
  if (!outcome.ok) {
    await failBatch(deps, batch, receipt, outcome.error, outcome.errorClass, contractHash);
    return undefined;
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
    return undefined;
  }
  await settleBatch(deps, batch, units, parsed, receipt, contractHash);
  return undefined;
}

async function handlePromptTokenStop(
  deps: EnrichWorkerDeps,
  batch: readonly QueueItem[],
  units: readonly PromptUnit[],
  receipt: EnrichReceipt,
  contractHash: string,
  reserveDispatch: boolean,
): Promise<string | undefined> {
  if (batch.length > 1) {
    const middle = Math.ceil(batch.length / 2);
    const firstStopped = await processBatch(
      deps,
      batch.slice(0, middle),
      receipt,
      contractHash,
      reserveDispatch,
    );
    if (firstStopped !== undefined) return firstStopped;
    return processBatch(deps, batch.slice(middle), receipt, contractHash, reserveDispatch);
  }
  const item = batch[0];
  if (item !== undefined && unitPromptExceedsRunCeiling(deps, units)) {
    await blockOversizedUnit(deps, item, receipt, contractHash);
    return undefined;
  }
  return "max_tokens";
}

function messagesForUnits(deps: EnrichWorkerDeps, units: readonly PromptUnit[]): LlmMessage[] {
  const rejected = [...new Set([...HARD_REJECTED_NAMES, ...deps.enrichStore.rejectedNames()])].sort(
    (left, right) => left.localeCompare(right),
  );
  return buildMessages(deps.taxonomy.labels, rejected, units);
}

function unitPromptExceedsRunCeiling(
  deps: EnrichWorkerDeps,
  units: readonly PromptUnit[],
): boolean {
  const maxTokens = deps.ceilings?.maxTokens;
  return (
    maxTokens !== undefined &&
    maxTokens > 0 &&
    completionTokensForRemaining(messagesForUnits(deps, units), maxTokens) === 0
  );
}

async function callLlm(
  deps: EnrichWorkerDeps,
  messages: readonly LlmMessage[],
  maxCompletionTokens: number | undefined,
): Promise<LlmOutcome> {
  try {
    const result = await deps.llm(
      messages,
      maxCompletionTokens === undefined ? undefined : { maxCompletionTokens },
    );
    return { ok: true, content: result.content, usage: result.usage };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      errorClass: error instanceof RouterError ? error.errorClass : classifyError(error),
    };
  }
}

/**
 * Publish a retryable dispatch record before spending provider capacity. If the
 * process dies before a final outcome is committed, rebuild delays reissue
 * until this reservation's request window has passed.
 */
async function persistDispatchReservations(
  deps: EnrichWorkerDeps,
  wave: readonly PreparedBatch[],
  ceilings: WorkerCeilings,
): Promise<void> {
  const at = deps.now();
  const retryAt = new Date(at.getTime() + DEFAULT_REQUEST_TIMEOUT_MS).toISOString();
  const events: AttemptEvent[] = wave.flatMap((prepared) =>
    prepared.batch.map((item, index) => ({
      unit_id: item.unitId,
      input_hash: item.inputHash,
      contract_hash: item.contractHash,
      attempt: item.attempts + 1,
      outcome: "dispatched" as const,
      error_message: "provider dispatch reserved before request",
      at: at.toISOString(),
      first_queued_at: item.firstQueuedAt,
      next_retry_at: retryAt,
      ...(index === 0 && ceilings.maxCostPerCallUsd !== undefined
        ? { reserved_cost_usd: ceilings.maxCostPerCallUsd }
        : {}),
    })),
  );
  const lock = deps.lock ?? (async <T>(fn: () => Promise<T>): Promise<T> => fn());
  await lock(() => persistRowsAndEvents(deps, [], events, []));
}

/** Apply observed provider accounting only in durable commit order. */
// eslint-disable-next-line complexity -- Success, missing-cost, and conservative-failure accounting share one ordered boundary.
function recordLlmOutcome(
  receipt: EnrichReceipt,
  outcome: LlmOutcome,
  ceilings: WorkerCeilings,
): LlmOutcome {
  receipt.calls += 1;
  if (!outcome.ok) {
    if (ceilings.maxCostUsd !== undefined) {
      if (receipt.cost_usd === undefined || ceilings.maxCostPerCallUsd === undefined) {
        receipt.cost_usd = undefined;
      } else {
        // The provider may have accepted work before a timeout or 5xx response.
        // Charge the reservation so later waves cannot spend it again.
        receipt.cost_usd += ceilings.maxCostPerCallUsd;
      }
    }
    return outcome;
  }
  receipt.prompt_tokens += outcome.usage.prompt_tokens;
  receipt.completion_tokens += outcome.usage.completion_tokens;
  if (outcome.usage.cost_usd === undefined && ceilings.maxCostUsd !== undefined) {
    receipt.cost_usd = undefined;
    return { ok: false, error: "provider cost could not be measured", errorClass: "other" };
  }
  // A concurrent earlier outcome may already have made the run's cost
  // unmeasurable. Never turn that fail-closed sentinel back into a number.
  if (ceilings.maxCostUsd !== undefined && receipt.cost_usd === undefined) return outcome;
  receipt.cost_usd = (receipt.cost_usd ?? 0) + (outcome.usage.cost_usd ?? 0);
  return outcome;
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
    deps.taxonomy.labels,
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
  presetNames: ReadonlySet<string>,
): { name: string; keep: LabelAssignment } | undefined {
  const name = normalizeFreeLabelName(assignment.name);
  if (!validateFreeLabelName(name, assignment.evidence).ok) return undefined;
  if (seen.has(name) || presetNames.has(name)) return undefined;
  if (store.registryStatus(name) === "rejected") return undefined;
  if (!validateEvidenceQuotes(assignment, memberTexts).ok) return undefined;
  return { name, keep: { name, evidence: assignment.evidence } };
}

function validFreeLabels(
  assignments: readonly LabelAssignment[],
  taxonomy: readonly LabelConfig[],
  memberTexts: ReadonlyMap<string, string>,
  store: EnrichStore,
  receipt: EnrichReceipt,
  registryEvents: FreeLabelEvent[],
): LabelAssignment[] {
  const seen = new Set<string>();
  const presetNames = new Set(taxonomy.map((label) => normalizeFreeLabelName(label.name)));
  const kept: LabelAssignment[] = [];
  for (const assignment of assignments) {
    if (kept.length >= MAX_FREE_LABELS_PER_UNIT) {
      receipt.discarded_assignments += 1;
      continue;
    }
    const accepted = acceptFreeLabel(assignment, memberTexts, store, seen, presetNames);
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

async function blockOversizedUnit(
  deps: EnrichWorkerDeps,
  item: QueueItem,
  receipt: EnrichReceipt,
  contractHash: string,
): Promise<void> {
  const at = deps.now();
  await persistAttemptAndApply(deps, {
    unit_id: item.unitId,
    input_hash: item.inputHash,
    contract_hash: contractHash,
    attempt: item.attempts + 1,
    outcome: "blocked",
    error_class: "other",
    error_message: "unit prompt exceeds the configured full-run token ceiling",
    at: at.toISOString(),
    first_queued_at: item.firstQueuedAt,
    next_retry_at: new Date(at.getTime() + BLOCKED_RETRY_MS).toISOString(),
  });
  receipt.failures += 1;
  receipt.retries += 1;
  receipt.blocked += 1;
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
// eslint-disable-next-line complexity -- Registry settlement applies all promotion, rejection, review, evidence, and ceiling rules together.
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
      const remainingTokens =
        deps.ceilings?.maxTokens === undefined
          ? undefined
          : deps.ceilings.maxTokens - tokensUsed(receipt);
      const reviewed = await deps.judgeFreeLabel(
        name,
        assignments.flatMap((assignment) => assignment.evidence).slice(0, 20),
        remainingTokens,
      );
      if (typeof reviewed === "object" && reviewed.stopped_by !== undefined) {
        return reviewed.stopped_by;
      }
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
