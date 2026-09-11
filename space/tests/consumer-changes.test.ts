import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { computeInputHash, unitIdFor } from "@xtap-pool/shared";
import type { PooledTweet } from "@xtap-pool/shared";
import { TweetStore } from "../src/store.js";
import { EnrichStore } from "../src/enrich-store.js";
import { ConsumerChangeEngine } from "../src/consumer-changes.js";
import { HistoricalUnitReader } from "../src/historical-unit-reader.js";
import { consumerRegistry } from "../src/consumer-registry.js";
import { CONSUMER_PROJECTION_HASH } from "../src/consumer-index-state.js";
import type { ResolvedConsumerContext } from "../src/consumer-context.js";
import type { ConsumerCursor } from "../src/consumer-cursor.js";
import type { ConsumerChange } from "../src/consumer-page.js";
import { makePooled } from "./helpers.js";
import { consumerQueryPlan } from "./consumer-query-plan.js";

const contract = "a".repeat(64);
const now = "2026-09-07T12:00:00.000Z";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let store: TweetStore;
let enrich: EnrichStore;
let keys: string[];
function source() {
  const key = `v1/segments/mixed/2026/09/07/${String(keys.length).padStart(13, "0")}-00000000-0000-4000-8000-000000000000-${hash(keys)}.json.gz`;
  keys.push(key);
  return { segmentKey: key, path: "fixture.jsonl", operation: 0, position: 0 };
}
function tweet(id = "100", patch: Record<string, unknown> = {}) {
  return makePooled({
    id,
    conversation_id: id,
    text: "model release",
    author: { id: "11", username: "a" },
    captured_at: "2026-09-06T00:00:00.000Z",
    pooled_at: "2026-09-06T00:01:00.000Z",
    ...patch,
  });
}
function post(value: PooledTweet) {
  const ref = source();
  store.observations.record(value, ref);
  store.sourceEffects.recordPost(value, ref);
  store.insert([value]);
  enrich.registerTweets([value]);
}
function result(value: PooledTweet) {
  const id = unitIdFor(value);
  const row = {
    unit_id: id,
    tweet_ids: enrich.unitMemberIds(id),
    input_hash: computeInputHash(id, enrich.unitSemanticMembers(id)),
    contract_hash: contract,
    preset_labels: [{ name: "ai", evidence: [{ tweet_id: value.id, quote: "model" }] }],
    free_labels: [],
    model: "fixture",
    taxonomy_version: 1,
    enriched_at: now,
  };
  store.sourceEffects.recordResult(row, source());
  enrich.applyEnrichment(row);
}
function context(): ResolvedConsumerContext {
  const snapshot = {
    schema_version: 1 as const,
    bucket: "owner/raw",
    files: keys.map((key) => ({ key, oid: hash(key), content_sha256: hash(key), size: 100 })),
  };
  const source = hash(snapshot);
  const value = {
    schema_version: 1 as const,
    created_at: now,
    source,
    snapshot: { base: source, additions: [] },
    projection: CONSUMER_PROJECTION_HASH,
    contract,
    selection: {
      author_ids: ["11"],
      labels: ["ai"],
      label_mode: "any" as const,
      publication: "public-original" as const,
    },
    complete_through: null,
    observations_through: null,
    history_since: "2026-08-08T12:00:00.001Z",
    registry: consumerRegistry(enrich),
    taxonomy: { version: 1, labels: [{ name: "ai", description: "AI" }] },
  };
  return { id: hash(value), context: value, snapshot };
}
function cursor(target: ResolvedConsumerContext, base?: ResolvedConsumerContext): ConsumerCursor {
  return {
    schema_version: 1,
    target: target.id,
    base: base?.id ?? null,
    started_at: now,
    position: { kind: base === undefined ? "bootstrap" : "content" },
  };
}
function drain(
  target: ResolvedConsumerContext,
  base?: ResolvedConsumerContext,
  limit = 200,
): ConsumerChange[] {
  const engine = new ConsumerChangeEngine(store.database, target, base);
  const changes: ConsumerChange[] = [];
  let next = cursor(target, base);
  for (let page = 0; page < 100; page++) {
    const result = engine.step(next, limit);
    changes.push(...result.changes);
    if (result.cursor.position.kind === "idle") return changes;
    expect(result.cursor).not.toEqual(next);
    next = result.cursor;
  }
  throw new Error("consumer failed to make bounded progress");
}
beforeEach(() => {
  store = new TweetStore();
  enrich = new EnrichStore(store.database, 1, () => new Date(now), contract);
  keys = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

describe("bounded consumer change steps", () => {
  it("keeps bootstrap pages fixed while later posts arrive", () => {
    for (const id of ["100", "200"]) {
      post(tweet(id));
      result(tweet(id));
    }
    const target = context();
    const first = new ConsumerChangeEngine(store.database, target, undefined).step(
      cursor(target),
      1,
    );
    expect(first.changes.map((change) => change.type)).toEqual(["unit_upsert"]);
    post(tweet("300"));
    result(tweet("300"));
    const second = new ConsumerChangeEngine(store.database, target, undefined).step(
      first.cursor,
      1,
    );
    expect(
      second.changes.map((change) =>
        change.type === "unit_upsert" ? change.unit.id : "unexpected",
      ),
    ).toEqual(["200:a"]);
    expect(second.cursor.position.kind).toBe("idle");
  });

  it("advances observation scans in bounded segment batches without a delta cap", () => {
    const base = context();
    for (let index = 0; index < 1057; index++) source();
    const target = context();
    const engine = new ConsumerChangeEngine(store.database, target, base);
    let page = engine.step(cursor(target, base), 200);
    expect(page.cursor.position).toEqual({
      kind: "observations",
      segment_offset: 0,
    });
    for (let offset = 4; offset <= 1056; offset += 4) {
      page = engine.step(page.cursor, 200);
      expect(page.cursor.position).toEqual({
        kind: "observations",
        segment_offset: offset,
      });
    }
    expect(engine.step(page.cursor, 200).cursor.position).toEqual({
      kind: "idle",
    });
  });

  it("does not repeat one observation across segment batch boundaries", () => {
    post(tweet());
    result(tweet());
    const base = context();
    for (let index = 0; index < 3; index++) source();
    const updated = tweet("100", {
      captured_at: "2026-09-06T06:00:00.000Z",
      metrics: { likes: 40 },
    });
    post(updated);
    post(updated);
    const target = context();
    const engine = new ConsumerChangeEngine(store.database, target, base);
    const content = engine.step(cursor(target, base), 200);
    const first = engine.step(content.cursor, 200);
    expect(first.changes.filter((change) => change.type === "observation")).toHaveLength(1);
    expect(first.cursor.position).toEqual({
      kind: "observations",
      segment_offset: 4,
    });
    const second = engine.step(first.cursor, 200);
    expect(second.changes).toEqual([]);
    expect(second.cursor.position).toEqual({ kind: "idle" });
  });

  it("does no content reconstruction for receipt-only or metric-only source changes", () => {
    post(tweet());
    result(tweet());
    const base = context();
    source();
    const noop = context();
    const read = vi.spyOn(HistoricalUnitReader.prototype, "read");
    expect(drain(noop, base)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    post(
      tweet("100", { captured_at: "2026-09-06T06:00:00.000Z", metrics: { likes: 40, views: 900 } }),
    );
    const target = context();
    const engine = new ConsumerChangeEngine(store.database, target, noop);
    const content = engine.step(cursor(target, noop), 200);
    expect(content.changes).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    const plan = consumerQueryPlan(store.database, /WITH base_keys\(key\) AS MATERIALIZED/u);
    const samples = engine.step(content.cursor, 200);
    expect(plan.join("\n")).toMatch(/MATERIALIZE base_keys/u);
    expect(plan.join("\n")).toMatch(/MATERIALIZE previous_keys/u);
    expect(plan.join("\n")).toMatch(/MATERIALIZE target_keys/u);
    expect(plan.join("\n")).toMatch(/AUTOMATIC (?:PARTIAL )?COVERING INDEX \(key=\?\)/u);
    expect(samples.changes.map((change) => change.type)).toEqual(["observation"]);
    expect(read.mock.calls.every(([ids]) => ids.length === 1)).toBe(true);
    expect(samples.cursor.position.kind).toBe("idle");
  });

  it("withdraws pending edits and recovers their old observations on first eligible publication", () => {
    post(tweet());
    result(tweet());
    const before = context();
    const edited = tweet("100", {
      text: "updated model release",
      captured_at: "2026-09-06T06:00:00.000Z",
      metrics: { likes: 40 },
    });
    post(edited);
    const pending = context();
    expect(drain(pending, before)).toEqual([
      { type: "unit_remove", unit_id: "100:a", reason: "not_available" },
    ]);
    result(edited);
    const changes = drain(context(), pending, 1);
    expect(changes[0]?.type).toBe("unit_upsert");
    expect(changes.filter((change) => change.type === "observation")).toHaveLength(2);
  });

  it("emits both membership removal and replacement, with idempotent observation identities", () => {
    post(tweet());
    result(tweet());
    const before = context();
    const moved = tweet("100", {
      conversation_id: "other",
      captured_at: "2026-09-06T06:00:00.000Z",
    });
    post(moved);
    result(moved);
    const changes = drain(context(), before, 1);
    expect(changes.filter((change) => change.type === "unit_remove")).toEqual([
      { type: "unit_remove", unit_id: "100:a", reason: "not_available" },
    ]);
    expect(
      changes.filter((change) => change.type === "unit_upsert").map((change) => change.unit.id),
    ).toEqual(["other:a"]);
    expect(
      new Set(
        changes
          .filter((change) => change.type === "observation")
          .map((change) => change.observation.id),
      ).size,
    ).toBe(2);
  });

  it("does not emit old pinned content after a current privacy withdrawal", () => {
    post(tweet());
    result(tweet());
    const target = context();
    post(tweet("100", { is_subscriber_only: true, captured_at: "2026-09-06T06:00:00.000Z" }));
    expect(drain(target)).toEqual([]);
  });

  it("rejects a changed selection or an unrelated cursor instead of widening the read", () => {
    const base = context();
    source();
    const target = context();
    expect(
      () =>
        new ConsumerChangeEngine(
          store.database,
          {
            ...target,
            context: {
              ...target.context,
              selection: { ...target.context.selection, author_ids: ["22"] },
            },
          },
          base,
        ),
    ).toThrow(/selection/);
    const engine = new ConsumerChangeEngine(store.database, target, base);
    expect(() => engine.step({ ...cursor(target, base), target: base.id }, 200)).toThrow(/cursor/);
  });
});
