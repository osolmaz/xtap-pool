import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeInputHash, unitIdFor } from "@xtap-pool/shared";
import type { EnrichmentRow, FreeLabelEvent, PooledTweet } from "@xtap-pool/shared";
import { TweetStore } from "../src/store.js";
import { EnrichStore } from "../src/enrich-store.js";
import { HistoricalUnitReader } from "../src/historical-unit-reader.js";
import { consumerUnitHash } from "../src/consumer-content.js";
import { UnitStore } from "../src/unit-store.js";
import { ConsumerObservationReader } from "../src/consumer-observations.js";
import { consumerRegistry, changedApprovals } from "../src/consumer-registry.js";
import type { ConsumerRegistry } from "../src/consumer-registry.js";
import { consumerQueryPlan, consumerResultBodyReads } from "./consumer-query-plan.js";
import { makePooled } from "./helpers.js";

let store: TweetStore;
let enrich: EnrichStore;
let reader: HistoricalUnitReader;
let initialRegistry: ConsumerRegistry;
const contract = "contract";
const source = (key: string) => ({
  segmentKey: key,
  operation: 0,
  path: "test.jsonl",
  position: 0,
});
const initial = () =>
  makePooled({
    conversation_id: "thread",
    author: { id: "1001", username: "a" },
    text: "GLM model released.",
    metrics: { likes: 1, views: 10 },
  });
const selection = { authorIds: ["1001"], labels: ["ai"], publication: "public-original" as const };
const initialKeys = ["post", "result", "candidate", "approved"];

function addPost(tweet: PooledTweet, key: string): void {
  store.database.transaction(() => {
    store.observations.record(tweet, source(key));
    store.sourceEffects.recordPost(tweet, source(key));
    store.insert([tweet]);
    enrich.registerTweets([tweet]);
  })();
}
function addResult(tweet: PooledTweet, key: string): EnrichmentRow {
  const unit = unitIdFor(tweet);
  const members = enrich.unitSemanticMembers(unit);
  const row: EnrichmentRow = {
    unit_id: unit,
    tweet_ids: members.map((member) => member.id),
    input_hash: computeInputHash(unit, members),
    contract_hash: contract,
    preset_labels: [{ name: "ai", evidence: [{ tweet_id: tweet.id, quote: "GLM model" }] }],
    free_labels: [{ name: "glm", evidence: [{ tweet_id: tweet.id, quote: "GLM model" }] }],
    model: "test",
    taxonomy_version: 1,
    enriched_at: "2026-07-07T00:00:00Z",
  };
  store.sourceEffects.recordResult(row, source(key));
  enrich.applyEnrichment(row);
  return row;
}
function addRegistry(status: FreeLabelEvent["status"], revision: number): void {
  const event: FreeLabelEvent = {
    name: "glm",
    status,
    registry_revision: revision,
    at: "2026-07-07T00:00:00Z",
    contract_hash: contract,
    actor: "worker",
    quotes: [],
  };
  expect(enrich.applyRegistryEvent(event)).toBe(true);
}
function read(keys = initialKeys, units = ["thread:a"], registry = initialRegistry) {
  return reader.read(units, { segments: keys, registry }, selection);
}

beforeEach(() => {
  store = new TweetStore();
  enrich = new EnrichStore(store.database, 1, () => new Date("2026-07-07T00:00:00Z"), contract);
  reader = new HistoricalUnitReader(store.database, 1, contract);
  const tweet = initial();
  addPost(tweet, "post");
  addResult(tweet, "result");
  addRegistry("candidate", 2);
  addRegistry("approved", 3);
  initialRegistry = consumerRegistry(enrich);
});
afterEach(() => {
  store.close();
});

describe("bounded historical unit reconstruction", () => {
  it("uses observation point lookups with a large source boundary and excludes later bodies", () => {
    const before = read();
    addPost(
      { ...initial(), text: "GLM model edited.", captured_at: "2026-07-08T00:00:00Z" },
      "future-edit",
    );
    const keys = [
      ...initialKeys,
      ...Array.from({ length: 38219 }, (_, n) => `unused-${String(n)}`),
    ];
    const plan = consumerQueryPlan(store.database, /WITH candidates AS/u);
    expect(read(keys)).toEqual(before);
    expect(plan.some((line) => /SEARCH s .*\(observation_id=\?\)/u.test(line))).toBe(true);
    expect(plan.some((line) => line.includes("segment_key=? AND observation_id=?"))).toBe(false);
  });

  it("batches result lookup while enforcing the candidate bound separately for each unit", () => {
    const other = { ...initial(), id: "200", conversation_id: "other" };
    addPost(other, "other-post");
    addResult(other, "other-result");
    const valid = addResult(initial(), "valid-result");
    const keys = [...initialKeys, "other-post", "other-result", "valid-result"];
    for (let n = 0; n < 49; n++) {
      const key = `invalid-${String(n)}`;
      store.sourceEffects.recordResult(
        {
          ...valid,
          enriched_at: new Date(Date.UTC(2026, 6, 8, 0, n)).toISOString(),
          preset_labels: [{ name: "ai", evidence: [{ tweet_id: "100", quote: "absent quote" }] }],
        },
        source(key),
      );
      keys.push(key);
    }
    const plan = consumerQueryPlan(store.database, /WITH requested AS MATERIALIZED/u);
    expect(
      read(keys, ["thread:a", "other:a"])
        .map((unit) => unit.id)
        .sort(),
    ).toEqual(["other:a", "thread:a"]);
    expect(plan.filter((line) => line === "MATERIALIZE requested")).toHaveLength(1);
    expect(plan.some((line) => /SEARCH s .*\(result_hash=\?\)/u.test(line))).toBe(true);
    store.sourceEffects.recordResult(
      {
        ...valid,
        enriched_at: "2026-07-09T00:00:00.000Z",
        preset_labels: [{ name: "ai", evidence: [{ tweet_id: "100", quote: "absent quote" }] }],
      },
      source("one-too-many"),
    );
    expect(() => read([...keys, "one-too-many"], ["thread:a", "other:a"])).toThrow(
      "recorded result validation exceeds its candidate bound",
    );
  });

  it("limits rows before ranking a long result history and keeps a valid newest result", () => {
    const valid = addResult(initial(), "valid-result");
    const keys = [...initialKeys, "valid-result"];
    store.database.transaction(() => {
      for (let n = 0; n < 500; n++) {
        const key = `long-history-${String(n)}`;
        store.sourceEffects.recordResult(
          { ...valid, enriched_at: new Date(Date.UTC(2026, 6, 8, 0, n)).toISOString() },
          source(key),
        );
        keys.push(key);
      }
    })();
    const reads = consumerResultBodyReads(store.database);
    expect(read(keys).map((unit) => unit.id)).toEqual(["thread:a"]);
    expect(reads()).toBe(51);
  });

  it("reads the old and target content after the live database has moved forward", () => {
    const before = read();
    expect(before).toHaveLength(1);
    const edited = initial();
    edited.text = "GLM model updated.";
    edited.captured_at = "2026-05-22T00:00:00Z";
    addPost(edited, "edit");
    addResult(edited, "edited-result");
    expect(read()).toEqual(before);
    expect(read([...initialKeys, "edit", "edited-result"])[0]?.posts[0]?.text).toBe(
      "GLM model updated.",
    );
  });

  it("keeps the latest applicable result when a later raw row has invalid evidence", () => {
    const good = addResult(initial(), "good-retry");
    const bad: EnrichmentRow = {
      ...good,
      enriched_at: "2026-07-08T00:00:00Z",
      preset_labels: [{ name: "ai", evidence: [{ tweet_id: "100", quote: "absent quote" }] }],
    };
    store.sourceEffects.recordResult(bad, source("bad-result"));
    enrich.applyEnrichment(bad);
    expect(read([...initialKeys, "good-retry", "bad-result"]).map(consumerUnitHash)).toEqual(
      new UnitStore(store.database, 1).query(selection).units.map(consumerUnitHash),
    );
  });

  it("reuses a recorded exact-input result after a classified edit is reverted", () => {
    const edited = { ...initial(), text: "GLM model changed", captured_at: "2026-05-22T00:00:00Z" };
    addPost(edited, "edit-before-revert");
    addResult(edited, "edit-result-before-revert");
    const reverted = { ...initial(), captured_at: "2026-05-23T00:00:00Z" };
    addPost(reverted, "revert");
    expect(enrich.queueEntry("thread:a")?.status).toBe("done");
    const target = [...initialKeys, "edit-before-revert", "edit-result-before-revert", "revert"];
    expect(read(target).map(consumerUnitHash)).toEqual(
      new UnitStore(store.database, 1).query(selection).units.map(consumerUnitHash),
    );
  });

  it("uses the same deterministic result winner as the current view for equal-time conflicts", () => {
    const one = addResult(initial(), "retry");
    const two: EnrichmentRow = {
      ...one,
      enriched_at: "2026-07-07T03:00:00+03:00",
      preset_labels: [{ name: "ai", evidence: [{ tweet_id: "100", quote: "model" }] }],
    };
    store.sourceEffects.recordResult(two, source("conflict"));
    const target = [...initialKeys, "retry", "conflict"];
    const historical = read(target).map(consumerUnitHash);
    for (const rows of [
      [one, two],
      [two, one],
    ]) {
      enrich.clearForRebuild();
      enrich.registerTweets([initial()]);
      for (const row of rows) enrich.applyEnrichment(row);
      addRegistry("candidate", 2);
      addRegistry("approved", 3);
      expect(new UnitStore(store.database, 1).query(selection).units.map(consumerUnitHash)).toEqual(
        historical,
      );
    }
  });

  it("keeps the same content digest for a later metric-only observation", () => {
    const before = read()[0];
    const later = initial();
    later.captured_at = "2026-05-22T00:00:00Z";
    later["metrics"] = { likes: 400, views: 4000 };
    later.author = { ...later.author, follower_count: 900 };
    addPost(later, "metrics");
    const after = read([...initialKeys, "metrics"])[0];
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    if (before === undefined || after === undefined) throw new Error("missing fixture unit");
    expect(consumerUnitHash(after)).toBe(consumerUnitHash(before));
    expect(after.posts[0]).not.toHaveProperty("metrics");
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM consumer_results").get()).toEqual({
      count: 1,
    });
  });

  it("preserves prior membership and reconstructs a later move", () => {
    const moved = initial();
    moved["conversation_id"] = "other";
    moved.captured_at = "2026-05-22T00:00:00Z";
    addPost(moved, "move");
    addResult(moved, "move-result");
    expect(read().map((unit) => unit.id)).toEqual(["thread:a"]);
    expect(
      read([...initialKeys, "move", "move-result"], ["thread:a", "other:a"]).map((unit) => unit.id),
    ).toEqual(["other:a"]);
  });

  it("uses the registry state from the pinned boundary", () => {
    addRegistry("rejected", 4);
    const registry = consumerRegistry(enrich);
    expect(changedApprovals(initialRegistry, registry)).toEqual(["glm"]);
    expect(read()[0]?.free_labels.map((label) => label.name)).toEqual(["glm"]);
    expect(read([...initialKeys, "rejected"], ["thread:a"], registry)[0]?.free_labels).toEqual([]);
  });

  it("uses frozen approvals rather than guessing from a raw registry revision", () => {
    expect(
      read(["post", "result", "candidate"], ["thread:a"], { revision: 2, approved: [] })[0]
        ?.free_labels,
    ).toEqual([]);
    const rejected: FreeLabelEvent = {
      name: "glm",
      status: "rejected",
      registry_revision: 3,
      at: "2026-07-07T00:00:00Z",
      contract_hash: contract,
      actor: "worker",
      quotes: [],
    };
    expect(enrich.applyRegistryEvent(rejected)).toBe(false);
    const current = consumerRegistry(enrich);
    expect(changedApprovals(initialRegistry, current)).toEqual([]);
    expect(
      read([...initialKeys, "ignored-event"], ["thread:a"], current)[0]?.free_labels.map(
        (label) => label.name,
      ),
    ).toEqual(["glm"]);
  });

  it("holds an edited unit until matching enrichment exists at the target", () => {
    const edited = initial();
    edited.text = "GLM model has a different capability.";
    edited.captured_at = "2026-05-22T00:00:00Z";
    addPost(edited, "pending");
    expect(read()).toHaveLength(1);
    expect(read([...initialKeys, "pending"])).toEqual([]);
  });

  it("retains public-original and exact-author filtering", () => {
    expect(
      reader.read(
        ["thread:a"],
        { segments: initialKeys, registry: initialRegistry },
        { ...selection, authorIds: ["not-the-author"] },
      ),
    ).toEqual([]);
    const privatePost = initial();
    privatePost["is_subscriber_only"] = true;
    privatePost.captured_at = "2026-05-22T00:00:00Z";
    addPost(privatePost, "private");
    addResult(privatePost, "private-result");
    expect(read([...initialKeys, "private", "private-result"])).toEqual([]);
  });

  it("uses observation point lookups for history rows and coverage across a large source", () => {
    addPost({ ...initial(), captured_at: "2026-05-22T00:00:00Z", metrics: { likes: 2 } }, "later");
    const keys = [
      ...initialKeys,
      "later",
      ...Array.from({ length: 38219 }, (_, n) => `unused-${String(n)}`),
    ];
    addPost({ ...initial(), captured_at: "2026-05-23T00:00:00Z", metrics: { likes: 3 } }, "future");
    const plan = consumerQueryPlan(
      store.database,
      /WITH samples AS MATERIALIZED|COUNT\(\*\) AS count/u,
    );
    const history = new ConsumerObservationReader(store.database, 1, contract);
    const options = {
      postIds: ["100"],
      boundary: { segments: keys, registry: initialRegistry },
      selection,
      since: "2026-05-20T00:00:00.000Z",
      until: "2026-05-25T00:00:00.000Z",
      limit: 1,
    };
    const first = history.history(options);
    expect(first.observations.map((observation) => observation.metrics.likes)).toEqual([1]);
    expect(first.coverage[0]).toMatchObject({ count: 2, state: "available" });
    const last = history.history({ ...options, after: first.next });
    expect(last.observations.map((observation) => observation.metrics.likes)).toEqual([2]);
    expect(last.next).toBeUndefined();
    expect(last.coverage).toEqual(first.coverage);
    expect(plan.filter((line) => /SEARCH s .*\(observation_id=\?\)/u.test(line))).toHaveLength(4);
    expect(plan.some((line) => line.includes("segment_key=? AND observation_id=?"))).toBe(false);
  });

  it("pages logical observations with bounded source references and stable coverage", () => {
    const later = {
      ...initial(),
      captured_at: "2026-05-22T00:00:00Z",
      metrics: { likes: 50, views: 300 },
    };
    addPost(later, "later");
    const history = new ConsumerObservationReader(store.database, 1, contract);
    const options = {
      postIds: ["100"],
      boundary: { segments: [...initialKeys, "later"], registry: initialRegistry },
      selection,
      since: "2026-05-20T00:00:00.000Z",
      until: "2026-05-25T00:00:00.000Z",
      limit: 1,
    };
    const first = history.history(options);
    expect(first.observations[0]?.metrics).toEqual({
      likes: 1,
      views: 10,
      replies: null,
      reposts: null,
    });
    expect(first.observations[0]?.source_ref).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.coverage[0]).toMatchObject({ state: "available", count: 2 });
    if (first.next === undefined) throw new Error("missing page position");
    addPost(
      { ...later, captured_at: "2026-05-23T00:00:00Z", metrics: { likes: 80 } },
      "future-metrics",
    );
    const second = history.history({ ...options, after: first.next });
    expect(second.observations).toHaveLength(1);
    expect(second.observations[0]?.metrics.likes).toBe(50);
    expect(second.next).toBeUndefined();
    expect(second.coverage).toEqual(first.coverage);
    expect(history.history(options)).toEqual(first);
    expect(() => history.history({ ...options, limit: 501 })).toThrow();
    expect(() => history.history({ ...options, until: "2026-07-01T00:00:00.000Z" })).toThrow();
  });

  it("reads new observations without rediscovering old IDs and preserves a scan position for pending content", () => {
    const later = { ...initial(), captured_at: "2026-05-22T00:00:00Z", metrics: { likes: 25 } };
    addPost(later, "sample");
    addPost(initial(), "retry-sample");
    const history = new ConsumerObservationReader(store.database, 1, contract);
    const keys = [...initialKeys, "sample", "retry-sample"];
    const options = {
      changedSegments: ["sample", "retry-sample"],
      previousChangedSegments: [],
      baseSegments: initialKeys,
      boundary: { segments: keys, registry: initialRegistry },
      selection,
      since: "2026-05-20T00:00:00.000Z",
      limit: 200,
    };
    expect(history.changed(options).observations.map((row) => row.metrics.likes)).toEqual([25]);
    const edited = { ...later, text: "GLM model changed", captured_at: "2026-05-23T00:00:00Z" };
    addPost(edited, "pending-sample");
    const pending = history.changed({
      ...options,
      changedSegments: ["pending-sample"],
      previousChangedSegments: [],
      baseSegments: keys,
      boundary: { ...options.boundary, segments: [...keys, "pending-sample"] },
    });
    expect(pending.observations).toEqual([]);
    expect(pending.scanned?.post_id).toBe("100");
    expect(pending.hasMore).toBe(false);
    addResult(edited, "completed-sample");
    const activated = history.history({
      postIds: ["100"],
      boundary: {
        segments: [...keys, "pending-sample", "completed-sample"],
        registry: initialRegistry,
      },
      selection,
      since: "2026-05-20T00:00:00.000Z",
      until: "2026-05-25T00:00:00.000Z",
      limit: 200,
    });
    expect(activated.observations).toHaveLength(3);
  });

  it("deduplicates raw retries without changing receipt time in an old pinned page", () => {
    const history = new ConsumerObservationReader(store.database, 1, contract);
    const options = {
      postIds: ["100"],
      boundary: { segments: initialKeys, registry: initialRegistry },
      selection,
      since: "2026-05-20T00:00:00.000Z",
      until: "2026-05-25T00:00:00.000Z",
      limit: 200,
    };
    const before = history.history(options);
    addPost({ ...initial(), pooled_at: "2026-07-05T00:00:00.000Z" }, "late-discovered-retry");
    expect(history.history(options)).toEqual(before);
    const after = history.history({
      ...options,
      boundary: { ...options.boundary, segments: [...initialKeys, "late-discovered-retry"] },
    });
    expect(after.observations).toHaveLength(1);
    expect(after.observations[0]?.id).toBe(before.observations[0]?.id);
    expect(after.observations[0]?.received_at).toBe("2026-07-05T00:00:00.000Z");
    expect(after.coverage[0]?.count).toBe(1);
    const empty = history.history({ ...options, since: "2026-05-23T00:00:00.000Z" });
    expect(empty.coverage[0]).toMatchObject({ state: "no_history", count: 0 });
  });

  it.each([
    { is_subscriber_only: true },
    { is_retweet: true },
    { author: { id: "900", username: "other" } },
  ])("excludes a sample whose own content was outside the permitted public scope (%j)", (patch) => {
    addPost(
      { ...initial(), ...patch, captured_at: "2026-05-20T00:00:00Z", metrics: { likes: 9999 } },
      "old-restricted",
    );
    const history = new ConsumerObservationReader(store.database, 1, contract);
    const page = history.history({
      postIds: ["100"],
      boundary: { segments: [...initialKeys, "old-restricted"], registry: initialRegistry },
      selection,
      since: "2026-05-19T00:00:00.000Z",
      until: "2026-05-25T00:00:00.000Z",
      limit: 200,
    });
    expect(page.observations.map((row) => row.metrics.likes)).toEqual([1]);
    expect(page.coverage[0]?.count).toBe(1);
  });

  it.each([true, "true", null])(
    "denies retained history after a newer private or invalid visibility observation (%s)",
    (visibility) => {
      addPost(
        { ...initial(), captured_at: "2026-05-22T00:00:00Z", is_subscriber_only: visibility },
        "withdrawn",
      );
      const history = new ConsumerObservationReader(store.database, 1, contract);
      const page = history.history({
        postIds: ["100", "999"],
        boundary: { segments: initialKeys, registry: initialRegistry },
        selection,
        since: "2026-05-20T00:00:00.000Z",
        until: "2026-05-25T00:00:00.000Z",
        limit: 200,
      });
      expect(page.observations).toEqual([]);
      expect(page.coverage.map((row) => row.state)).toEqual(["unavailable", "unavailable"]);
      expect(page.coverage.every((row) => row.count === null)).toBe(true);
    },
  );

  it("does not hydrate unrelated units and does not widen an empty request", () => {
    const other = makePooled({ id: "200", author: { id: "other", username: "other" } });
    addPost(other, "unrelated");
    expect(read([...initialKeys, "unrelated"]).map((unit) => unit.id)).toEqual(["thread:a"]);
    expect(read([...initialKeys, "unrelated"], [])).toEqual([]);
    expect(() =>
      read(
        initialKeys,
        Array.from({ length: 201 }, (_, index) => String(index)),
      ),
    ).toThrow();
  });
});
