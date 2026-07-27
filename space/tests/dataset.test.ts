import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatasetMirror, parseJsonlTweets } from "../src/dataset.js";
import type { HubClient } from "../src/dataset.js";
import { EnrichStore } from "../src/enrich-store.js";
import { TweetStore } from "../src/store.js";
import { FakeHub, makePooled, makeTweet } from "./helpers.js";

function receipt(finishedAt: string): Record<string, unknown> {
  return {
    started_at: "2026-07-06T00:00:00.000Z",
    finished_at: finishedAt,
    units: 1,
    calls: 1,
    prompt_tokens: 10,
    completion_tokens: 5,
    failures: 0,
    retries: 0,
    blocked: 0,
    contract_hash: "external-contract",
    worker_id: "external-worker",
    discarded_assignments: 0,
    new_candidates: 0,
    new_approvals: 0,
    new_rejections: 0,
  };
}

let dir: string;
let hub: FakeHub;
let mirror: DatasetMirror;
let store: TweetStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xtap-pool-test-"));
  hub = new FakeHub();
  mirror = new DatasetMirror(hub, dir);
  store = new TweetStore();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("parseJsonlTweets", () => {
  it("parses stamped lines as-is", () => {
    const pooled = makePooled();
    const tweets = parseJsonlTweets(`${JSON.stringify(pooled)}\n`, "data/osolmaz/x.jsonl");
    expect(tweets).toHaveLength(1);
    expect(tweets[0]?.contributed_by).toBe("osolmaz");
    expect(tweets[0]?.pooled_at).toBe(pooled.pooled_at);
  });

  it("infers attribution for legacy xTap lines from the path", () => {
    const legacy = makeTweet();
    const tweets = parseJsonlTweets(
      `${JSON.stringify(legacy)}\n`,
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
    );
    expect(tweets[0]?.contributed_by).toBe("osolmaz");
    expect(tweets[0]?.pooled_at).toBe(legacy.captured_at);
  });

  it("skips blank, unparsable and invalid lines", () => {
    const content = ["", "not json", JSON.stringify({ id: "1" }), JSON.stringify(makeTweet())]
      .join("\n")
      .concat("\n");
    expect(parseJsonlTweets(content, "data/u/x.jsonl")).toHaveLength(1);
  });
});

describe("DatasetMirror.rebuild", () => {
  it("downloads all files, fills the store and writes the mirror", async () => {
    hub.files.set(
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
      `${JSON.stringify(makePooled({ id: "1" }))}\n${JSON.stringify(makePooled({ id: "2" }))}\n`,
    );
    hub.files.set(
      "data/alice/2026/05/tweets-2026-05-21.jsonl",
      `${JSON.stringify(makePooled({ id: "3", contributed_by: "alice" }))}\n`,
    );
    const result = await mirror.rebuild(store);
    expect(result).toEqual({ files: 2, tweets: 3 });
    expect(store.count()).toBe(3);
    expect(existsSync(join(dir, "data/alice/2026/05/tweets-2026-05-21.jsonl"))).toBe(true);
  });

  it("replays retries from clean cache and mirror state", async () => {
    const enrich = new EnrichStore(store.database, 1);
    const oldPath = "data/osolmaz/2026/05/tweets-2026-05-21.jsonl";
    const newPath = "data/alice/2026/05/tweets-2026-05-22.jsonl";
    hub.files.set(oldPath, `${JSON.stringify(makePooled({ id: "old" }))}\n`);
    await mirror.rebuild(store, enrich);
    expect(store.count()).toBe(1);

    hub.files.delete(oldPath);
    hub.files.set(
      newPath,
      `${JSON.stringify(makePooled({ id: "new", contributed_by: "alice" }))}\n`,
    );
    mirror.clearForRebuild();
    enrich.clearForRebuild();
    store.clearForRebuild();
    await mirror.rebuild(store, enrich);

    expect(store.count()).toBe(1);
    expect(store.query({}).records.map((record) => record.tweet.id)).toEqual(["new"]);
    expect(existsSync(join(dir, oldPath))).toBe(false);
    expect(existsSync(join(dir, newPath))).toBe(true);
  });
});

describe("DatasetMirror enrichment rebuild", () => {
  it("replays enrichment shards without seeding label output from legacy rows", async () => {
    hub.files.set(
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
      `${JSON.stringify(makePooled({ id: "1" }))}\n${JSON.stringify(makePooled({ id: "2", author: { username: "other" } }))}\n`,
    );
    hub.files.set(
      "enrichment/2026/07/enrichment-2026-07-06.jsonl",
      [
        JSON.stringify({
          unit_id: "1:someone",
          tweet_ids: ["1"],
          labels: ["ai"],
          free_labels: ["gguf"],
          concepts: [{ name: "vLLM", aliases: [] }],
          model: "m",
          taxonomy_version: 1,
          enriched_at: "2026-07-06T00:00:00.000Z",
        }),
        "not json",
        JSON.stringify({ unit_id: "broken" }),
      ].join("\n"),
    );
    const receiptPath = "enrichment/receipts/2026-07-06.jsonl";
    hub.files.set(receiptPath, '{"units":1}\n');

    const enrich = new EnrichStore(store.database, 1);
    await mirror.rebuild(store, enrich);
    const result = await mirror.rebuildEnrichment(enrich);
    expect(result).toEqual({ files: 1, rows: 0, attempts: 0, registryEvents: 0 });
    expect(readFileSync(join(dir, receiptPath), "utf8")).toBe('{"units":1}\n');
    // Legacy rows do not settle the queue — both units remain pending under
    // the current contract.
    expect(enrich.queueEntry("1:someone")?.status).toBe("pending");
    expect(enrich.queueEntry("2:other")?.status).toBe("pending");
    // No free-label registry entries seeded from legacy rows.
    expect(enrich.registrySnapshot()).toEqual([]);
    // No preset assignments materialize either.
    expect(enrich.approvedFreeLabels()).toEqual([]);
  });
});

describe("DatasetMirror external enrichment refresh", () => {
  it("replays changed durable shards and keeps the newest valid receipt", async () => {
    hub.files.set(
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
      `${JSON.stringify(makePooled({ id: "1" }))}\n${JSON.stringify(makePooled({ id: "2", author: { username: "other" } }))}\n`,
    );
    const enrich = new EnrichStore(store.database, 1);
    await mirror.rebuild(store, enrich);
    await mirror.rebuildEnrichment(enrich);
    const queued = enrich.claimQueued(10);
    enrich.releaseClaims();
    const first = queued.find((item) => item.unitId === "1:someone");
    const second = queued.find((item) => item.unitId === "2:other");
    if (first === undefined || second === undefined) throw new Error("expected queued units");

    hub.files.set(
      "enrichment/2026/07/enrichment-2026-07-06.jsonl",
      `${JSON.stringify({
        unit_id: first.unitId,
        tweet_ids: ["1"],
        input_hash: first.inputHash,
        contract_hash: first.contractHash,
        preset_labels: [{ name: "ai", evidence: [{ tweet_id: "1", quote: "hello world" }] }],
        free_labels: [],
        model: "m",
        taxonomy_version: 1,
        enriched_at: "2026-07-06T00:00:00.000Z",
      })}\n`,
    );
    hub.files.set(
      "enrichment/attempts/2026/07/attempts-2026-07-06.jsonl",
      `${JSON.stringify({
        unit_id: second.unitId,
        input_hash: second.inputHash,
        contract_hash: second.contractHash,
        attempt: 1,
        outcome: "transient_failure",
        error_class: "timeout",
        at: "2026-07-06T00:00:00.000Z",
      })}\n`,
    );
    hub.files.set(
      "enrichment/registry/2026/07/registry-2026-07-06.jsonl",
      `${JSON.stringify({
        name: "external-label",
        status: "candidate",
        at: "2026-07-06T00:00:00.000Z",
        actor: "worker",
        contract_hash: first.contractHash,
        registry_revision: 2,
      })}\n`,
    );
    hub.files.set(
      "enrichment/receipts/2026-07-06.jsonl",
      [
        '{"finished_at":"2026-07-06T00:00:00.000Z"}',
        JSON.stringify(receipt("2026-07-06T00:01:00.000Z")),
        JSON.stringify(receipt("2026-07-06T00:02:00.000Z")),
      ]
        .join("\n")
        .concat("\n"),
    );

    let beforeApplyCalls = 0;
    const refreshed = await mirror.refreshEnrichment(enrich, () => {
      beforeApplyCalls += 1;
    });
    expect(beforeApplyCalls).toBe(1);
    expect(refreshed).toMatchObject({ files: 4, rows: 1, attempts: 1, registryEvents: 1 });
    expect(enrich.queueEntry(first.unitId)?.status).toBe("done");
    expect(enrich.queueEntry(second.unitId)?.status).toBe("retrying");
    expect(enrich.registryStatus("external-label")).toBe("candidate");
    expect(mirror.latestReceipt()?.finished_at).toBe("2026-07-06T00:02:00.000Z");

    hub.files.set(
      "enrichment/receipts/2026-07-06.jsonl",
      `${JSON.stringify(receipt("2026-07-06T00:03:00.000Z"))}\n`,
    );
    hub.failDownloadAttempts = 2;
    await expect(
      mirror.refreshEnrichment(enrich, () => {
        beforeApplyCalls += 1;
      }),
    ).rejects.toThrow("hub unavailable");
    expect(beforeApplyCalls).toBe(1);
    expect(mirror.latestReceipt()?.finished_at).toBe("2026-07-06T00:02:00.000Z");
    expect(enrich.queueEntry(first.unitId)?.status).toBe("done");
  });

  it("eventually replays every missing shard while keeping each poll bounded", async () => {
    const enrich = new EnrichStore(store.database, 1);
    for (let day = 1; day <= 6; day += 1) {
      const date = `2026-08-${String(day).padStart(2, "0")}`;
      hub.files.set(`enrichment/2026/08/enrichment-${date}.jsonl`, "");
    }

    await expect(mirror.refreshEnrichment(enrich)).resolves.toMatchObject({ files: 4 });
    await expect(mirror.refreshEnrichment(enrich)).resolves.toMatchObject({ files: 2 });
    for (const path of hub.files.keys()) {
      expect(existsSync(join(dir, path))).toBe(true);
    }
  });
});

describe("DatasetMirror attempt-event replay", () => {
  it("restores retrying/blocked state from committed attempt events", async () => {
    hub.files.set(
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
      `${JSON.stringify(makePooled({ id: "1" }))}\n`,
    );
    // No enrichment shard for this unit -> queue is pending on boot.
    // A prior worker recorded a transient failure. Replay must restore the
    // retrying status + attempt count + last_error class.
    const enrich = new EnrichStore(store.database, 1);
    await mirror.rebuild(store, enrich);
    // Update contract to match — replay only applies attempts to the current
    // contract. Grab the input hash the store computed.
    const claimed = enrich.claimQueued(10);
    enrich.releaseClaims();
    const item = claimed[0];
    if (item === undefined) throw new Error("expected a pending unit");
    hub.files.set(
      "enrichment/attempts/2026/07/attempts-2026-07-06.jsonl",
      `${JSON.stringify({
        unit_id: item.unitId,
        input_hash: item.inputHash,
        contract_hash: item.contractHash,
        attempt: 2,
        outcome: "transient_failure",
        error_class: "timeout",
        error_message: "router timed out",
        at: "2026-07-06T00:00:00.000Z",
        next_retry_at: "2026-07-06T00:05:00.000Z",
      })}\n`,
    );
    await mirror.rebuildEnrichment(enrich);
    const entry = enrich.queueEntry(item.unitId);
    expect(entry?.status).toBe("retrying");
    expect(entry?.attempts).toBe(2);
    expect(entry?.lastErrorClass).toBe("timeout");
    expect(entry?.nextRetryAt).toBe("2026-07-06T00:05:00.000Z");
  });
});

describe("DatasetMirror.commitBatch", () => {
  it("appends lines and overwrites metadata files in one commit", async () => {
    await mirror.commitBatch(
      [{ path: "enrichment/receipts/2026-07-06.jsonl", lines: ['{"a":1}'] }],
      [{ path: "enrichment/vocabulary.json", content: "{}\n" }],
      "enrich: test",
    );
    await mirror.commitBatch(
      [{ path: "enrichment/receipts/2026-07-06.jsonl", lines: ['{"b":2}'] }],
      [],
      "enrich: test 2",
    );
    expect(hub.files.get("enrichment/receipts/2026-07-06.jsonl")).toBe('{"a":1}\n{"b":2}\n');
    expect(hub.files.get("enrichment/vocabulary.json")).toBe("{}\n");
    expect(hub.commits.map((c) => c.title)).toEqual(["enrich: test", "enrich: test 2"]);
  });

  it("leaves the mirror untouched when the commit fails", async () => {
    hub.failNextCommit = true;
    await expect(
      mirror.commitBatch([{ path: "enrichment/x.jsonl", lines: ["{}"] }], [], "boom"),
    ).rejects.toThrow("hub unavailable");
    expect(existsSync(join(dir, "enrichment/x.jsonl"))).toBe(false);
  });
});

describe("DatasetMirror.readText", () => {
  it("treats the Hub client's missing-file error as an absent metadata file", async () => {
    const missingHub: HubClient = {
      listJsonlFiles: () => Promise.resolve([]),
      downloadFile: (path) => Promise.reject(new Error(`dataset file not found: ${path}`)),
      commitFiles: () => Promise.resolve(),
    };
    const freshMirror = new DatasetMirror(missingHub, dir);

    await expect(freshMirror.readText("config/pool.json")).resolves.toBeUndefined();
  });
});

describe("DatasetMirror.appendAndCommit", () => {
  it("appends to per-day files and commits before touching the mirror", async () => {
    const tweetA = makePooled({ id: "1", captured_at: "2026-05-21T10:00:00.000Z" });
    const tweetB = makePooled({ id: "2", captured_at: "2026-05-22T10:00:00.000Z" });
    await mirror.appendAndCommit([tweetA, tweetB], "pool: osolmaz +2 tweets");
    expect(hub.commits).toHaveLength(1);
    expect(hub.commits[0]?.paths.sort()).toEqual([
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
      "data/osolmaz/2026/05/tweets-2026-05-22.jsonl",
    ]);
    const local = readFileSync(join(dir, "data/osolmaz/2026/05/tweets-2026-05-21.jsonl"), "utf8");
    expect(local).toBe(`${JSON.stringify(tweetA)}\n`);
  });

  it("appends to existing day files without losing prior lines", async () => {
    const first = makePooled({ id: "1" });
    const second = makePooled({ id: "2" });
    await mirror.appendAndCommit([first], "one");
    await mirror.appendAndCommit([second], "two");
    const path = "data/osolmaz/2026/05/tweets-2026-05-21.jsonl";
    expect(hub.files.get(path)).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  });

  it("leaves the mirror untouched when the hub commit fails", async () => {
    hub.failNextCommit = true;
    const tweet = makePooled();
    await expect(mirror.appendAndCommit([tweet], "boom")).rejects.toThrow("hub unavailable");
    expect(existsSync(join(dir, "data/osolmaz/2026/05/tweets-2026-05-21.jsonl"))).toBe(false);
    await mirror.appendAndCommit([tweet], "retry");
    expect(hub.files.get("data/osolmaz/2026/05/tweets-2026-05-21.jsonl")).toBe(
      `${JSON.stringify(tweet)}\n`,
    );
  });

  it("refuses dataset paths that escape the mirror root", async () => {
    const evil = makePooled({ contributed_by: "../../etc" });
    await expect(mirror.appendAndCommit([evil], "evil")).rejects.toThrow("escapes mirror root");
  });

  it("refuses sibling escapes that share the mirror root's name prefix", async () => {
    const sibling = new DatasetMirror(hub, join(dir, "mirror"));
    const evil = makePooled({ contributed_by: "../../mirror-evil" });
    await expect(sibling.appendAndCommit([evil], "evil")).rejects.toThrow("escapes mirror root");
  });
});
