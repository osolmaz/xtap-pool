import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnrichReceipt } from "@xtap-pool/shared";

import { DatasetMirror } from "../src/dataset.js";
import { DEFAULT_TAXONOMY } from "../src/enrich-config.js";
import { EnrichStore } from "../src/enrich-store.js";
import {
  createRouterLlmClient,
  retrieveVocabulary,
  runEnrichTick,
  startEnrichWorker,
} from "../src/enrich-worker.js";
import type { EnrichWorkerDeps, LlmClient, LlmMessage } from "../src/enrich-worker.js";
import { TweetStore } from "../src/store.js";
import { FakeHub, makePooled } from "./helpers.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");

let dir: string;
let hub: FakeHub;
let mirror: DatasetMirror;
let store: TweetStore;
let enrichStore: EnrichStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xtap-pool-enrich-"));
  hub = new FakeHub();
  mirror = new DatasetMirror(hub, dir);
  store = new TweetStore();
  enrichStore = new EnrichStore(store.database, 1, () => NOW);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedUnit(id: string, text: string, username = "someone"): string {
  const tweet = makePooled({ id, text, author: { username } });
  store.insert([tweet]);
  enrichStore.registerTweets([tweet]);
  return `${id}:${username}`;
}

function respondingClient(
  reply: (unitIds: string[]) => string,
  captured?: LlmMessage[][],
): LlmClient {
  return (messages) => {
    captured?.push([...messages]);
    const user = messages.find((message) => message.role === "user");
    const payload = JSON.parse(user?.content ?? "{}") as { units: { unit_id: string }[] };
    return Promise.resolve({
      content: reply(payload.units.map((unit) => unit.unit_id)),
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
  };
}

function classification(unitIds: string[]): string {
  const units = Object.fromEntries(
    unitIds.map((unitId) => [
      unitId,
      {
        labels: ["ai"],
        free_labels: ["dgx-spark"],
        concepts: [
          { name: "vLLM", aliases: ["VLLM"] },
          { name: "FP8", aliases: [] },
          { name: "DGX Spark", aliases: [] },
        ],
      },
    ]),
  );
  return JSON.stringify({ units });
}

function deps(llm: LlmClient, overrides: Partial<EnrichWorkerDeps> = {}): EnrichWorkerDeps {
  return {
    enrichStore,
    mirror,
    taxonomy: { labels: DEFAULT_TAXONOMY, version: 1, source: "default" },
    llm,
    model: "test-model",
    maxUnitsPerTick: 100,
    now: () => NOW,
    ...overrides,
  };
}

describe("runEnrichTick", () => {
  it("drains the queue, persists to the dataset first, then indexes", async () => {
    const unitId = seedUnit("100", "vllm ships fp8 kernels");
    const receipt = await runEnrichTick(deps(respondingClient(classification)));

    expect(receipt).toMatchObject({
      units: 1,
      calls: 1,
      prompt_tokens: 11,
      completion_tokens: 7,
      failures: 0,
    });
    const shard = hub.files.get("enrichment/2026/07/enrichment-2026-07-06.jsonl");
    expect(shard).toBeDefined();
    const row = JSON.parse(shard?.trim() ?? "{}") as Record<string, unknown>;
    expect(row).toMatchObject({
      unit_id: unitId,
      tweet_ids: ["100"],
      labels: ["ai"],
      free_labels: ["dgx-spark"],
      model: "test-model",
      taxonomy_version: 1,
      enriched_at: NOW.toISOString(),
    });
    const vocabulary = JSON.parse(hub.files.get("enrichment/vocabulary.json") ?? "{}") as {
      concepts: { slug: string }[];
    };
    expect(vocabulary.concepts.map((concept) => concept.slug)).toEqual([
      "dgx-spark",
      "fp8",
      "vllm",
    ]);
    const receipts = hub.files.get("enrichment/receipts/2026-07-06.jsonl");
    expect(JSON.parse(receipts?.trim() ?? "{}")).toMatchObject({ units: 1, calls: 1 });
    expect(enrichStore.queueEntry(unitId)?.status).toBe("done");
    expect(store.query({ labels: ["ai"] }).records.map((r) => r.tweet.id)).toEqual(["100"]);
  });

  it("batches ~20 units per call and respects the per-tick cap", async () => {
    for (let index = 0; index < 25; index += 1) {
      seedUnit(String(1000 + index), `post ${String(index)}`, `user${String(index)}`);
    }
    const captured: LlmMessage[][] = [];
    const receipt = await runEnrichTick(
      deps(respondingClient(classification, captured), { maxUnitsPerTick: 24, unitsPerCall: 20 }),
    );
    expect(receipt.units).toBe(24);
    expect(receipt.calls).toBe(2);
    expect(captured).toHaveLength(2);
    expect(enrichStore.claimQueued(100)).toHaveLength(1);
  });

  it("tolerates fenced responses and returns an empty receipt for an empty queue", async () => {
    seedUnit("100", "hello");
    const fenced: LlmClient = (messages) => {
      const user = messages.find((message) => message.role === "user");
      const payload = JSON.parse(user?.content ?? "{}") as { units: { unit_id: string }[] };
      return Promise.resolve({
        content: `\`\`\`json\n${classification(payload.units.map((u) => u.unit_id))}\n\`\`\``,
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    await expect(runEnrichTick(deps(fenced))).resolves.toMatchObject({ units: 1, failures: 0 });

    hub.commits.length = 0;
    const idle = await runEnrichTick(deps(fenced));
    expect(idle).toMatchObject({ units: 0, calls: 0, failures: 0 });
    expect(hub.commits).toHaveLength(0);
  });

  it("retries failing units up to three times, then marks them failed", async () => {
    const unitId = seedUnit("100", "hello");
    const failing: LlmClient = () => Promise.reject(new Error("router down"));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const receipt = await runEnrichTick(deps(failing));
      expect(receipt).toMatchObject({ units: 0, failures: 1 });
    }
    expect(enrichStore.queueEntry(unitId)).toMatchObject({
      status: "failed",
      attempts: 3,
      lastError: "router down",
    });
    await expect(runEnrichTick(deps(failing))).resolves.toMatchObject({ calls: 0 });
  });

  it("fails units missing from the response and units with unparseable output", async () => {
    const unitId = seedUnit("100", "hello");
    const empty: LlmClient = () =>
      Promise.resolve({
        content: '{"units": {}}',
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    await expect(runEnrichTick(deps(empty))).resolves.toMatchObject({ units: 0, failures: 1 });
    expect(enrichStore.queueEntry(unitId)).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "unit missing from model response",
    });

    const garbage: LlmClient = () =>
      Promise.resolve({
        content: "no json here",
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    await expect(runEnrichTick(deps(garbage))).resolves.toMatchObject({ failures: 1 });
    expect(enrichStore.queueEntry(unitId)?.lastError).toBe("unparseable model response");
  });

  it("marks the batch failed and keeps SQLite untouched when the commit fails", async () => {
    const unitId = seedUnit("100", "hello");
    hub.failNextCommit = true;
    const receipt = await runEnrichTick(deps(respondingClient(classification)));
    expect(receipt).toMatchObject({ units: 0, failures: 1 });
    expect(enrichStore.queueEntry(unitId)).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "hub unavailable",
    });
    expect(store.query({ labels: ["ai"] }).records).toHaveLength(0);
  });

  it("prompts with the taxonomy, retrieved vocabulary and truncated unit text", async () => {
    enrichStore.seedVocabulary([
      { slug: "vllm", name: "vLLM", aliases: ["VLLM"] },
      { slug: "quokka", name: "Quokka", aliases: [] },
    ]);
    seedUnit("100", `vllm rocks ${"x".repeat(5000)}`);
    const captured: LlmMessage[][] = [];
    await runEnrichTick(deps(respondingClient(classification, captured)));
    const system = captured[0]?.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain('"inference-performance"');
    expect(system).toContain("vLLM");
    expect(system).not.toContain("Quokka");
    const user = captured[0]?.find((message) => message.role === "user")?.content ?? "";
    const payload = JSON.parse(user) as { units: { text: string }[] };
    expect(payload.units[0]?.text.length).toBe(4000);
  });

  it("normalizes model output: preset filtering, slugging, caps", async () => {
    const unitId = seedUnit("100", "hello");
    const messy: LlmClient = () =>
      Promise.resolve({
        content: JSON.stringify({
          units: {
            [unitId]: {
              labels: ["AI", "not-a-preset", "Agents"],
              free_labels: ["DGX Spark!", "dgx-spark", "a", "b", "c", "d", "e"],
              concepts: [{ name: "  vLLM  ", aliases: [" VLLM ", "", "vllm"] }],
            },
          },
        }),
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    await runEnrichTick(deps(messy));
    const shard = hub.files.get("enrichment/2026/07/enrichment-2026-07-06.jsonl");
    const row = JSON.parse(shard?.trim() ?? "{}") as {
      labels: string[];
      free_labels: string[];
      concepts: { name: string; aliases: string[] }[];
    };
    expect(row.labels).toEqual(["ai", "agents"]);
    expect(row.free_labels).toEqual(["dgx-spark", "a", "b", "c", "d"]);
    expect(row.concepts).toEqual([{ name: "vLLM", aliases: ["VLLM", "vllm"] }]);
  });
});

describe("retrieveVocabulary", () => {
  it("keeps only lexically overlapping entries, capped", () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({
      slug: `topic-${String(index)}`,
      name: `topic term${String(index)}`,
      aliases: [],
      unit_count: index,
    }));
    const text = entries.map((entry) => entry.name).join(" ");
    const retrieved = retrieveVocabulary(entries, text, 150);
    expect(retrieved).toHaveLength(150);
    expect(retrieveVocabulary(entries, "nothing shared here", 150)).toEqual([]);
  });

  it("matches on aliases too", () => {
    const entries = [
      { slug: "vllm", name: "vLLM", aliases: ["paged attention"], unit_count: 1 },
      { slug: "moe", name: "Mixture of Experts", aliases: [], unit_count: 5 },
    ];
    expect(retrieveVocabulary(entries, "loving the paged attention design", 10)).toEqual([
      { slug: "vllm", name: "vLLM", aliases: ["paged attention"] },
    ]);
  });
});

describe("createRouterLlmClient", () => {
  it("posts the chat completion request with auth, json contract and temperature 0", async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          choices: [{ message: { content: '{"units":{}}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
      ),
    );
    const client = createRouterLlmClient({
      hfToken: "hf_test",
      model: "zai-org/GLM-5.2",
      fetchFn,
    });
    const result = await client([{ role: "user", content: "hi" }]);
    expect(result).toEqual({
      content: '{"units":{}}',
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://router.huggingface.co/v1/chat/completions");
    expect(init?.headers).toMatchObject({ authorization: "Bearer hf_test" });
    const body = typeof init?.body === "string" ? init.body : "";
    expect(JSON.parse(body)).toMatchObject({
      model: "zai-org/GLM-5.2",
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("throws on router errors and tolerates missing usage", async () => {
    const failingFetch: typeof fetch = () => Promise.resolve(new Response("nope", { status: 500 }));
    const failing = createRouterLlmClient({ hfToken: "t", model: "m", fetchFn: failingFetch });
    await expect(failing([{ role: "user", content: "hi" }])).rejects.toThrow(
      "router request failed (500)",
    );

    const noUsageFetch: typeof fetch = () =>
      Promise.resolve(Response.json({ choices: [{ message: { content: "{}" } }] }));
    const noUsage = createRouterLlmClient({ hfToken: "t", model: "m", fetchFn: noUsageFetch });
    await expect(noUsage([{ role: "user", content: "hi" }])).resolves.toEqual({
      content: "{}",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
  });
});

describe("startEnrichWorker", () => {
  it("runs ticks on the interval, skips overlaps and survives failures", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const receipts: EnrichReceipt[] = [];
      const run = (): Promise<EnrichReceipt> => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("boom"));
        const receipt: EnrichReceipt = {
          started_at: NOW.toISOString(),
          finished_at: NOW.toISOString(),
          units: 0,
          calls: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          failures: 0,
        };
        receipts.push(receipt);
        return Promise.resolve(receipt);
      };
      const worker = startEnrichWorker({ intervalMs: 1000, run });
      await vi.advanceTimersByTimeAsync(2500);
      expect(calls).toBe(2);
      worker.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
