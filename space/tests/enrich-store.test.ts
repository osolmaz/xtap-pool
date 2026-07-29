import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeContractHash, computeInputHash, PROCESSOR_VERSION } from "@xtap-pool/shared";
import type { EnrichmentRow, LabelAssignment } from "@xtap-pool/shared";

import { EnrichStore, MAX_ATTEMPTS } from "../src/enrich-store.js";
import { TweetStore } from "../src/store.js";
import { makePooled } from "./helpers.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const TAXONOMY = [{ name: "ai", description: "d" }];
const CONTRACT_HASH = computeContractHash({
  taxonomy_version: 1,
  labels: TAXONOMY,
  model: "test-model",
  processor_version: PROCESSOR_VERSION,
  prompt_template_id: "labels-and-free-labels-v1",
  output_schema_id: "assignments-v1",
  normalization_id: "free-label-registry-v1",
});

let store: TweetStore;
let enrich: EnrichStore;

beforeEach(() => {
  store = new TweetStore();
  enrich = new EnrichStore(store.database, 1, () => NOW, CONTRACT_HASH);
});

afterEach(() => {
  store.close();
});

function insertAndRegister(overridesList: readonly Record<string, unknown>[]): string[] {
  const tweets = overridesList.map((overrides) => makePooled(overrides));
  store.insert(tweets);
  return enrich.registerTweets(tweets);
}

function defaultAssignments(unitId: string): {
  presetLabels: LabelAssignment[];
  freeLabels: LabelAssignment[];
  memberIds: string[];
} {
  const members = enrich.unitSemanticMembers(unitId);
  const memberIds = members.map((member) => member.id);
  const firstId = memberIds[0] ?? "100";
  const firstText = enrich.unitTweetTexts(unitId).get(firstId) ?? "hello world";
  return {
    memberIds,
    presetLabels: [
      { name: "ai", evidence: [{ tweet_id: firstId, quote: firstText.slice(0, 10) }] },
    ],
    freeLabels: [
      { name: "dgx-spark", evidence: [{ tweet_id: firstId, quote: firstText.slice(0, 5) }] },
    ],
  };
}

/** Build a valid evidence-bearing row for a unit's current members. */
function row(overrides: Partial<EnrichmentRow> = {}): EnrichmentRow {
  const unitId = overrides.unit_id ?? "100:someone";
  const defaults = defaultAssignments(unitId);
  const members = enrich.unitSemanticMembers(unitId);
  const inputHash =
    overrides.input_hash ?? (members.length > 0 ? computeInputHash(unitId, members) : "no-members");
  return {
    unit_id: unitId,
    tweet_ids: overrides.tweet_ids ? [...overrides.tweet_ids] : defaults.memberIds,
    input_hash: inputHash,
    contract_hash: CONTRACT_HASH,
    preset_labels: overrides.preset_labels ?? defaults.presetLabels,
    free_labels: overrides.free_labels ?? defaults.freeLabels,
    model: "test-model",
    taxonomy_version: 1,
    enriched_at: NOW.toISOString(),
    ...overrides,
  };
}

function recordCandidate(name: string): void {
  const candidate = enrich.candidateEventIfNew(name).event;
  if (candidate === undefined) throw new Error("expected a new candidate event");
  enrich.applyRegistryEvent(candidate);
}

describe("unit derivation and enqueue", () => {
  it("groups a root post and same-author replies into one unit", () => {
    const enqueued = insertAndRegister([
      { id: "1", conversation_id: "1", author: { username: "Karpathy" } },
      { id: "2", conversation_id: "1", author: { username: "karpathy" } },
      { id: "3", conversation_id: "1", author: { username: "swyx" } },
      { id: "4" },
    ]);
    expect(enqueued).toEqual(["1:karpathy", "1:swyx", "4:someone"]);
    expect(enrich.unitMemberIds("1:karpathy")).toEqual(["1", "2"]);
    const claimed = enrich.claimQueued(10);
    expect(claimed.map((item) => item.unitId).sort()).toEqual([
      "1:karpathy",
      "1:swyx",
      "4:someone",
    ]);
    const karpathy = claimed.find((item) => item.unitId === "1:karpathy");
    expect(karpathy?.tweetIds).toEqual(["1", "2"]);
    expect(karpathy?.inputHash.length).toBeGreaterThan(10);
    expect(karpathy?.contractHash).toBe(CONTRACT_HASH);
  });

  it("reports the current unique durable enrichment row count", () => {
    insertAndRegister([{ id: "100" }, { id: "101" }]);
    enrich.applyEnrichment(row());
    enrich.applyEnrichment(row({ unit_id: "101:someone", tweet_ids: ["101"] }));
    enrich.applyEnrichment(row());

    expect(enrich.enrichmentRowCount()).toBe(2);
    enrich.clearForRebuild();
    expect(enrich.enrichmentRowCount()).toBe(0);
  });

  it("does not re-enqueue an enriched unit on duplicate re-capture", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.applyEnrichment(row());
    expect(enrich.queueEntry("100:someone")?.status).toBe("done");
    insertAndRegister([{ id: "100" }]);
    expect(enrich.queueEntry("100:someone")?.status).toBe("done");
  });

  it("re-enqueues an enriched unit when a new tweet joins it", () => {
    insertAndRegister([{ id: "100", conversation_id: "100" }]);
    enrich.applyEnrichment(row());
    insertAndRegister([{ id: "101", conversation_id: "100" }]);
    const entry = enrich.queueEntry("100:someone");
    expect(entry?.status).toBe("pending");
    expect(entry?.attempts).toBe(0);
  });

  it("re-enqueues stale units after a taxonomy bump", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.applyEnrichment(row());
    const bumpedContract = computeContractHash({
      taxonomy_version: 2,
      labels: TAXONOMY,
      model: "test-model",
      processor_version: PROCESSOR_VERSION,
      prompt_template_id: "labels-and-free-labels-v1",
      output_schema_id: "assignments-v1",
      normalization_id: "free-label-registry-v1",
    });
    const bumped = new EnrichStore(store.database, 2, () => NOW, bumpedContract);
    bumped.registerTweets([makePooled({ id: "100" })]);
    expect(bumped.queueEntry("100:someone")?.status).toBe("pending");
  });

  it("resets retry state when the contract hash changes", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.markTransientFailure("100:someone", "boom", "other", NOW);
    expect(enrich.queueEntry("100:someone")?.attempts).toBe(1);
    enrich.setContractHash("different-contract");
    const after = enrich.queueEntry("100:someone");
    expect(after?.status).toBe("pending");
    expect(after?.attempts).toBe(0);
    expect(after?.contractHash).toBe("different-contract");
  });

  it("withholds completed assignments immediately when the contract changes", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.applyEnrichment(row());
    enrich.recordCandidateIfNew("test-label");
    expect(enrich.visibleAssignments(["100:someone"]).has("100:someone")).toBe(true);
    expect(enrich.registrySnapshot()).not.toEqual([]);

    enrich.setContractHash("different-contract");

    expect(enrich.queueEntry("100:someone")?.status).toBe("pending");
    expect(enrich.visibleAssignments(["100:someone"]).has("100:someone")).toBe(false);
    expect(enrich.registrySnapshot()).toEqual([]);
  });
});

describe("queue state machine", () => {
  it("requeues transient failures up to MAX_ATTEMPTS-1 then marks blocked", () => {
    insertAndRegister([{ id: "100" }]);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      enrich.markTransientFailure("100:someone", "boom", "timeout", NOW);
      expect(enrich.queueEntry("100:someone")?.status).toBe("retrying");
    }
    enrich.markTransientFailure("100:someone", "final", "timeout", NOW);
    const final = enrich.queueEntry("100:someone");
    expect(final?.status).toBe("blocked");
    expect(final?.attempts).toBe(MAX_ATTEMPTS);
    expect(final?.lastError).toBe("final");
  });

  it("persists source-derived queue age through attempt replay", () => {
    insertAndRegister([{ id: "100", captured_at: "2026-05-21T03:04:35.954Z" }]);
    const before = enrich.queueEntry("100:someone");
    expect(before?.firstQueuedAt).toBe("2026-05-21T03:04:35.954Z");
    enrich.replayAttemptEvent({
      unit_id: "100:someone",
      input_hash: before?.inputHash ?? "missing",
      contract_hash: CONTRACT_HASH,
      attempt: 1,
      outcome: "transient_failure",
      error_class: "timeout",
      at: NOW.toISOString(),
      first_queued_at: "2026-05-20T00:00:00.000Z",
      next_retry_at: NOW.toISOString(),
    });
    expect(enrich.queueEntry("100:someone")?.firstQueuedAt).toBe("2026-05-20T00:00:00.000Z");
  });

  it("replays an unsettled dispatch without consuming an attempt", () => {
    insertAndRegister([{ id: "100" }]);
    const before = enrich.queueEntry("100:someone");
    enrich.replayAttemptEvent({
      unit_id: "100:someone",
      input_hash: before?.inputHash ?? "missing",
      contract_hash: CONTRACT_HASH,
      attempt: 1,
      outcome: "dispatched",
      error_message: "provider dispatch reserved before request",
      at: NOW.toISOString(),
      next_retry_at: new Date(NOW.getTime() + 60_000).toISOString(),
      reserved_cost_usd: 0.25,
    });
    const after = enrich.queueEntry("100:someone");
    expect(after).toMatchObject({ status: "retrying", attempts: 0 });
    expect(enrich.claimQueued(10)).toHaveLength(0);
  });

  it("skips claim until next_retry_at has passed", () => {
    insertAndRegister([{ id: "100" }]);
    const future = new Date(NOW.getTime() + 60_000);
    enrich.markTransientFailure("100:someone", "boom", "timeout", future);
    expect(enrich.claimQueued(10)).toHaveLength(0);
  });

  it("reclaims blocked units for their infrequent scheduled retry", () => {
    insertAndRegister([{ id: "100" }]);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      enrich.markTransientFailure("100:someone", "boom", "timeout", NOW);
    }
    expect(enrich.queueEntry("100:someone")?.status).toBe("blocked");
    expect(enrich.claimQueued(10)).toHaveLength(1);
    expect(enrich.queueEntry("100:someone")?.status).toBe("running");
  });

  it("does not settle the queue for rows from another taxonomy version", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.applyEnrichment(row({ taxonomy_version: 2 }));
    expect(enrich.queueEntry("100:someone")?.status).toBe("pending");
  });

  it("does not settle the queue for rows tagged with a stale contract", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.applyEnrichment(row({ contract_hash: "stale-hash" }));
    expect(enrich.queueEntry("100:someone")?.status).toBe("pending");
  });

  it("does not project labels from rows that do not exactly cover unit membership", () => {
    insertAndRegister([
      { id: "100", conversation_id: "100", text: "first model update" },
      { id: "101", conversation_id: "100", text: "second model update" },
    ]);
    enrich.applyEnrichment(row({ tweet_ids: ["100", "101", "unexpected"] }));
    expect(enrich.queueEntry("100:someone")?.status).toBe("pending");
    expect(enrich.registryStatus("dgx-spark")).toBeUndefined();
  });

  it("keeps a unit pending when the enrichment misses current members", () => {
    insertAndRegister([
      { id: "100", conversation_id: "100" },
      { id: "101", conversation_id: "100" },
    ]);
    enrich.applyEnrichment(row({ tweet_ids: ["100"] }));
    expect(enrich.queueEntry("100:someone")?.status).toBe("pending");
    enrich.applyEnrichment(row({ tweet_ids: ["100", "101"] }));
    expect(enrich.queueEntry("100:someone")?.status).toBe("done");
  });

  it("never lets invalid evidence overwrite a current projection", () => {
    insertAndRegister([{ id: "100", text: "grounded source text" }]);
    const current = row({
      preset_labels: [{ name: "ai", evidence: [{ tweet_id: "100", quote: "grounded" }] }],
      free_labels: [],
      enriched_at: "2026-07-06T00:00:00.000Z",
    });
    enrich.applyEnrichment(current);
    enrich.applyEnrichment({
      ...current,
      preset_labels: [{ name: "ai", evidence: [{ tweet_id: "not-a-member", quote: "grounded" }] }],
      enriched_at: "2026-07-07T00:00:00.000Z",
    });
    expect(enrich.visibleAssignments(["100:someone"]).get("100:someone")?.preset_labels).toEqual(
      current.preset_labels,
    );
    expect(enrich.queueEntry("100:someone")?.status).toBe("done");
  });

  it("recovers expired leases on the next tick", () => {
    insertAndRegister([{ id: "100" }]);
    const claimed = enrich.claimBatch({ limit: 10, workerId: "w1", leaseMs: 1_000 });
    expect(claimed).toHaveLength(1);
    store.database
      .prepare("UPDATE enrich_queue SET lease_expires_at = ?")
      .run(new Date(NOW.getTime() - 1).toISOString());
    expect(enrich.recoverExpiredLeases()).toBe(1);
    expect(enrich.queueEntry("100:someone")?.status).toBe("pending");
    expect(enrich.claimBatch({ limit: 10, workerId: "w1", leaseMs: 1_000 })).toHaveLength(1);
  });

  it("claims with equal newest/oldest capacity when both sides have work", () => {
    const tweets = [
      makePooled({ id: "a", captured_at: "2026-07-01T00:00:00.000Z" }),
      makePooled({ id: "b", captured_at: "2026-07-02T00:00:00.000Z", author: { username: "b" } }),
      makePooled({ id: "c", captured_at: "2026-07-03T00:00:00.000Z", author: { username: "c" } }),
    ];
    store.insert(tweets);
    enrich.registerTweets(tweets);
    const claimed = enrich.claimBatch({ limit: 2, workerId: "w1", leaseMs: 60_000 });
    const ids = claimed.map((c) => c.unitId).sort();
    expect(ids).toEqual(["a:someone", "c:c"]);
  });

  it("claims the oldest work when the batch limit is one", () => {
    const tweets = [
      makePooled({ id: "old", captured_at: "2026-07-01T00:00:00.000Z" }),
      makePooled({
        id: "new",
        captured_at: "2026-07-03T00:00:00.000Z",
        author: { username: "new" },
      }),
    ];
    store.insert(tweets);
    enrich.registerTweets(tweets);
    expect(enrich.claimBatch({ limit: 1, workerId: "w1", leaseMs: 60_000 })[0]?.unitId).toBe(
      "old:someone",
    );
  });
});

describe("recent error surface", () => {
  it("records error classes and returns a bounded breakdown", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.markTransientFailure("100:someone", "boom", "timeout", NOW);
    enrich.markTransientFailure("100:someone", "boom", "rate_limit", NOW);
    enrich.markTransientFailure("100:someone", "boom", "timeout", NOW);
    const errors = enrich.recentErrorClasses();
    expect(errors).toEqual(
      expect.arrayContaining([
        { error_class: "timeout", count: 2 },
        { error_class: "rate_limit", count: 1 },
      ]),
    );
  });
});

describe("status counts", () => {
  it("counts by author selection, and complete_through never crosses pending work", () => {
    const tweets = [
      makePooled({
        id: "1",
        conversation_id: "one",
        captured_at: "2026-07-01T00:00:00.000Z",
        author: { id: "author-a", username: "a" },
      }),
      makePooled({
        id: "2",
        conversation_id: "two",
        captured_at: "2026-07-02T00:00:00.000Z",
        author: { id: "author-a", username: "a" },
      }),
      makePooled({
        id: "3",
        conversation_id: "three",
        captured_at: "2026-07-03T00:00:00.000Z",
        author: { id: "author-b", username: "b" },
      }),
    ];
    store.insert(tweets);
    enrich.registerTweets(tweets);
    enrich.applyEnrichment(row({ unit_id: "one:a", tweet_ids: ["1"] }));

    const allAuthors = enrich.statusCounts();
    expect(allAuthors.totals.total).toBe(3);
    expect(allAuthors.totals.completed).toBe(1);
    expect(allAuthors.totals.pending).toBe(2);

    const only = enrich.statusCounts({ authorIds: ["author-a"] });
    expect(only.totals.total).toBe(2);
    expect(only.totals.pending).toBe(1);
    expect(only.totals.completed).toBe(1);
    expect(only.completeThrough).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("status counts across all queue states", () => {
  it("reports running, retrying and blocked totals", () => {
    insertAndRegister([
      { id: "a", conversation_id: "a" },
      { id: "b", conversation_id: "b" },
      { id: "c", conversation_id: "c" },
    ]);
    // Move `a` to running via a claim; move `b` to retrying; block `c`.
    enrich.claimBatch({ limit: 1, workerId: "w1", leaseMs: 60_000 });
    enrich.markTransientFailure("b:someone", "boom", "timeout", NOW);
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      enrich.markTransientFailure("c:someone", "boom", "timeout", NOW);
    }
    const counts = enrich.statusCounts();
    expect(counts.totals.running).toBeGreaterThanOrEqual(1);
    expect(counts.totals.retrying).toBeGreaterThanOrEqual(1);
    expect(counts.totals.blocked).toBeGreaterThanOrEqual(1);
  });
});

describe("assignments and evidence", () => {
  it("stores evidence with each assignment and exposes only approved free labels", () => {
    insertAndRegister([{ id: "100", text: "vLLM ships fp8 kernels" }]);
    enrich.applyEnrichment(
      row({
        preset_labels: [{ name: "ai", evidence: [{ tweet_id: "100", quote: "vLLM ships fp8" }] }],
        free_labels: [
          { name: "fp8", evidence: [{ tweet_id: "100", quote: "fp8" }] },
          { name: "vllm", evidence: [{ tweet_id: "100", quote: "vLLM" }] },
        ],
      }),
    );
    recordCandidate("fp8");
    recordCandidate("vllm");
    // Free labels start as candidates; approvedFreeLabels omits them.
    expect(enrich.approvedFreeLabels()).toEqual([]);
    // After promoting one, the approved list contains it.
    enrich.promoteName("fp8", "test");
    expect(enrich.approvedFreeLabels()).toEqual([{ name: "fp8", count: 1 }]);

    // Public visibility filters out candidate free labels.
    const visible = enrich.visibleAssignments(["100:someone"]).get("100:someone");
    expect(visible?.preset_labels.map((a) => a.name)).toEqual(["ai"]);
    expect(visible?.free_labels.map((a) => a.name)).toEqual(["fp8"]);
    expect(visible?.free_labels[0]?.evidence).toEqual([{ tweet_id: "100", quote: "fp8" }]);
  });

  it("rejected free labels are hidden from public reads", () => {
    insertAndRegister([{ id: "100", text: "vLLM ships fp8" }]);
    enrich.applyEnrichment(
      row({
        free_labels: [{ name: "fp8", evidence: [{ tweet_id: "100", quote: "fp8" }] }],
      }),
    );
    recordCandidate("fp8");
    enrich.rejectName("fp8", "test-rejection");
    expect(enrich.approvedFreeLabels()).toEqual([]);
    const visible = enrich.visibleAssignments(["100:someone"]).get("100:someone");
    expect(visible?.free_labels).toEqual([]);
  });

  it("excludes stale assignments from registry promotion signals", () => {
    insertAndRegister([{ id: "100", text: "vLLM ships fp8" }]);
    enrich.applyEnrichment(
      row({
        free_labels: [{ name: "fp8", evidence: [{ tweet_id: "100", quote: "fp8" }] }],
      }),
    );
    expect(enrich.promotionSignals("fp8").units).toBe(1);

    insertAndRegister([
      { id: "101", conversation_id: "100", in_reply_to_status_id: "100", text: "new reply" },
    ]);
    expect(enrich.queueEntry("100:someone")?.status).toBe("pending");
    expect(enrich.promotionSignals("fp8")).toEqual({ units: 0, authors: 0, days: 0 });
  });
});

describe("summaries", () => {
  beforeEach(() => {
    insertAndRegister([
      { id: "1", author: { username: "a" } },
      { id: "2", author: { username: "b" } },
      { id: "3", author: { username: "c" } },
    ]);
    enrich.applyEnrichment(
      row({
        unit_id: "1:a",
        tweet_ids: ["1"],
        preset_labels: [{ name: "ai", evidence: [{ tweet_id: "1", quote: "hello" }] }],
        free_labels: [{ name: "fp8", evidence: [{ tweet_id: "1", quote: "hello" }] }],
      }),
    );
    recordCandidate("fp8");
    enrich.applyEnrichment(
      row({
        unit_id: "2:b",
        tweet_ids: ["2"],
        preset_labels: [
          { name: "ai", evidence: [{ tweet_id: "2", quote: "hello" }] },
          { name: "agents", evidence: [{ tweet_id: "2", quote: "hello" }] },
        ],
        free_labels: [],
      }),
    );
    enrich.promoteName("fp8", "test-approved");
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      enrich.markTransientFailure("3:c", "boom", "other", NOW);
    }
  });

  it("returns every approved free label needed to validate selected units", () => {
    const names = Array.from({ length: 51 }, (_, index) => `label-${String(index)}`);
    for (const [index, name] of names.entries()) {
      const id = String(1_000 + index);
      const [unitId] = insertAndRegister([{ id }]);
      if (unitId === undefined) throw new Error("expected unit");
      const freeLabel = defaultAssignments(unitId).freeLabels[0];
      if (freeLabel === undefined) throw new Error("expected free label evidence");
      enrich.applyEnrichment(
        row({
          unit_id: unitId,
          free_labels: [{ ...freeLabel, name }],
        }),
      );
      recordCandidate(name);
      enrich.promoteName(name, "test-approved");
    }

    const summary = enrich.labelsSummary(TAXONOMY);
    const returnedNames = new Set(summary.free_labels.map((entry) => entry.name));
    expect(names.every((name) => returnedNames.has(name))).toBe(true);
  });

  it("summarizes label counts, free labels, queue depth and coverage", () => {
    const taxonomy = [
      { name: "ai", description: "d" },
      { name: "agents", description: "d" },
      { name: "quantization", description: "d" },
    ];
    const summary = enrich.labelsSummary(taxonomy);
    expect(summary.taxonomy_version).toBe(1);
    expect(summary.labels).toEqual([
      { name: "ai", description: "d", count: 2 },
      { name: "agents", description: "d", count: 1 },
      { name: "quantization", description: "d", count: 0 },
    ]);
    expect(summary.free_labels).toEqual([{ name: "fp8", count: 1 }]);
    expect(summary.queue).toEqual({
      pending: 0,
      running: 0,
      retrying: 0,
      blocked: 1,
      done: 2,
    });
    expect(summary.coverage).toEqual({ units_total: 3, units_enriched: 2 });

    const beforeWindow = enrich.labelsSummary(taxonomy, {
      cutoff: "2026-01-01T00:00:00.000Z",
    });
    expect(beforeWindow.labels.every((label) => label.count === 0)).toBe(true);
    expect(beforeWindow.free_labels).toEqual([]);
    expect(beforeWindow.queue).toEqual({
      pending: 0,
      running: 0,
      retrying: 0,
      blocked: 0,
      done: 0,
    });
    expect(beforeWindow.coverage).toEqual({ units_total: 0, units_enriched: 0 });
  });
});

describe("claiming", () => {
  it("claims atomically so overlapping drains never share units", () => {
    insertAndRegister([{ id: "100" }, { id: "200", conversation_id: "200" }]);
    const first = enrich.claimQueued(10);
    expect(first.length).toBe(2);
    expect(enrich.claimQueued(10)).toEqual([]);
    enrich.releaseClaims();
    expect(enrich.claimQueued(10).length).toBe(2);
  });
});

describe("free-label registry", () => {
  it("accepts only the next event for the active contract during replay", () => {
    const candidate = enrich.candidateEventIfNew("vllm").event;
    if (candidate === undefined) throw new Error("expected candidate");
    enrich.applyRegistryEvent({ ...candidate, registry_revision: candidate.registry_revision + 1 });
    expect(enrich.registryEntry("vllm")).toBeUndefined();
    enrich.applyRegistryEvent(candidate);
    expect(enrich.registryStatus("vllm")).toBe("candidate");
    enrich.applyRegistryEvent({
      ...candidate,
      name: "fp8",
      registry_revision: candidate.registry_revision + 1,
      contract_hash: "old-contract",
    });
    expect(enrich.registryEntry("fp8")).toBeUndefined();
  });

  it("records a candidate on first observation and does not surface it publicly", () => {
    insertAndRegister([{ id: "100", text: "hello vllm" }]);
    enrich.applyEnrichment(
      row({
        free_labels: [{ name: "vllm", evidence: [{ tweet_id: "100", quote: "vllm" }] }],
      }),
    );
    recordCandidate("vllm");
    const entry = enrich.registryEntry("vllm");
    expect(entry?.status).toBe("candidate");
    expect(enrich.approvedFreeLabels()).toEqual([]);
  });

  it("promotes and rejects free labels durably", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.applyEnrichment(
      row({
        free_labels: [{ name: "fp8", evidence: [{ tweet_id: "100", quote: "hello" }] }],
      }),
    );
    recordCandidate("fp8");
    const promoted = enrich.promoteName("fp8", "hub-verified");
    expect(promoted?.status).toBe("approved");
    expect(enrich.approvedFreeLabels().map((entry) => entry.name)).toEqual(["fp8"]);
    const rejected = enrich.rejectName("fp8", "operator-decision");
    expect(rejected?.status).toBe("rejected");
    expect(enrich.registryEntry("fp8")?.status).toBe("rejected");
  });
});

describe("capture freshness and empty units", () => {
  it("a stale copy cannot move a tweet back to a conversation-less unit", () => {
    const fresh = makePooled({
      id: "300",
      conversation_id: "299",
      captured_at: "2026-07-05T00:00:00.000Z",
    });
    const stale = makePooled({
      id: "300",
      conversation_id: null,
      captured_at: "2026-07-01T00:00:00.000Z",
    });
    store.insert([fresh]);
    enrich.registerTweets([fresh]);
    enrich.registerTweets([stale]);
    expect(enrich.unitMemberIds("299:someone")).toEqual(["300"]);
    expect(enrich.unitMemberIds("300:someone")).toEqual([]);
  });

  it("replaying enrichment for a memberless unit does not resurrect assignments", () => {
    insertAndRegister([{ id: "500" }]);
    enrich.applyEnrichment(row({ unit_id: "500:someone", tweet_ids: ["500"] }));
    const moved = makePooled({
      id: "500",
      conversation_id: "499",
      captured_at: "2026-07-09T00:00:00.000Z",
    });
    store.insert([moved]);
    enrich.registerTweets([moved]);
    enrich.applyEnrichment(row({ unit_id: "500:someone", tweet_ids: ["500"] }));
    const rows = store.database
      .prepare("SELECT unit_id FROM label_assignments WHERE unit_id = ?")
      .all("500:someone");
    expect(rows).toEqual([]);
  });
});
