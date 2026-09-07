import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeInputHash, unitIdFor } from "@xtap-pool/shared";
import type { EnrichmentRow, FreeLabelEvent, PooledTweet } from "@xtap-pool/shared";
import { TweetStore } from "../src/store.js";
import { EnrichStore } from "../src/enrich-store.js";
import { HistoricalUnitReader } from "../src/historical-unit-reader.js";
import { consumerUnitHash } from "../src/consumer-content.js";
import { consumerRegistry, changedApprovals } from "../src/consumer-registry.js";
import type { ConsumerRegistry } from "../src/consumer-registry.js";
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
function addResult(tweet: PooledTweet, key: string): void {
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
