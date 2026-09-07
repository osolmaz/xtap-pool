import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnrichmentRow } from "@xtap-pool/shared";
import { TweetStore } from "../src/store.js";
import { makePooled } from "./helpers.js";

let store: TweetStore;
beforeEach(() => {
  store = new TweetStore();
  store.database.pragma("foreign_keys = ON");
});
afterEach(() => {
  store.close();
});
const source = (key: string, position = 0) => ({
  segmentKey: key,
  operation: 0,
  path: "test/source.jsonl",
  position,
});
function post(key: string, patch: Record<string, unknown> = {}): void {
  const tweet = makePooled({
    conversation_id: "old",
    author: { id: "a", username: "a" },
    ...patch,
  });
  store.observations.record(tweet, source(key));
  store.sourceEffects.recordPost(tweet, source(key));
}
const result = (unit: string, patch: Partial<EnrichmentRow> = {}): EnrichmentRow => ({
  unit_id: unit,
  tweet_ids: ["100"],
  input_hash: "input",
  contract_hash: "contract",
  preset_labels: [{ name: "ai", evidence: [{ tweet_id: "100", quote: "hello" }] }],
  free_labels: [{ name: "glm", evidence: [{ tweet_id: "100", quote: "hello" }] }],
  model: "test",
  taxonomy_version: 1,
  enriched_at: "2026-05-22T00:00:00Z",
  ...patch,
});
function affected(
  changed: string[],
  target: string[],
  after?: string,
  limit = 200,
  changedLabels: string[] = [],
) {
  return store.sourceEffects.affectedUnits({
    changedSegments: changed,
    baseSegments: target.filter((key) => !changed.includes(key)),
    targetSegments: target,
    changedLabels,
    contractHash: "contract",
    ...(after === undefined ? {} : { after }),
    limit,
  });
}

describe("indexed source effects", () => {
  it("finds both old and new membership without including future dependencies", () => {
    post("old");
    post("new", { conversation_id: "new", captured_at: "2026-05-22T00:00:00Z" });
    post("future", { conversation_id: "future", captured_at: "2026-05-23T00:00:00Z" });
    expect(affected(["new"], ["old", "new"])).toEqual({ ids: ["new:a", "old:a"], hasMore: false });
    expect(affected(["new"], ["old", "new"], undefined, 1)).toEqual({
      ids: ["new:a"],
      hasMore: true,
    });
    expect(affected(["new"], ["old", "new"], "new:a", 1)).toEqual({
      ids: ["old:a"],
      hasMore: false,
    });
  });

  it("finds a changed result and ignores a different enrichment contract", () => {
    store.sourceEffects.recordResult(result("old:a"), source("current"));
    store.sourceEffects.recordResult(
      result("other:a", { contract_hash: "other" }),
      source("other"),
    );
    expect(affected(["current", "other"], ["current", "other"]).ids).toEqual(["old:a"]);
  });

  it("finds the historical units affected by changed published approvals", () => {
    store.sourceEffects.recordResult(result("old:a"), source("old-result"));
    store.sourceEffects.recordResult(result("future:a"), source("future-result"));
    store.sourceEffects.recordResult(
      result("different:a", { free_labels: [] }),
      source("other-result"),
    );
    expect(
      affected(["registry"], ["registry", "old-result", "other-result"], undefined, 200, ["glm"])
        .ids,
    ).toEqual(["old:a"]);
  });

  it("ignores a raw registry change when the published approvals did not change", () => {
    store.sourceEffects.recordResult(result("old:a"), source("result"));
    expect(affected(["registry"], ["result", "registry"])).toEqual({ ids: [], hasMore: false });
  });

  it("has no content candidates for a receipt-only source difference", () => {
    post("old");
    store.sourceEffects.recordResult(result("old:a"), source("result"));
    expect(affected(["receipt"], ["old", "result", "receipt"])).toEqual({
      ids: [],
      hasMore: false,
    });
  });

  it("does not reconstruct content for metric or follower-count updates", () => {
    post("old", { metrics: { likes: 3 }, author: { id: "a", username: "a", follower_count: 50 } });
    post("metrics", {
      metrics: { likes: 90 },
      author: { id: "a", username: "a", follower_count: 80 },
      captured_at: "2026-05-22T00:00:00Z",
    });
    expect(affected(["metrics"], ["old", "metrics"]).ids).toEqual([]);
  });

  it("ignores exact observation retries and older content that does not replace the current copy", () => {
    post("old");
    post("retry");
    post("late", { text: "earlier text", captured_at: "2026-05-20T00:00:00Z" });
    expect(affected(["retry", "late"], ["old", "retry", "late"]).ids).toEqual([]);
  });

  it("ignores an added contributor with the same content", () => {
    post("old");
    post("copy", { contributed_by: "alice", captured_at: "2026-05-22T00:00:00Z" });
    expect(affected(["copy"], ["old", "copy"]).ids).toEqual([]);
  });

  it("keeps content conflicts and same-time edits as candidates", () => {
    post("old");
    post("conflict", { text: "changed", contributed_by: "alice" });
    expect(affected(["conflict"], ["old", "conflict"]).ids).toEqual(["old:a"]);
    post("tie", { is_subscriber_only: true });
    expect(affected(["tie"], ["old", "tie"]).ids).toEqual(["old:a"]);
  });

  it("includes a late source key instead of treating lexicographic keys as a watermark", () => {
    post("zz-existing");
    post("aa-late", { id: "101", conversation_id: "late", captured_at: "2026-05-20T00:00:00Z" });
    expect(affected(["aa-late"], ["aa-late", "zz-existing"]).ids).toEqual(["late:a"]);
  });

  it("deduplicates exact result retries while preserving source references", () => {
    const row = result("old:a");
    store.sourceEffects.recordResult(row, source("one"));
    store.sourceEffects.recordResult(row, source("one"));
    store.sourceEffects.recordResult(row, source("retry"));
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM consumer_results").get()).toEqual({
      count: 1,
    });
    expect(
      store.database.prepare("SELECT COUNT(*) AS count FROM consumer_result_sources").get(),
    ).toEqual({ count: 2 });
    expect(affected(["one", "retry"], ["one", "retry"]).ids).toEqual(["old:a"]);
    expect(affected(["retry"], ["one", "retry"]).ids).toEqual([]);
  });

  it("rejects a conflicting physical result without adding partial label dependencies", () => {
    store.sourceEffects.recordResult(result("old:a"), source("one"));
    expect(() => {
      store.sourceEffects.recordResult(result("changed:a"), source("one"));
    }).toThrow(/source reference/);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM consumer_results").get()).toEqual({
      count: 1,
    });
    expect(affected(["one"], ["one"]).ids).toEqual(["old:a"]);
  });

  it("rejects source differences outside the pinned target and invalid limits", () => {
    expect(() => affected(["future"], ["old"])).toThrow(/pinned target/);
    expect(() => affected([], [], undefined, 501)).toThrow();
    expect(() => affected([], [], undefined, 0)).toThrow();
  });

  it("clears dependency and version tables together during explicit rebuild", () => {
    post("old");
    store.sourceEffects.recordResult(result("old:a"), source("result"));
    store.clearForRebuild();
    expect(affected(["old", "result"], ["old", "result"]).ids).toEqual([]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM consumer_results").get()).toEqual({
      count: 0,
    });
  });
});
