import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EnrichmentRow } from "@xtap-pool/shared";

import { EnrichStore } from "../src/enrich-store.js";
import { TweetStore } from "../src/store.js";
import { makePooled } from "./helpers.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");

let store: TweetStore;
let enrich: EnrichStore;

beforeEach(() => {
  store = new TweetStore();
  enrich = new EnrichStore(store.database, 1, () => NOW);
});

afterEach(() => {
  store.close();
});

function insertAndRegister(overridesList: readonly Record<string, unknown>[]): string[] {
  const tweets = overridesList.map((overrides) => makePooled(overrides));
  store.insert(tweets);
  return enrich.registerTweets(tweets);
}

function row(overrides: Partial<EnrichmentRow> = {}): EnrichmentRow {
  return {
    unit_id: "100:someone",
    tweet_ids: ["100"],
    labels: ["ai"],
    free_labels: ["dgx-spark"],
    concepts: [{ name: "vLLM", aliases: ["VLLM"] }],
    model: "test-model",
    taxonomy_version: 1,
    enriched_at: NOW.toISOString(),
    ...overrides,
  };
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
    expect(enrich.unitMemberIds("1:swyx")).toEqual(["3"]);
    const claimed = enrich.claimQueued(10);
    expect(claimed.map((item) => item.unitId).sort()).toEqual([
      "1:karpathy",
      "1:swyx",
      "4:someone",
    ]);
    expect(claimed.find((item) => item.unitId === "1:karpathy")?.tweetIds).toEqual(["1", "2"]);
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
    expect(entry).toMatchObject({ status: "queued", attempts: 0 });
    expect(enrich.claimQueued(10)[0]?.tweetIds).toEqual(["100", "101"]);
  });

  it("re-enqueues stale units after a taxonomy bump", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.applyEnrichment(row());
    const bumped = new EnrichStore(store.database, 2, () => NOW);
    bumped.registerTweets([makePooled({ id: "100" })]);
    expect(bumped.queueEntry("100:someone")?.status).toBe("queued");
  });

  it("leaves an unenriched queued unit alone on duplicate re-capture", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.markFailed("100:someone", "boom");
    insertAndRegister([{ id: "100" }]);
    expect(enrich.queueEntry("100:someone")).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "boom",
    });
  });
});

describe("queue state machine", () => {
  it("requeues failures up to three attempts, then marks the unit failed", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.markFailed("100:someone", "first");
    expect(enrich.queueEntry("100:someone")).toMatchObject({ status: "queued", attempts: 1 });
    enrich.markFailed("100:someone", "second");
    expect(enrich.claimQueued(10)).toHaveLength(1);
    enrich.markFailed("100:someone", "third");
    expect(enrich.queueEntry("100:someone")).toMatchObject({
      status: "failed",
      attempts: 3,
      lastError: "third",
    });
    expect(enrich.claimQueued(10)).toHaveLength(0);
  });

  it("keeps a unit queued when the enrichment misses current members", () => {
    insertAndRegister([
      { id: "100", conversation_id: "100" },
      { id: "101", conversation_id: "100" },
    ]);
    enrich.applyEnrichment(row({ tweet_ids: ["100"] }));
    expect(enrich.queueEntry("100:someone")?.status).toBe("queued");
    enrich.applyEnrichment(row({ tweet_ids: ["100", "101"] }));
    expect(enrich.queueEntry("100:someone")?.status).toBe("done");
  });

  it("does not settle the queue for rows from another taxonomy version", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.applyEnrichment(row({ taxonomy_version: 2 }));
    expect(enrich.queueEntry("100:someone")?.status).toBe("queued");
  });
});

describe("label and concept query filters", () => {
  beforeEach(() => {
    insertAndRegister([
      { id: "1", text: "vllm ships fp8", author: { id: "author-a", username: "a" } },
      { id: "2", text: "agents everywhere", author: { id: "author-b", username: "b" } },
      { id: "3", text: "unrelated", author: { id: "author-c", username: "c" } },
    ]);
    enrich.applyEnrichment(
      row({
        unit_id: "1:a",
        tweet_ids: ["1"],
        labels: ["ai", "inference-performance"],
        free_labels: ["fp8"],
        concepts: [{ name: "vLLM", aliases: [] }],
      }),
    );
    enrich.applyEnrichment(
      row({
        unit_id: "2:b",
        tweet_ids: ["2"],
        labels: ["ai", "agents"],
        free_labels: [],
        concepts: [{ name: "Coding Agents", aliases: [] }],
      }),
    );
  });

  it("filters tweets by preset labels with any/all modes", () => {
    const ids = (q: Parameters<TweetStore["query"]>[0]): string[] =>
      store.query(q).records.map((record) => record.tweet.id);
    expect(ids({ labels: ["ai"] }).sort()).toEqual(["1", "2"]);
    expect(ids({ labels: ["agents", "inference-performance"] }).sort()).toEqual(["1", "2"]);
    expect(ids({ labels: ["ai", "agents"], labelMode: "all" })).toEqual(["2"]);
    expect(ids({ labels: ["quantization"] })).toEqual([]);
  });

  it("filters by free label, concept, author ID and unlabeled", () => {
    const ids = (q: Parameters<TweetStore["query"]>[0]): string[] =>
      store.query(q).records.map((record) => record.tweet.id);
    expect(ids({ freeLabel: "fp8" })).toEqual(["1"]);
    expect(ids({ concept: "coding-agents" })).toEqual(["2"]);
    expect(ids({ authorIds: ["author-a", "author-c"] }).sort()).toEqual(["1", "3"]);
    expect(ids({ unlabeled: true })).toEqual(["3"]);
    expect(ids({ labels: ["ai"], q: "vllm" })).toEqual(["1"]);
  });

  it("uses the same author-ID selection for concepts, details and graph data", () => {
    expect(enrich.concepts({ authorIds: ["author-a"] })).toEqual([
      expect.objectContaining({ slug: "vllm", unit_count: 1 }),
    ]);
    expect(enrich.concept("coding-agents", { authorIds: ["author-a"] })).toBeUndefined();
    expect(enrich.graph({ authorIds: ["author-a"], top: 10 })).toEqual({
      nodes: [{ slug: "vllm", name: "vLLM", unit_count: 1 }],
      links: [],
    });
  });
});

describe("vocabulary merge and edges", () => {
  it("unions aliases case-insensitively under one slug", () => {
    insertAndRegister([
      { id: "1", author: { username: "a" } },
      { id: "2", author: { username: "b" } },
    ]);
    enrich.applyEnrichment(
      row({
        unit_id: "1:a",
        tweet_ids: ["1"],
        concepts: [{ name: "DGX Spark", aliases: ["Spark"] }],
      }),
    );
    enrich.applyEnrichment(
      row({
        unit_id: "2:b",
        tweet_ids: ["2"],
        concepts: [{ name: "dgx spark", aliases: ["SPARK", "GB10"] }],
      }),
    );
    const entry = enrich.concepts().find((concept) => concept.slug === "dgx-spark");
    expect(entry).toMatchObject({ name: "DGX Spark", aliases: ["Spark", "GB10"], unit_count: 2 });
  });

  it("increments edges per unit pair and rewrites them on re-enrichment", () => {
    insertAndRegister([
      { id: "1", author: { username: "a" } },
      { id: "2", author: { username: "b" } },
    ]);
    const concepts = (names: string[]): { name: string; aliases: string[] }[] =>
      names.map((name) => ({ name, aliases: [] }));
    enrich.applyEnrichment(
      row({ unit_id: "1:a", tweet_ids: ["1"], concepts: concepts(["x", "y", "z"]) }),
    );
    enrich.applyEnrichment(
      row({ unit_id: "2:b", tweet_ids: ["2"], concepts: concepts(["x", "y"]) }),
    );

    let graph = enrich.graph({ top: 10 });
    expect(graph.links).toContainEqual({ source: "x", target: "y", weight: 2 });
    expect(graph.links).toContainEqual({ source: "x", target: "z", weight: 1 });
    expect(graph.links).toHaveLength(3);

    // Re-enrich unit 1 with fewer concepts: old pairs decrement, dead edges go away.
    enrich.applyEnrichment(row({ unit_id: "1:a", tweet_ids: ["1"], concepts: concepts(["x"]) }));
    graph = enrich.graph({ top: 10 });
    expect(graph.links).toEqual([{ source: "x", target: "y", weight: 1 }]);
    expect(enrich.concepts().find((c) => c.slug === "z")?.unit_count).toBe(0);
    expect(enrich.concept("y")?.unit_count).toBe(1);
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
        labels: ["ai"],
        free_labels: ["fp8"],
        concepts: [
          { name: "vLLM", aliases: [] },
          { name: "FP8", aliases: [] },
        ],
      }),
    );
    enrich.applyEnrichment(
      row({
        unit_id: "2:b",
        tweet_ids: ["2"],
        labels: ["ai", "agents"],
        free_labels: [],
        concepts: [],
      }),
    );
    enrich.markFailed("3:c", "boom");
    enrich.markFailed("3:c", "boom");
    enrich.markFailed("3:c", "boom");
  });

  it("summarizes label counts, free labels, queue depth and coverage", () => {
    const summary = enrich.labelsSummary([
      { name: "ai", description: "d" },
      { name: "agents", description: "d" },
      { name: "quantization", description: "d" },
    ]);
    expect(summary.taxonomy_version).toBe(1);
    expect(summary.labels).toEqual([
      { name: "ai", description: "d", count: 2 },
      { name: "agents", description: "d", count: 1 },
      { name: "quantization", description: "d", count: 0 },
    ]);
    expect(summary.free_labels).toEqual([{ name: "fp8", count: 1 }]);
    expect(summary.queue).toEqual({ queued: 0, failed: 1, done: 2 });
    expect(summary.coverage).toEqual({ units_total: 3, units_enriched: 2 });
  });

  it("lists concepts by usage and details one concept with relations", () => {
    expect(enrich.concepts().map((concept) => concept.slug)).toEqual(["fp8", "vllm"]);
    const detail = enrich.concept("vllm");
    expect(detail).toMatchObject({ slug: "vllm", name: "vLLM", unit_count: 1, tweet_count: 1 });
    expect(detail?.related).toEqual([{ slug: "fp8", name: "FP8", shared_units: 1 }]);
    expect(enrich.concept("nope")).toBeUndefined();
  });

  it("bounds the graph by top and filters nodes by label", () => {
    const bounded = enrich.graph({ top: 1 });
    expect(bounded.nodes).toHaveLength(1);
    expect(bounded.links).toEqual([]);

    const labeled = enrich.graph({ labels: ["ai"], top: 10 });
    expect(labeled.nodes.map((node) => node.slug).sort()).toEqual(["fp8", "vllm"]);
    expect(labeled.links).toEqual([{ source: "fp8", target: "vllm", weight: 1 }]);
    const anyLabel = enrich.graph({ labels: ["ai", "agents"], labelMode: "any", top: 10 });
    expect(anyLabel.nodes.map((node) => node.slug).sort()).toEqual(["fp8", "vllm"]);
    const everyLabel = enrich.graph({ labels: ["ai", "agents"], labelMode: "all", top: 10 });
    expect(everyLabel.nodes).toEqual([]);
    const agentsOnly = enrich.graph({ labels: ["agents"], top: 10 });
    expect(agentsOnly.nodes).toEqual([]);
  });

  it("filters publication taxonomy to public units without rebuilding graph data downstream", () => {
    insertAndRegister([
      { id: "4", author: { username: "d" }, is_subscriber_only: true },
      { id: "5", author: { username: "e" }, is_retweet: true },
    ]);
    enrich.applyEnrichment(
      row({
        unit_id: "4:d",
        tweet_ids: ["4"],
        concepts: [{ name: "Private Concept", aliases: [] }],
      }),
    );
    enrich.applyEnrichment(
      row({
        unit_id: "5:e",
        tweet_ids: ["5"],
        concepts: [{ name: "Retweet Concept", aliases: [] }],
      }),
    );

    expect(enrich.concepts().map((concept) => concept.slug)).toContain("private-concept");
    const selection = { publication: "public-original" as const };
    expect(
      enrich
        .concepts(selection)
        .map((concept) => concept.slug)
        .sort(),
    ).toEqual(["fp8", "vllm"]);
    expect(enrich.concept("private-concept", selection)).toBeUndefined();
    expect(enrich.graph({ ...selection, top: 10 })).toEqual({
      nodes: [
        { slug: "fp8", name: "FP8", unit_count: 1 },
        { slug: "vllm", name: "vLLM", unit_count: 1 },
      ],
      links: [{ source: "fp8", target: "vllm", weight: 1 }],
    });
  });

  it("omits stale assignments from filtered graphs while a unit is queued", () => {
    const joined = makePooled({
      id: "4",
      conversation_id: "1",
      author: { username: "a" },
    });
    store.insert([joined]);
    enrich.registerTweets([joined]);

    const labels = enrich.labelsSummary([
      { name: "ai", description: "d" },
      { name: "agents", description: "d" },
    ]);
    expect(labels.labels).toEqual([
      { name: "ai", description: "d", count: 1 },
      { name: "agents", description: "d", count: 1 },
    ]);
    expect(labels.free_labels).toEqual([]);
    expect(labels.coverage).toEqual({ units_total: 3, units_enriched: 1 });
    expect(enrich.concepts().filter((concept) => concept.unit_count > 0)).toEqual([]);
    expect(enrich.concept("vllm")).toMatchObject({ unit_count: 0, tweet_count: 0, related: [] });
    expect(enrich.graph({ top: 10 })).toEqual({ nodes: [], links: [] });
    expect(enrich.graph({ labels: ["ai"], top: 10 })).toEqual({ nodes: [], links: [] });
  });
});

describe("taxonomy version and duplicate copies", () => {
  it("replaying a stale-taxonomy row keeps concepts but not preset labels", () => {
    insertAndRegister([{ id: "100" }]);
    enrich.applyEnrichment(row({ taxonomy_version: 0 }));
    const labels = store.database
      .prepare("SELECT label, kind FROM tweet_labels WHERE tweet_id = '100' ORDER BY label")
      .all() as { label: string; kind: string }[];
    expect(labels).toEqual([{ label: "dgx-spark", kind: "free" }]);
    const vocab = store.database.prepare("SELECT slug FROM concept_vocabulary").all() as {
      slug: string;
    }[];
    expect(vocab).toEqual([{ slug: "vllm" }]);
    const queue = store.database
      .prepare("SELECT status FROM enrich_queue WHERE unit_id = '100:someone'")
      .get() as { status: string };
    expect(queue.status).toBe("queued");
  });

  it("prompts with the freshest contributor copy of a tweet", () => {
    const stale = makePooled({
      id: "100",
      text: "old text",
      captured_at: "2026-07-01T00:00:00.000Z",
      contributed_by: "alice",
    });
    const fresh = makePooled({
      id: "100",
      text: "edited text",
      captured_at: "2026-07-05T00:00:00.000Z",
      contributed_by: "bob",
    });
    store.insert([stale, fresh]);
    enrich.registerTweets([stale, fresh]);
    expect(enrich.unitText("100:someone", 1000)).toBe("edited text");
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

  it("emptying a unit within one batch removes its queue entry", () => {
    const before = [
      makePooled({ id: "400", conversation_id: null, captured_at: "2026-07-01T00:00:00.000Z" }),
      makePooled({ id: "401", conversation_id: null, captured_at: "2026-07-01T00:00:00.000Z" }),
    ];
    store.insert(before);
    enrich.registerTweets(before);
    // both re-captures now carry the conversation, leaving 400:someone and
    // 401:someone empty
    const after = [
      makePooled({ id: "400", conversation_id: "399", captured_at: "2026-07-02T00:00:00.000Z" }),
      makePooled({ id: "401", conversation_id: "399", captured_at: "2026-07-02T00:00:00.000Z" }),
    ];
    store.insert(after);
    const enqueued = enrich.registerTweets(after);
    expect(enqueued).toEqual(["399:someone"]);
    const empties = store.database
      .prepare("SELECT unit_id FROM enrich_queue WHERE unit_id IN ('400:someone', '401:someone')")
      .all();
    expect(empties).toEqual([]);
  });

  it("replaying enrichment for a memberless unit does not resurrect concepts", () => {
    insertAndRegister([{ id: "500" }]);
    enrich.applyEnrichment(row({ unit_id: "500:someone", tweet_ids: ["500"] }));
    // the tweet moves away; the old unit is cleared
    const moved = makePooled({
      id: "500",
      conversation_id: "499",
      captured_at: "2026-07-09T00:00:00.000Z",
    });
    store.insert([moved]);
    enrich.registerTweets([moved]);
    // boot-style replay of the old append-only row
    enrich.applyEnrichment(row({ unit_id: "500:someone", tweet_ids: ["500"] }));
    const vocab = store.database
      .prepare("SELECT slug, unit_count FROM concept_vocabulary WHERE unit_count > 0")
      .all();
    expect(vocab).toEqual([]);
  });
});
