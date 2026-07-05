import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatasetMirror } from "../src/dataset.js";
import { Mutex, ingestBatch } from "../src/ingest.js";
import type { IngestDeps } from "../src/ingest.js";
import { TweetStore } from "../src/store.js";
import { FakeHub, makeTweet } from "./helpers.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");

let dir: string;
let hub: FakeHub;
let deps: IngestDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xtap-pool-ingest-"));
  hub = new FakeHub();
  deps = {
    store: new TweetStore(),
    mirror: new DatasetMirror(hub, dir),
    now: () => NOW,
  };
});

afterEach(() => {
  deps.store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ingestBatch", () => {
  it("rejects malformed payloads", async () => {
    await expect(ingestBatch(deps, "osolmaz", { nope: true })).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(ingestBatch(deps, "osolmaz", { tweets: [] })).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("stamps verified identity, persists to the hub and indexes", async () => {
    const outcome = await ingestBatch(deps, "osolmaz", {
      tweets: [makeTweet(), { id: "broken" }],
    });
    expect(outcome).toMatchObject({ ok: true, added: 1, duplicates: 0 });
    if (!outcome.ok) return;
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]?.index).toBe(1);

    const committed = hub.files.get("data/osolmaz/2026/05/tweets-2026-05-21.jsonl");
    expect(committed).toBeDefined();
    const stored = JSON.parse(committed?.trim() ?? "{}") as Record<string, unknown>;
    expect(stored["contributed_by"]).toBe("osolmaz");
    expect(stored["pooled_at"]).toBe(NOW.toISOString());
    expect(deps.store.count()).toBe(1);
    expect(hub.commits[0]?.title).toBe("pool: osolmaz +1 tweets (2026-05-21)");
  });

  it("overrides forged attribution fields with the verified identity", async () => {
    await ingestBatch(deps, "alice", {
      tweets: [{ ...makeTweet(), contributed_by: "mallory", pooled_at: "1970-01-01" }],
    });
    const committed = hub.files.get("data/alice/2026/05/tweets-2026-05-21.jsonl");
    const stored = JSON.parse(committed?.trim() ?? "{}") as Record<string, unknown>;
    expect(stored["contributed_by"]).toBe("alice");
    expect(stored["pooled_at"]).toBe(NOW.toISOString());
  });

  it("counts duplicates without re-committing them", async () => {
    await ingestBatch(deps, "osolmaz", { tweets: [makeTweet()] });
    const again = await ingestBatch(deps, "osolmaz", { tweets: [makeTweet()] });
    expect(again).toMatchObject({ ok: true, added: 0, duplicates: 1 });
    expect(hub.commits).toHaveLength(1);
  });

  it("fails closed when the hub commit fails: nothing persisted locally", async () => {
    hub.failNextCommit = true;
    const outcome = await ingestBatch(deps, "osolmaz", { tweets: [makeTweet()] });
    expect(outcome).toMatchObject({ ok: false, status: 500 });
    expect(deps.store.count()).toBe(0);
    const retry = await ingestBatch(deps, "osolmaz", { tweets: [makeTweet()] });
    expect(retry).toMatchObject({ ok: true, added: 1 });
  });
});

describe("Mutex", () => {
  it("serializes critical sections in order, surviving rejections", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const slow = mutex.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow");
      return "slow";
    });
    const failing = mutex.run(() => {
      order.push("failing");
      return Promise.reject(new Error("boom"));
    });
    const fast = mutex.run(() => {
      order.push("fast");
      return Promise.resolve("fast");
    });
    await expect(slow).resolves.toBe("slow");
    await expect(failing).rejects.toThrow("boom");
    await expect(fast).resolves.toBe("fast");
    expect(order).toEqual(["slow", "failing", "fast"]);
  });
});
