import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeInputHash } from "@xtap-pool/shared";

import { DEFAULT_TAXONOMY } from "../src/enrich-config.js";
import { EnrichStore, MAX_ATTEMPTS } from "../src/enrich-store.js";
import {
  contractHashFor,
  createExactHubVerifier,
  createFreeLabelJudge,
  createRouterLlmClient,
  RouterError,
  runEnrichTick,
} from "../src/enrich-worker.js";
import type {
  EnrichWorkerDeps,
  EnrichWorkerProgress,
  LlmClient,
  LlmMessage,
} from "../src/enrich-worker.js";
import { TweetStore } from "../src/store.js";
import { makePooled } from "./helpers.js";
import { FakeLog } from "./fake-log.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const CONTRACT_HASH = contractHashFor({
  taxonomy: { labels: DEFAULT_TAXONOMY, version: 1, source: "default" },
  model: "test-model",
});

let dir: string;
let log: FakeLog;
let store: TweetStore;
let enrichStore: EnrichStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xtap-pool-enrich-"));
  log = new FakeLog();
  store = new TweetStore();
  enrichStore = new EnrichStore(store.database, 1, () => NOW, CONTRACT_HASH);
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

function recordCandidate(name: string): void {
  const event = enrichStore.candidateEventIfNew(name).event;
  if (event === undefined) throw new Error(`expected new candidate: ${name}`);
  enrichStore.applyRegistryEvent(event);
}

function seedReviewCandidates(
  names: readonly string[],
  initialCandidates: readonly string[] = names,
): void {
  const tweets = Array.from({ length: 15 }, (_, index) =>
    makePooled({
      id: String(200 + index),
      text: "specific model evidence",
      author: { id: `author-${String(index % 8)}`, username: `author-${String(index % 8)}` },
      captured_at: `2026-07-0${String(index < 8 ? 5 : 6)}T12:00:00.000Z`,
    }),
  );
  store.insert(tweets);
  enrichStore.registerTweets(tweets);
  for (const tweet of tweets) {
    const unitId = `${tweet.id}:${tweet.author.username}`;
    const members = enrichStore.unitSemanticMembers(unitId);
    enrichStore.applyEnrichment({
      unit_id: unitId,
      tweet_ids: [tweet.id],
      input_hash: computeInputHash(unitId, members),
      contract_hash: CONTRACT_HASH,
      preset_labels: [],
      free_labels: names.map((name) => ({
        name,
        evidence: [{ tweet_id: tweet.id, quote: "specific model evidence" }],
      })),
      model: "test-model",
      taxonomy_version: 1,
      enriched_at: NOW.toISOString(),
    });
  }
  for (const name of initialCandidates) recordCandidate(name);
}

function respondingClient(
  reply: (unitIds: string[], texts: Map<string, string>) => string,
  captured?: LlmMessage[][],
): LlmClient {
  return (messages) => {
    captured?.push([...messages]);
    const user = messages.find((message) => message.role === "user");
    const payload = JSON.parse(user?.content ?? "{}") as {
      units: { unit_id: string; posts: { tweet_id: string; text: string }[] }[];
    };
    const texts = new Map(
      payload.units.map((entry) => [
        entry.unit_id,
        entry.posts.map((post) => post.text).join("\n"),
      ]),
    );
    return Promise.resolve({
      content: reply(
        payload.units.map((unit) => unit.unit_id),
        texts,
      ),
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
  };
}

function withEvidence(unitIds: string[], texts: Map<string, string>, name = "ai"): string {
  const units = Object.fromEntries(
    unitIds.map((unitId) => {
      const tweetId = unitId.split(":")[0] ?? "0";
      const text = texts.get(unitId) ?? "";
      const quote = text.slice(0, Math.min(20, text.length)) || "hello";
      return [
        unitId,
        {
          preset_labels: [{ name, evidence: [{ tweet_id: tweetId, quote }] }],
          free_labels: [{ name: "dgx-spark", evidence: [{ tweet_id: tweetId, quote }] }],
        },
      ];
    }),
  );
  return JSON.stringify({ units });
}

function withSelectedDiscardedPreset(
  unitIds: string[],
  texts: Map<string, string>,
  discard: (unitId: string) => boolean,
): string {
  const units = Object.fromEntries(
    unitIds.map((unitId) => {
      const tweetId = unitId.split(":")[0] ?? "0";
      const text = texts.get(unitId) ?? "";
      const quote = text.slice(0, Math.min(20, text.length)) || "hello";
      return [
        unitId,
        {
          preset_labels: discard(unitId)
            ? [{ name: "not-in-taxonomy", evidence: [{ tweet_id: tweetId, quote }] }]
            : [],
          free_labels: [],
        },
      ];
    }),
  );
  return JSON.stringify({ units });
}

function hubJson(path: string): unknown {
  const content = log.files.get(path);
  if (content === undefined) throw new Error(`missing Hub fixture: ${path}`);
  return JSON.parse(content.trim()) as unknown;
}

function deps(llm: LlmClient, overrides: Partial<EnrichWorkerDeps> = {}): EnrichWorkerDeps {
  return {
    enrichStore,
    log,
    taxonomy: { labels: DEFAULT_TAXONOMY, version: 1, source: "default" },
    llm,
    model: "test-model",
    now: () => NOW,
    workerId: "worker-1",
    leaseMs: 60_000,
    ...overrides,
  };
}

function stalledBodyFetch(status = 200): typeof fetch {
  return (_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = (): void => {
          controller.error(new DOMException("aborted", "AbortError"));
        };
        if (signal?.aborted === true) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status }));
  };
}

describe("runEnrichTick", () => {
  it("drains the queue and settles the unit as done", async () => {
    const unitId = seedUnit("100", "vllm ships fp8 kernels");
    const receipt = await runEnrichTick(deps(respondingClient(withEvidence)));
    expect(receipt).toMatchObject({
      units: 1,
      calls: 1,
      failures: 0,
      contract_hash: CONTRACT_HASH,
    });
    expect(enrichStore.queueEntry(unitId)?.status).toBe("done");
  });

  it("reports queue, registry, and receipt progress from durable transitions", async () => {
    seedUnit("100", "vllm ships fp8 kernels");
    const queue = vi.fn(() => Promise.resolve());
    const registryScan = vi.fn(() => Promise.resolve());
    const receiptPublished = vi.fn(() => Promise.resolve());
    const progress: EnrichWorkerProgress = {
      queue,
      registryScan,
      receiptPublished,
    };

    await runEnrichTick(deps(respondingClient(withEvidence), { progress }));

    expect(queue).toHaveBeenCalled();
    expect(queue).toHaveBeenLastCalledWith({
      pending: 0,
      running: 0,
      retrying: 0,
      blocked: 0,
      done: 1,
    });
    expect(registryScan).toHaveBeenCalled();
    expect(receiptPublished).toHaveBeenCalledOnce();
  });

  it("starts concurrent calls together and commits out-of-order responses in dispatch order", async () => {
    seedUnit("100", "first unit");
    seedUnit("101", "second unit");
    seedUnit("102", "third unit");
    const resolveCalls: (() => void)[] = [];
    const immediate = respondingClient(withEvidence);
    const delayed: LlmClient = (messages) =>
      new Promise((resolve) => {
        resolveCalls.push(() => {
          void immediate(messages).then((result) => {
            resolve(result);
          });
        });
      });

    const running = runEnrichTick(deps(delayed, { unitsPerCall: 1, maxConcurrentCalls: 3 }));
    await vi.waitFor(() => {
      expect(resolveCalls).toHaveLength(3);
    });
    const dispatches = (
      log.files.get("enrichment/attempts/2026/07/attempts-2026-07-06.jsonl") ?? ""
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { outcome: string });
    expect(dispatches).toHaveLength(3);
    expect(dispatches.every((event) => event.outcome === "dispatched")).toBe(true);
    resolveCalls[2]?.();
    resolveCalls[1]?.();
    resolveCalls[0]?.();

    const receipt = await running;
    expect(receipt).toMatchObject({
      units: 3,
      calls: 3,
      configured_concurrency: 3,
      peak_concurrency: 3,
      commit_queue_peak: 3,
    });
    const rows = (log.files.get("enrichment/2026/07/enrichment-2026-07-06.jsonl") ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { unit_id: string });
    expect(rows.map((row) => row.unit_id)).toEqual(["100:someone", "101:someone", "102:someone"]);
  });

  it("keeps claiming bounded pages until the eligible queue is drained", async () => {
    for (let id = 100; id < 105; id += 1) seedUnit(String(id), `unit ${String(id)}`);

    const receipt = await runEnrichTick(
      deps(respondingClient(withEvidence), {
        unitsPerCall: 1,
        maxConcurrentCalls: 2,
      }),
    );

    expect(receipt).toMatchObject({ units: 5, calls: 5, peak_concurrency: 2 });
    for (let id = 100; id < 105; id += 1) {
      expect(enrichStore.queueEntry(`${String(id)}:someone`)?.status).toBe("done");
    }
  });

  it("halves later waves after a provider timeout", async () => {
    seedUnit("100", "first unit");
    seedUnit("101", "second unit");
    seedUnit("102", "third unit");
    seedUnit("103", "fourth unit");
    let calls = 0;
    const immediate = respondingClient(withEvidence);
    const model: LlmClient = (messages) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new RouterError("timed out", "timeout"));
      return immediate(messages);
    };

    const receipt = await runEnrichTick(deps(model, { unitsPerCall: 1, maxConcurrentCalls: 2 }));
    expect(receipt).toMatchObject({
      units: 3,
      failures: 1,
      calls: 4,
      peak_concurrency: 2,
      provider_backoffs: 1,
    });
  });

  it("charges failed concurrent requests at their conservative reservation", async () => {
    seedUnit("100", "first unit");
    seedUnit("101", "second unit");
    const model: LlmClient = () => Promise.reject(new RouterError("timed out", "timeout"));

    const receipt = await runEnrichTick(
      deps(model, {
        unitsPerCall: 1,
        maxConcurrentCalls: 2,
        ceilings: { maxCostUsd: 0.5, maxCostPerCallUsd: 0.25 },
      }),
    );
    expect(receipt).toMatchObject({
      calls: 2,
      failures: 2,
      cost_usd: 0.5,
      stopped_by: "max_cost_usd",
    });
  });

  it("settles a stalled router body as a durable timeout failure", async () => {
    const unitId = seedUnit("100", "stalled response body");
    const model = createRouterLlmClient({
      hfToken: "t",
      model: "m",
      fetchFn: stalledBodyFetch(),
      requestTimeoutMs: 20,
    });

    const receipt = await runEnrichTick(
      deps(model, {
        unitsPerCall: 1,
        maxConcurrentCalls: 2,
        ceilings: { maxCostUsd: 1, maxCostPerCallUsd: 0.25 },
      }),
    );

    expect(receipt).toMatchObject({
      calls: 1,
      failures: 1,
      cost_usd: 0.25,
      reservation_peak_usd: 0.25,
    });
    expect(enrichStore.queueEntry(unitId)).toMatchObject({
      status: "retrying",
      attempts: 1,
      lastError: "router request timed out",
    });
  });

  it("continues after an affordable partial cost wave", async () => {
    seedUnit("100", "first unit");
    seedUnit("101", "second unit");
    seedUnit("102", "third unit");
    seedUnit("103", "fourth unit");
    const immediate = respondingClient(withEvidence);
    const lowCost: LlmClient = async (messages) => {
      const result = await immediate(messages);
      return { ...result, usage: { ...result.usage, cost_usd: 0.1 } };
    };

    const receipt = await runEnrichTick(
      deps(lowCost, {
        unitsPerCall: 1,
        maxConcurrentCalls: 2,
        ceilings: { maxCostUsd: 0.6, maxCostPerCallUsd: 0.25 },
      }),
    );

    expect(receipt).toMatchObject({ units: 4, calls: 4, cost_usd: 0.4 });
    expect(receipt.stopped_by).toBeUndefined();
  });

  it("persists results, attempt events and registry events to the Bucket log", async () => {
    seedUnit("100", "vllm ships fp8 kernels");
    await runEnrichTick(deps(respondingClient(withEvidence)));
    const row = hubJson("enrichment/2026/07/enrichment-2026-07-06.jsonl") as {
      preset_labels: { name: string; evidence: unknown[] }[];
      free_labels: { name: string; evidence: unknown[] }[];
    };
    expect(row.preset_labels[0]?.name).toBe("ai");
    expect(row.preset_labels[0]?.evidence.length).toBeGreaterThan(0);
    expect(row.free_labels[0]?.name).toBe("dgx-spark");
    expect(hubJson("enrichment/attempts/2026/07/attempts-2026-07-06.jsonl")).toMatchObject({
      first_queued_at: "2026-05-21T03:04:35.954Z",
    });
    const registryShard = log.files.get("enrichment/registry/2026/07/registry-2026-07-06.jsonl");
    const registryNames = (registryShard?.trim().split("\n") ?? []).map(
      (line) => (JSON.parse(line) as { name: string }).name,
    );
    expect(registryNames).toContain("dgx-spark");
    // Free label is a candidate; the public labels endpoint hides it.
    expect(enrichStore.approvedFreeLabels()).toEqual([]);
  });

  it("discards assignments whose quotes are not verbatim substrings of the source tweet", async () => {
    seedUnit("100", "hello world");
    const messy: LlmClient = () =>
      Promise.resolve({
        content: JSON.stringify({
          units: {
            "100:someone": {
              preset_labels: [
                { name: "ai", evidence: [{ tweet_id: "100", quote: "does-not-appear" }] },
              ],
              free_labels: [],
            },
          },
        }),
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    const receipt = await runEnrichTick(deps(messy));
    expect(receipt.discarded_assignments).toBeGreaterThan(0);
    const shard = log.files.get("enrichment/2026/07/enrichment-2026-07-06.jsonl");
    const row = JSON.parse(shard?.trim() ?? "{}") as {
      preset_labels: unknown[];
      free_labels: unknown[];
    };
    expect(row.preset_labels).toEqual([]);
    expect(row.free_labels).toEqual([]);
  });

  it("keeps valid assignments while discarding duplicate, unknown, and rejected assignments", async () => {
    seedUnit("100", "vllm ships fp8 kernels");
    const rejected = enrichStore.candidateEventIfNew("blocked-label").event;
    if (rejected === undefined) throw new Error("expected rejected candidate");
    enrichStore.applyRegistryEvent(rejected);
    enrichStore.rejectName("blocked-label", "test");
    const model: LlmClient = () =>
      Promise.resolve({
        content: JSON.stringify({
          units: {
            "100:someone": {
              preset_labels: [
                { name: "ai", evidence: [{ tweet_id: "100", quote: "vllm" }] },
                { name: "AI", evidence: [{ tweet_id: "100", quote: "fp8" }] },
                { name: "unknown", evidence: [{ tweet_id: "100", quote: "fp8" }] },
              ],
              free_labels: [
                { name: "fp8", evidence: [{ tweet_id: "100", quote: "fp8" }] },
                { name: "fp8", evidence: [{ tweet_id: "100", quote: "fp8" }] },
                { name: "AI", evidence: [{ tweet_id: "100", quote: "vllm" }] },
                { name: "blocked-label", evidence: [{ tweet_id: "100", quote: "vllm" }] },
              ],
            },
          },
        }),
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    const receipt = await runEnrichTick(deps(model));
    expect(receipt.discarded_assignments).toBe(5);
    const row = JSON.parse(
      log.files.get("enrichment/2026/07/enrichment-2026-07-06.jsonl") ?? "{}",
    ) as { preset_labels: { name: string }[]; free_labels: { name: string }[] };
    expect(row.preset_labels.map((assignment) => assignment.name)).toEqual(["ai"]);
    expect(row.free_labels.map((assignment) => assignment.name)).toEqual(["fp8"]);
  });

  it("tolerates fenced responses and returns an empty receipt for an empty queue", async () => {
    seedUnit("100", "hello");
    const fenced: LlmClient = (messages) => {
      const user = messages.find((message) => message.role === "user");
      const payload = JSON.parse(user?.content ?? "{}") as {
        units: { unit_id: string; text: string }[];
      };
      const texts = new Map(payload.units.map((entry) => [entry.unit_id, entry.text]));
      const body = withEvidence(
        payload.units.map((u) => u.unit_id),
        texts,
      );
      return Promise.resolve({
        content: `\`\`\`json\n${body}\n\`\`\``,
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    await expect(runEnrichTick(deps(fenced))).resolves.toMatchObject({ units: 1, failures: 0 });
    log.commits.length = 0;
    const idle = await runEnrichTick(deps(fenced));
    expect(idle).toMatchObject({ units: 0, calls: 0, failures: 0 });
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0]?.title).toBe("enrich: 0 units");
  });

  it("persists an explicit idle receipt for a scheduled Job canary", async () => {
    const receipt = await runEnrichTick(
      deps(respondingClient(withEvidence), { workerId: "job-1", writeEmptyReceipt: true }),
    );

    expect(receipt).toMatchObject({ units: 0, calls: 0, failures: 0, worker_id: "job-1" });
    expect(hubJson("enrichment/receipts/2026-07-06.jsonl")).toMatchObject({
      units: 0,
      calls: 0,
      worker_id: "job-1",
    });
  });

  it("blocks a unit after MAX_ATTEMPTS transient failures", async () => {
    const unitId = seedUnit("100", "hello vLLM is fast");
    const failing: LlmClient = () => Promise.reject(new Error("router down"));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const receipt = await runEnrichTick(deps(failing));
      expect(receipt.calls).toBe(1);
      if (attempt < MAX_ATTEMPTS) {
        store.database.prepare("UPDATE enrich_queue SET next_retry_at = NULL").run();
      }
    }
    const entry = enrichStore.queueEntry(unitId);
    expect(entry?.status).toBe("blocked");
    expect(entry?.attempts).toBe(MAX_ATTEMPTS);
    await expect(runEnrichTick(deps(failing))).resolves.toMatchObject({ calls: 0 });
  });

  it("fails units missing from the response and units with unparseable output", async () => {
    const unitId = seedUnit("100", "hello vLLM is fast");
    const empty: LlmClient = () =>
      Promise.resolve({
        content: '{"units": {}}',
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    await expect(runEnrichTick(deps(empty))).resolves.toMatchObject({ units: 0, failures: 1 });
    const afterMissing = enrichStore.queueEntry(unitId);
    expect(afterMissing?.status).toBe("retrying");
    expect(afterMissing?.attempts).toBe(1);
    expect(afterMissing?.lastError).toBe("unit missing from model response");
    store.database.prepare("UPDATE enrich_queue SET next_retry_at = NULL").run();
    const garbage: LlmClient = () =>
      Promise.resolve({
        content: "no json here",
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    await expect(runEnrichTick(deps(garbage))).resolves.toMatchObject({ failures: 1 });
    expect(enrichStore.queueEntry(unitId)?.lastError).toBe("unparseable model response");
  });

  it("marks the batch retrying and keeps SQLite untouched when the commit fails", async () => {
    const unitId = seedUnit("100", "vllm fp8");
    log.failNextCommit = true;
    const receipt = await runEnrichTick(deps(respondingClient(withEvidence)));
    expect(receipt).toMatchObject({ units: 0, failures: 1 });
    const entry = enrichStore.queueEntry(unitId);
    expect(entry?.status).toBe("retrying");
    expect(entry?.attempts).toBe(1);
    expect(entry?.lastError).toBe("Bucket unavailable");
    expect(store.query({ labels: ["ai"] }).records).toHaveLength(0);
  });

  it("emits a prompt that names the taxonomy and known-bad rejections", async () => {
    seedUnit("100", "vllm");
    const captured: LlmMessage[][] = [];
    await runEnrichTick(deps(respondingClient(withEvidence, captured)));
    const system = captured[0]?.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain('"inference-performance"');
    expect(system).toContain("quality-philosophy");
    expect(system).toContain("deixis");
    const user = captured[0]?.find((message) => message.role === "user")?.content ?? "{}";
    expect(user).toContain('"tweet_id":"100"');
    expect(user).toContain('"posts"');
  });

  // The fixture deliberately exercises every semantic input field.
  // eslint-disable-next-line complexity
  it("sends every semantic field without diverging from the full input hash", async () => {
    const root = makePooled({
      id: "100",
      conversation_id: "100",
      text: "x".repeat(4_100),
      expanded_urls: ["https://huggingface.co/acme/model"],
      is_subscriber_only: true,
    });
    const reply = makePooled({
      id: "101",
      conversation_id: "100",
      text: "reply evidence",
      in_reply_to_status_id: "100",
      quoted_status_id: "99",
      is_retweet: true,
    });
    store.insert([root, reply]);
    enrichStore.registerTweets([root, reply]);
    const captured: LlmMessage[][] = [];
    await runEnrichTick(deps(respondingClient(withEvidence, captured)));
    const user = captured[0]?.find((message) => message.role === "user")?.content ?? "{}";
    const payload = JSON.parse(user) as {
      units: {
        posts: {
          tweet_id: string;
          text: string;
          expanded_urls: string[];
          reply_to?: string;
          quoted_status_id?: string;
          is_retweet: boolean;
        }[];
      }[];
    };
    const posts = payload.units[0]?.posts ?? [];
    expect(posts.map((post) => post.tweet_id)).toEqual(["100", "101"]);
    expect(posts[0]?.text).toHaveLength(4_100);
    expect(posts[1]).toMatchObject({
      text: "reply evidence",
      reply_to: "100",
      quoted_status_id: "99",
      is_retweet: true,
    });
    expect(posts[0]?.expanded_urls).toEqual(["https://huggingface.co/acme/model"]);
    const shard = log.files.get("enrichment/2026/07/enrichment-2026-07-06.jsonl") ?? "";
    expect((JSON.parse(shard) as { tweet_ids: string[] }).tweet_ids).toEqual(["100", "101"]);
    expect(enrichStore.queueEntry("100:someone")?.status).toBe("done");
  });

  it("counts failed units once and keeps error-rate accounting bounded", async () => {
    seedUnit("100", "first");
    seedUnit("101", "second");
    seedUnit("102", "third");
    const failing: LlmClient = () => Promise.reject(new Error("router down"));
    const receipt = await runEnrichTick(deps(failing, { unitsPerCall: 1 }));
    expect(receipt).toMatchObject({ calls: 3, failures: 3, retries: 3 });
    expect(receipt.stopped_by).toBeUndefined();
    expect(receipt.failures / (receipt.units + receipt.failures)).toBeLessThanOrEqual(1);
  });

  it("fails closed before an unmeasurable or projected-over-budget provider call", async () => {
    seedUnit("100", "vllm");
    const model = vi.fn<LlmClient>(() => Promise.reject(new Error("should not run")));
    const unmeasured = await runEnrichTick(deps(model, { ceilings: { maxCostUsd: 1 } }));
    expect(unmeasured).toMatchObject({ calls: 0, stopped_by: "cost_unmeasured" });
    const projected = await runEnrichTick(
      deps(model, { ceilings: { maxCostUsd: 0.01, maxCostPerCallUsd: 0.02 } }),
    );
    expect(projected).toMatchObject({ calls: 0, stopped_by: "max_cost_usd" });
    expect(model).not.toHaveBeenCalled();
  });

  it("stops after a call whose configured-cost result cannot be measured", async () => {
    seedUnit("100", "vllm");
    const model = respondingClient(withEvidence);
    const receipt = await runEnrichTick(
      deps(model, { ceilings: { maxCostUsd: 1, maxCostPerCallUsd: 0.5 } }),
    );
    expect(receipt).toMatchObject({ calls: 1, failures: 1, stopped_by: "cost_unmeasured" });
    expect(enrichStore.queueEntry("100:someone")?.status).toBe("retrying");
  });

  it("keeps an unmeasured concurrent cost fail-closed for later waves", async () => {
    seedUnit("100", "first");
    seedUnit("101", "second");
    seedUnit("102", "third");
    let calls = 0;
    const immediate = respondingClient(withEvidence);
    const model: LlmClient = async (messages) => {
      const call = ++calls;
      const result = await immediate(messages);
      return call === 2 ? { ...result, usage: { ...result.usage, cost_usd: 0.1 } } : result;
    };

    const receipt = await runEnrichTick(
      deps(model, {
        unitsPerCall: 1,
        maxConcurrentCalls: 2,
        ceilings: { maxCostUsd: 1, maxCostPerCallUsd: 0.25 },
      }),
    );

    expect(receipt).toMatchObject({ calls: 2, cost_usd: undefined, stopped_by: "cost_unmeasured" });
    expect(enrichStore.queueEntry("102:someone")?.status).toBe("pending");
  });

  it("honors a zero-valued elapsed ceiling before leasing provider work", async () => {
    seedUnit("100", "vllm");
    const model = vi.fn<LlmClient>(() => Promise.reject(new Error("should not run")));
    await expect(
      runEnrichTick(deps(model, { ceilings: { maxElapsedMs: 0 } })),
    ).resolves.toMatchObject({
      stopped_by: "max_elapsed",
      calls: 0,
    });
    expect(model).not.toHaveBeenCalled();
  });

  it("allows clean work under zero-valued error and discard-rate ceilings", async () => {
    seedUnit("100", "vllm ships fp8 kernels");
    const receipt = await runEnrichTick(
      deps(respondingClient(withEvidence), {
        ceilings: {
          maxErrorRate: 0,
          maxDiscardedAssignmentsPerUnit: 0,
          discardedAssignmentRateMinUnits: 1,
        },
      }),
    );
    expect(receipt).toMatchObject({ calls: 1, units: 1, failures: 0, discarded_assignments: 0 });
    expect(receipt.stopped_by).toBeUndefined();
  });

  it("does not turn a healthy discarded-assignment rate into a volume ceiling", async () => {
    for (let id = 100; id < 120; id += 1) seedUnit(String(id), `unit ${String(id)}`);
    const reply = (unitIds: string[], texts: Map<string, string>): string =>
      withSelectedDiscardedPreset(
        unitIds,
        texts,
        (unitId) => Number(unitId.split(":")[0]) % 10 === 0,
      );

    const receipt = await runEnrichTick(
      deps(respondingClient(reply), {
        unitsPerCall: 1,
        ceilings: {
          maxDiscardedAssignmentsPerUnit: 0.25,
          discardedAssignmentRateMinUnits: 10,
        },
      }),
    );

    expect(receipt).toMatchObject({ calls: 20, units: 20, discarded_assignments: 2 });
    expect(receipt.stopped_by).toBeUndefined();
  });

  it("waits for the minimum sample before enforcing discarded-assignment quality", async () => {
    for (let id = 100; id < 104; id += 1) seedUnit(String(id), `unit ${String(id)}`);
    const reply = (unitIds: string[], texts: Map<string, string>): string =>
      withSelectedDiscardedPreset(unitIds, texts, (unitId) => Number(unitId.split(":")[0]) < 102);

    const receipt = await runEnrichTick(
      deps(respondingClient(reply), {
        unitsPerCall: 1,
        ceilings: {
          maxDiscardedAssignmentsPerUnit: 0.5,
          discardedAssignmentRateMinUnits: 3,
        },
      }),
    );

    expect(receipt).toMatchObject({
      calls: 3,
      units: 3,
      discarded_assignments: 2,
      stopped_by: "max_discarded_assignments_per_unit",
    });
    expect(enrichStore.queueEntry("103:someone")?.status).toBe("pending");
  });

  it("fails closed when only one discarded-assignment rate setting is supplied", async () => {
    seedUnit("100", "vllm ships fp8 kernels");
    const model = vi.fn<LlmClient>(() => Promise.reject(new Error("should not run")));

    await expect(
      runEnrichTick(
        deps(model, {
          ceilings: { maxDiscardedAssignmentsPerUnit: 0.15 },
        }),
      ),
    ).rejects.toThrow("must be configured together");
    expect(model).not.toHaveBeenCalled();
  });

  it("stops after the first failure under a zero error-rate ceiling", async () => {
    const first = seedUnit("100", "first");
    const second = seedUnit("101", "second");
    const failing: LlmClient = () => Promise.reject(new Error("router down"));
    const receipt = await runEnrichTick(
      deps(failing, {
        unitsPerCall: 1,
        ceilings: { maxErrorRate: 0 },
      }),
    );
    expect(receipt).toMatchObject({ calls: 1, failures: 1, stopped_by: "max_error_rate" });
    expect(enrichStore.queueEntry(first)?.status).toBe("retrying");
    expect(enrichStore.queueEntry(second)?.status).toBe("pending");
  });

  it("rejects any model unit that has a third output key", async () => {
    const unitId = seedUnit("100", "vllm ships fp8 kernels");
    const invalid: LlmClient = () =>
      Promise.resolve({
        content: JSON.stringify({
          units: {
            [unitId]: { preset_labels: [], free_labels: [], concepts: [] },
          },
        }),
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    await expect(runEnrichTick(deps(invalid))).resolves.toMatchObject({ failures: 1, units: 0 });
    expect(enrichStore.queueEntry(unitId)?.status).toBe("retrying");
  });

  it("releases claimed units that were not processed after a safety ceiling", async () => {
    const first = seedUnit("100", "vllm ships fp8 kernels");
    const second = seedUnit("101", "vllm ships fp8 kernels");
    const base = respondingClient(withEvidence);
    const metered: LlmClient = async (messages) => ({
      ...(await base(messages)),
      usage: { prompt_tokens: 11, completion_tokens: 7, cost_usd: 0.1 },
    });
    const receipt = await runEnrichTick(
      deps(metered, {
        unitsPerCall: 1,
        ceilings: { maxCostUsd: 0.25, maxCostPerCallUsd: 0.2 },
      }),
    );
    expect(receipt).toMatchObject({ units: 1, stopped_by: "max_cost_usd" });
    expect(enrichStore.queueEntry(first)?.status).toBe("done");
    expect(enrichStore.queueEntry(second)?.status).toBe("pending");
  });

  it("promotes a verified Hub reference only after its candidate row is committed", async () => {
    seedUnit("100", "the new release runs quickly on our local hardware");
    const verifyHubLabel = vi.fn(() => Promise.resolve(true));
    await runEnrichTick(
      deps(
        respondingClient((unitIds) =>
          JSON.stringify({
            units: Object.fromEntries(
              unitIds.map((unitId) => [
                unitId,
                {
                  preset_labels: [],
                  free_labels: [
                    {
                      name: "verified-model",
                      evidence: [{ tweet_id: "100", quote: "new release runs quickly" }],
                    },
                  ],
                },
              ]),
            ),
          }),
        ),
        { verifyHubLabel },
      ),
    );
    expect(verifyHubLabel).toHaveBeenCalledWith("verified-model", expect.any(Array));
    expect(enrichStore.registryStatus("verified-model")).toBe("approved");
    const events = log.files.get("enrichment/registry/2026/07/registry-2026-07-06.jsonl") ?? "";
    expect(events).toContain("verified-hub-reference");
  });

  it("persists every planned registry scan even when the candidate stays unchanged", async () => {
    recordCandidate("below-threshold-model");
    const outputs: Parameters<NonNullable<EnrichWorkerDeps["durableOutput"]>>[0][] = [];
    const receipt = await runEnrichTick(
      deps(respondingClient(withEvidence), {
        verifyHubLabel: () => Promise.resolve(false),
        registryPlan: {
          names: ["below-threshold-model"],
          baselineOrdinal: 0,
          nextOrdinal: 0,
          total: 1,
        },
        durableOutput: (output) => {
          outputs.push(output);
          return Promise.resolve();
        },
      }),
    );
    expect(receipt.registry_scan).toEqual({
      after_name: "below-threshold-model",
      scanned: 1,
      total: 1,
      complete: true,
    });
    expect(outputs).toEqual([
      expect.objectContaining({
        kind: "registry",
        decisions: [
          expect.objectContaining({
            name: "below-threshold-model",
            status: "candidate",
            reason: "reviewed-no-transition",
          }),
        ],
      }),
      expect.objectContaining({ kind: "receipt" }),
    ]);
  });

  it("persists a receipt for a registry-only decision", async () => {
    seedUnit("100", "the new release runs quickly on our local hardware");
    const response = respondingClient((unitIds) =>
      JSON.stringify({
        units: Object.fromEntries(
          unitIds.map((unitId) => [
            unitId,
            {
              preset_labels: [],
              free_labels: [
                {
                  name: "registry-only-model",
                  evidence: [{ tweet_id: "100", quote: "new release runs quickly" }],
                },
              ],
            },
          ]),
        ),
      }),
    );
    await runEnrichTick(deps(response));
    log.commits.length = 0;
    const receipt = await runEnrichTick(
      deps(response, { verifyHubLabel: () => Promise.resolve(true) }),
    );
    expect(receipt).toMatchObject({ units: 0, new_approvals: 1 });
    const receiptShard = log.files.get("enrichment/receipts/2026-07-06.jsonl") ?? "";
    expect(receiptShard).toContain('"new_approvals":1');
  });

  it("does not turn a checkpoint failure after durable success into a failed attempt", async () => {
    seedUnit("100", "local model evidence");
    const response = respondingClient(withEvidence);
    await expect(
      runEnrichTick(
        deps(response, {
          durableOutput: (output) =>
            output.kind === "queue"
              ? Promise.reject(new Error("checkpoint unavailable"))
              : Promise.resolve(),
        }),
      ),
    ).rejects.toThrow("checkpoint unavailable");
    const attempts = log.files.get("enrichment/attempts/2026/07/attempts-2026-07-06.jsonl");
    expect(attempts).toContain('"outcome":"success"');
    expect(attempts).not.toContain("commit_failed");
    expect(log.commits.some((commit) => commit.title.startsWith("enrich: 1 units"))).toBe(true);
  });

  it("verifies Hub candidates concurrently and commits decisions in name order", async () => {
    recordCandidate("alpha-model");
    recordCandidate("beta-model");
    recordCandidate("gamma-model");
    const resolveChecks: (() => void)[] = [];
    const verifyHubLabel = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveChecks.push(() => {
            resolve(true);
          });
        }),
    );

    const running = runEnrichTick(
      deps(respondingClient(withEvidence), { maxConcurrentCalls: 3, verifyHubLabel }),
    );
    await vi.waitFor(() => {
      expect(resolveChecks).toHaveLength(3);
    });
    for (const resolve of resolveChecks.reverse()) resolve();

    const receipt = await running;
    expect(receipt.registry_scan).toMatchObject({ scanned: 3, total: 3, complete: true });
    expect(receipt.new_approvals).toBe(3);
    const events = (log.files.get("enrichment/registry/2026/07/registry-2026-07-06.jsonl") ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string });
    expect(events.map((event) => event.name)).toEqual(["alpha-model", "beta-model", "gamma-model"]);
  });

  it("saves an incomplete registry cursor and resumes after its last durable candidate", async () => {
    recordCandidate("alpha-model");
    recordCandidate("beta-model");
    recordCandidate("gamma-model");
    let elapsedMs = 0;
    const firstChecks: string[] = [];
    const first = await runEnrichTick(
      deps(respondingClient(withEvidence), {
        maxConcurrentCalls: 1,
        now: () => new Date(NOW.getTime() + elapsedMs),
        ceilings: { maxElapsedMs: 15 },
        verifyHubLabel: (name) => {
          firstChecks.push(name);
          elapsedMs += 10;
          return Promise.resolve(true);
        },
      }),
    );
    expect(firstChecks).toEqual(["alpha-model", "beta-model"]);
    expect(first).toMatchObject({
      stopped_by: "max_elapsed",
      new_approvals: 1,
      registry_scan: { after_name: "alpha-model", scanned: 1, total: 3, complete: false },
    });
    expect(enrichStore.registryStatus("alpha-model")).toBe("approved");
    log.receipt = first;

    const resumedChecks: string[] = [];
    const resumed = await runEnrichTick(
      deps(respondingClient(withEvidence), {
        maxConcurrentCalls: 1,
        verifyHubLabel: (name) => {
          resumedChecks.push(name);
          return Promise.resolve(true);
        },
      }),
    );
    expect(resumedChecks).toEqual(["beta-model", "gamma-model"]);
    expect(resumed.registry_scan).toEqual({
      after_name: "gamma-model",
      scanned: 3,
      total: 3,
      complete: true,
    });
  });

  it("saves an interrupted local-only scan without optional review callbacks", async () => {
    recordCandidate("alpha-model");
    recordCandidate("beta-model");
    let nowCalls = 0;

    const receipt = await runEnrichTick(
      deps(respondingClient(withEvidence), {
        maxConcurrentCalls: 1,
        now: () => {
          nowCalls += 1;
          return new Date(NOW.getTime() + (nowCalls >= 8 ? 10 : 0));
        },
        ceilings: { maxElapsedMs: 5 },
      }),
    );

    expect(receipt).toMatchObject({
      stopped_by: "max_elapsed",
      registry_scan: { after_name: "alpha-model", scanned: 1, total: 2, complete: false },
    });
    expect(log.files.get("enrichment/receipts/2026-07-06.jsonl")).toContain(
      '"after_name":"alpha-model"',
    );
  });

  it("starts a fresh registry scan after new enrichment work", async () => {
    recordCandidate("beta-model");
    log.receipt = {
      started_at: "2026-07-06T10:00:00.000Z",
      finished_at: "2026-07-06T11:00:00.000Z",
      units: 0,
      calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      failures: 0,
      retries: 0,
      blocked: 0,
      contract_hash: CONTRACT_HASH,
      worker_id: "prior-worker",
      discarded_assignments: 0,
      new_candidates: 0,
      new_approvals: 0,
      new_rejections: 0,
      registry_scan: { after_name: "zeta-model", scanned: 4, total: 8, complete: false },
    };
    seedUnit("100", "new post");
    const checked: string[] = [];
    const emptyLabels = respondingClient((unitIds) =>
      JSON.stringify({
        units: Object.fromEntries(
          unitIds.map((unitId) => [unitId, { preset_labels: [], free_labels: [] }]),
        ),
      }),
    );

    const receipt = await runEnrichTick(
      deps(emptyLabels, {
        verifyHubLabel: (name) => {
          checked.push(name);
          return Promise.resolve(false);
        },
      }),
    );

    expect(receipt.units).toBe(1);
    expect(checked).toEqual(["beta-model"]);
    expect(receipt.registry_scan).toMatchObject({ scanned: 1, total: 1, complete: true });
  });

  it("meters a constrained registry review and applies its exact verdict", async () => {
    seedReviewCandidates(
      ["opaque-subject", "opaque-subject-rejected", "opaque-subject-unknown-cost"],
      ["opaque-subject", "opaque-subject-rejected"],
    );
    expect(enrichStore.promotionSignals("opaque-subject")).toEqual({
      units: 15,
      authors: 8,
      days: 2,
    });
    const receipt = await runEnrichTick(
      deps(respondingClient(withEvidence), {
        judgeFreeLabel: (name) =>
          Promise.resolve({
            verdict: name !== "opaque-subject-rejected",
            usage: { prompt_tokens: 4, completion_tokens: 2, cost_usd: 0.03 },
          }),
      }),
    );
    expect(receipt).toMatchObject({
      units: 0,
      calls: 2,
      prompt_tokens: 8,
      completion_tokens: 4,
      cost_usd: 0.06,
      new_approvals: 1,
      new_rejections: 1,
    });
    expect(enrichStore.registryStatus("opaque-subject")).toBe("approved");
    expect(enrichStore.registryStatus("opaque-subject-rejected")).toBe("rejected");

    recordCandidate("opaque-subject-unknown-cost");
    const unmeasured = await runEnrichTick(
      deps(respondingClient(withEvidence), {
        judgeFreeLabel: () =>
          Promise.resolve({ verdict: true, usage: { prompt_tokens: 4, completion_tokens: 2 } }),
        ceilings: { maxCostUsd: 1, maxCostPerCallUsd: 0.25 },
      }),
    );
    expect(unmeasured).toMatchObject({
      calls: 1,
      cost_usd: undefined,
      stopped_by: "cost_unmeasured",
    });
  });

  it("checks elapsed time between serial constrained reviews", async () => {
    seedReviewCandidates(["alpha-opaque", "beta-opaque"]);
    let elapsedMs = 0;
    const reviewed: string[] = [];

    const receipt = await runEnrichTick(
      deps(respondingClient(withEvidence), {
        maxConcurrentCalls: 2,
        now: () => new Date(NOW.getTime() + elapsedMs),
        ceilings: { maxElapsedMs: 5 },
        judgeFreeLabel: (name) => {
          reviewed.push(name);
          elapsedMs += 10;
          return Promise.resolve({
            verdict: true,
            usage: { prompt_tokens: 4, completion_tokens: 2, cost_usd: 0.03 },
          });
        },
      }),
    );

    expect(reviewed).toEqual(["alpha-opaque"]);
    expect(receipt).toMatchObject({
      stopped_by: "max_elapsed",
      new_approvals: 1,
      registry_scan: { after_name: "alpha-opaque", scanned: 1, total: 2, complete: false },
    });
    expect(enrichStore.registryStatus("alpha-opaque")).toBe("approved");
    expect(enrichStore.registryStatus("beta-opaque")).toBe("candidate");
  });

  it("assigns strictly increasing registry revisions to multiple discoveries in one batch", async () => {
    seedUnit("100", "first label subject");
    seedUnit("101", "second label subject");
    await runEnrichTick(
      deps(
        respondingClient((unitIds) =>
          JSON.stringify({
            units: Object.fromEntries(
              unitIds.map((unitId, index) => [
                unitId,
                {
                  preset_labels: [],
                  free_labels: [
                    {
                      name: `subject-${String(index + 1)}`,
                      evidence: [
                        {
                          tweet_id: unitId.split(":")[0],
                          quote: index === 0 ? "first label subject" : "second label subject",
                        },
                      ],
                    },
                  ],
                },
              ]),
            ),
          }),
        ),
      ),
    );
    const events = (log.files.get("enrichment/registry/2026/07/registry-2026-07-06.jsonl") ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { registry_revision: number });
    expect(events.map((event) => event.registry_revision)).toEqual([2, 3, 4, 5]);
  });
});

describe("free-label regression fixtures", () => {
  it("emoji-only reply produces zero free labels", async () => {
    seedUnit("100", "🎉🚀");
    const model: LlmClient = () =>
      Promise.resolve({
        content: JSON.stringify({
          units: {
            "100:someone": {
              preset_labels: [],
              free_labels: [{ name: "celebration", evidence: [{ tweet_id: "100", quote: "🎉" }] }],
            },
          },
        }),
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    const receipt = await runEnrichTick(deps(model));
    expect(receipt.units).toBe(1);
    expect(receipt.discarded_assignments).toBeGreaterThan(0);
    const shard = log.files.get("enrichment/2026/07/enrichment-2026-07-06.jsonl");
    const row = JSON.parse(shard?.trim() ?? "{}") as { free_labels: unknown[] };
    expect(row.free_labels).toEqual([]);
  });

  it("DGX enclosure post never yields an unsupported `manufacturing` label", async () => {
    const text = "unboxed the DGX Spark enclosure; it is compact and quiet";
    seedUnit("100", text);
    const model: LlmClient = () =>
      Promise.resolve({
        content: JSON.stringify({
          units: {
            "100:someone": {
              preset_labels: [],
              free_labels: [
                {
                  name: "manufacturing",
                  evidence: [{ tweet_id: "100", quote: "DGX Spark enclosure" }],
                },
                { name: "dgx-spark", evidence: [{ tweet_id: "100", quote: "DGX Spark" }] },
              ],
            },
          },
        }),
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    await runEnrichTick(deps(model));
    const shard = log.files.get("enrichment/2026/07/enrichment-2026-07-06.jsonl");
    const row = JSON.parse(shard?.trim() ?? "{}") as {
      free_labels: { name: string }[];
    };
    expect(row.free_labels.map((entry) => entry.name)).toEqual(["dgx-spark"]);
    expect(row.free_labels.map((entry) => entry.name)).not.toContain("manufacturing");
  });

  it("the word `frontier` never yields `quality-philosophy`", async () => {
    seedUnit("100", "frontier models keep improving");
    const model: LlmClient = () =>
      Promise.resolve({
        content: JSON.stringify({
          units: {
            "100:someone": {
              preset_labels: [],
              free_labels: [
                {
                  name: "quality-philosophy",
                  evidence: [{ tweet_id: "100", quote: "frontier models" }],
                },
                {
                  name: "frontier-model",
                  evidence: [{ tweet_id: "100", quote: "frontier models" }],
                },
              ],
            },
          },
        }),
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    await runEnrichTick(deps(model));
    const shard = log.files.get("enrichment/2026/07/enrichment-2026-07-06.jsonl");
    const row = JSON.parse(shard?.trim() ?? "{}") as { free_labels: { name: string }[] };
    expect(row.free_labels.map((entry) => entry.name)).toEqual(["frontier-model"]);
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
    const result = await client([{ role: "user", content: "hi" }], { maxCompletionTokens: 42 });
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
      max_tokens: 42,
    });
  });

  it("throws on router errors and incomplete usage", async () => {
    const failingFetch: typeof fetch = () => Promise.resolve(new Response("nope", { status: 500 }));
    const failing = createRouterLlmClient({ hfToken: "t", model: "m", fetchFn: failingFetch });
    await expect(failing([{ role: "user", content: "hi" }])).rejects.toThrow(
      "router request failed (500)",
    );

    const noUsageFetch: typeof fetch = () =>
      Promise.resolve(Response.json({ choices: [{ message: { content: "{}" } }] }));
    const noUsage = createRouterLlmClient({ hfToken: "t", model: "m", fetchFn: noUsageFetch });
    await expect(noUsage([{ role: "user", content: "hi" }])).rejects.toThrow();

    const incompleteUsageFetch: typeof fetch = () =>
      Promise.resolve(Response.json({ choices: [{ message: { content: "{}" } }], usage: {} }));
    const incompleteUsage = createRouterLlmClient({
      hfToken: "t",
      model: "m",
      fetchFn: incompleteUsageFetch,
    });
    await expect(incompleteUsage([{ role: "user", content: "hi" }])).rejects.toThrow();
  });

  it("classifies rate-limit, provider and timeout failures", async () => {
    const failure =
      (status: number): typeof fetch =>
      () =>
        Promise.resolve(new Response("no", { status }));
    await expect(
      createRouterLlmClient({ hfToken: "t", model: "m", fetchFn: failure(429) })([]),
    ).rejects.toMatchObject({ errorClass: "rate_limit" });
    await expect(
      createRouterLlmClient({ hfToken: "t", model: "m", fetchFn: failure(400) })([]),
    ).rejects.toMatchObject({ errorClass: "provider_4xx" });
    const aborted: typeof fetch = () => Promise.reject(new DOMException("aborted", "AbortError"));
    await expect(
      createRouterLlmClient({ hfToken: "t", model: "m", fetchFn: aborted })([]),
    ).rejects.toMatchObject({ errorClass: "timeout" });
  });

  it("keeps the deadline active through success and error response bodies", async () => {
    const success = createRouterLlmClient({
      hfToken: "t",
      model: "m",
      fetchFn: stalledBodyFetch(),
      requestTimeoutMs: 20,
    });
    const failure = createRouterLlmClient({
      hfToken: "t",
      model: "m",
      fetchFn: stalledBodyFetch(500),
      requestTimeoutMs: 20,
    });

    await expect(success([])).rejects.toMatchObject({ errorClass: "timeout" });
    await expect(failure([])).rejects.toMatchObject({ errorClass: "timeout" });
  });

  it("rejects an oversized response body before parsing", async () => {
    const client = createRouterLlmClient({
      hfToken: "t",
      model: "m",
      fetchFn: () => Promise.resolve(new Response("123456789")),
      maxResponseBytes: 8,
    });

    await expect(client([])).rejects.toMatchObject({ errorClass: "invalid_output" });
  });

  it("computes configured token pricing when the router omits a cost", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        }),
      );
    const client = createRouterLlmClient({
      hfToken: "t",
      model: "m",
      fetchFn,
      pricing: { inputTokenUsd: 0.1, outputTokenUsd: 0.2 },
    });
    await expect(client([{ role: "user", content: "hi" }])).resolves.toMatchObject({
      usage: { cost_usd: 1 },
    });
  });

  it("uses provider-reported direct and usage costs before configured pricing", async () => {
    const direct: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          cost: 0.3,
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }),
      );
    const usage: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0.2 },
        }),
      );
    await expect(
      createRouterLlmClient({ hfToken: "t", model: "m", fetchFn: direct })([]),
    ).resolves.toMatchObject({ usage: { cost_usd: 0.3 } });
    await expect(
      createRouterLlmClient({ hfToken: "t", model: "m", fetchFn: usage })([]),
    ).resolves.toMatchObject({ usage: { cost_usd: 0.2 } });
  });
});

describe("registry verifiers", () => {
  it("verifies only an exact public Hub reference grounded in evidence", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ id: "acme/model" })));
    const verify = createExactHubVerifier(fetchFn);
    await expect(
      verify("acme-model", [
        {
          name: "acme-model",
          evidence: [{ tweet_id: "1", quote: "https://huggingface.co/acme/model" }],
        },
      ]),
    ).resolves.toBe(true);
    await expect(
      verify("different-name", [
        {
          name: "different-name",
          evidence: [{ tweet_id: "1", quote: "https://huggingface.co/acme/model" }],
        },
      ]),
    ).resolves.toBe(false);
    await expect(verify("acme-model", [])).resolves.toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("tries the dataset endpoint after a missing model and treats errors as unverified", async () => {
    const dataset = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(Response.json({ id: "acme/data" }));
    await expect(
      createExactHubVerifier(dataset)("acme-data", [
        {
          name: "acme-data",
          evidence: [{ tweet_id: "1", quote: "huggingface.co/datasets/acme/data" }],
        },
      ]),
    ).resolves.toBe(true);
    const failed: typeof fetch = () => Promise.reject(new Error("offline"));
    await expect(
      createExactHubVerifier(failed)("acme-data", [
        { name: "acme-data", evidence: [{ tweet_id: "1", quote: "huggingface.co/acme/data" }] },
      ]),
    ).resolves.toBe(false);
    const missing: typeof fetch = () => Promise.resolve(new Response("missing", { status: 404 }));
    await expect(
      createExactHubVerifier(missing)("acme-data", [
        { name: "acme-data", evidence: [{ tweet_id: "1", quote: "huggingface.co/acme/data" }] },
      ]),
    ).resolves.toBe(false);
  });

  it("uses a strict approve/reject/abstain-only review contract", async () => {
    const approved: LlmClient = () =>
      Promise.resolve({
        content: '{"decision":"approve"}',
        usage: { prompt_tokens: 2, completion_tokens: 1, cost_usd: 0.01 },
      });
    const abstaining: LlmClient = () =>
      Promise.resolve({ content: "not-json", usage: { prompt_tokens: 0, completion_tokens: 0 } });
    await expect(
      createFreeLabelJudge(approved)("vllm", [{ tweet_id: "1", quote: "vLLM is fast" }]),
    ).resolves.toMatchObject({ verdict: true, usage: { cost_usd: 0.01 } });
    await expect(
      createFreeLabelJudge(abstaining)("vllm", [{ tweet_id: "1", quote: "vLLM is fast" }]),
    ).resolves.toMatchObject({ verdict: undefined });
    const rejecting: LlmClient = () =>
      Promise.resolve({
        content: '{"decision":"reject"}',
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    await expect(
      createFreeLabelJudge(rejecting)("vllm", [{ tweet_id: "1", quote: "vLLM is fast" }]),
    ).resolves.toMatchObject({ verdict: false });
    const abstains: LlmClient = () =>
      Promise.resolve({
        content: '{"decision":"abstain"}',
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    await expect(
      createFreeLabelJudge(abstains)("vllm", [{ tweet_id: "1", quote: "vLLM is fast" }]),
    ).resolves.toMatchObject({ verdict: undefined });

    const capped = vi.fn<LlmClient>(() => Promise.reject(new Error("should not run")));
    await expect(
      createFreeLabelJudge(capped)("vllm", [{ tweet_id: "1", quote: "vLLM is fast" }], 1),
    ).resolves.toMatchObject({ verdict: undefined, stopped_by: "max_tokens" });
    expect(capped).not.toHaveBeenCalled();
  });
});
