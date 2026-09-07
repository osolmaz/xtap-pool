import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeObservation } from "@xtap-pool/shared";
import { ObservationStore, sourceReference } from "../src/observation-store.js";
import { TweetStore } from "../src/store.js";
import { makePooled } from "./helpers.js";

const databases: Database.Database[] = [];
const directories: string[] = [];
function createStore(path = ":memory:"): ObservationStore {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  databases.push(database);
  return new ObservationStore(database);
}
const source = { segmentKey: "segment-a", operation: 0, path: "tweets/a.jsonl", position: 0 };
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("normalized observation history", () => {
  it("retains one logical observation and each physical retry reference", () => {
    const store = createStore();
    const tweet = makePooled({ metrics: { likes: 12, views: 120 } });
    const observation = store.record(tweet, source);
    store.record(
      { ...tweet, pooled_at: "2026-07-07T00:00:00Z" },
      { ...source, segmentKey: "segment-b" },
    );
    const database = databases[0];
    expect(database?.prepare("SELECT COUNT(*) AS count FROM post_observations").get()).toEqual({
      count: 1,
    });
    expect(database?.prepare("SELECT COUNT(*) AS count FROM observation_sources").get()).toEqual({
      count: 2,
    });
    expect(store.get(observation.id)).toEqual(observation);
  });

  it("rejects conflicting records at one raw source location without a partial insert", () => {
    const store = createStore();
    store.record(makePooled(), source);
    const conflicting = makePooled({ text: "different content" });
    expect(() => store.record(conflicting, source)).toThrow(/source/);
    expect(store.has(normalizeObservation(conflicting).id)).toBe(false);
    expect(
      databases[0]?.prepare("SELECT COUNT(*) AS count FROM post_content_versions").get(),
    ).toEqual({ count: 1 });
  });

  it("keeps delayed observations without replacing the latest post", () => {
    const store = new TweetStore(":memory:");
    databases.push(store.database);
    const old = makePooled({ captured_at: "2026-05-21T00:00:00Z", metrics: { likes: 3 } });
    const recent = makePooled({ captured_at: "2026-05-22T00:00:00Z", metrics: { likes: 30 } });
    store.observations.recordBatch([recent], "new");
    store.insert([recent]);
    expect(store.classify([old]).accepted).toEqual([old]);
    store.observations.recordBatch([old], "old");
    store.insert([old]);
    expect(store.observations.get(normalizeObservation(old).id)?.metrics.likes).toBe(3);
    expect(store.database.prepare("SELECT captured_at FROM tweets").get()).toEqual({
      captured_at: new Date(recent.captured_at).toISOString(),
    });
  });

  it("preserves different same-post observations in one segment and retries exactly", () => {
    const store = createStore();
    const first = makePooled({ metrics: { likes: 10 } });
    const second = makePooled({ captured_at: "2026-05-21T09:04:35.954Z", metrics: { likes: 10 } });
    store.recordBatch([first, second], "one-segment");
    store.recordBatch([first, second], "one-segment");
    expect(databases[0]?.prepare("SELECT COUNT(*) AS count FROM post_observations").get()).toEqual({
      count: 2,
    });
    expect(
      databases[0]?.prepare("SELECT COUNT(*) AS count FROM post_content_versions").get(),
    ).toEqual({ count: 1 });
    expect(
      databases[0]?.prepare("SELECT position FROM observation_sources ORDER BY position").all(),
    ).toEqual([{ position: 0 }, { position: 1 }]);
  });

  it("produces the same logical rows after shuffled replay", () => {
    const first = makePooled({ metrics: { likes: 3 } });
    const retry = { ...first, pooled_at: "2026-07-08T00:00:00Z" };
    const second = makePooled({ captured_at: "2026-05-21T09:04:35.954Z", metrics: { likes: 2 } });
    const entries = [first, retry, second].map((tweet, index) => ({
      tweet,
      source: { ...source, segmentKey: `segment-${String(index)}` },
    }));
    const left = createStore();
    const right = createStore();
    for (const entry of entries) left.record(entry.tweet, entry.source);
    for (const entry of [...entries].reverse()) right.record(entry.tweet, entry.source);
    for (const table of ["post_content_versions", "post_observations", "observation_sources"]) {
      expect(databases[0]?.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(
        databases[1]?.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
      );
    }
    expect(left.get(normalizeObservation(second).id)?.metrics.likes).toBe(2);
  });

  it("keeps history through a database restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "xtap-observations-"));
    directories.push(directory);
    const path = join(directory, "index.sqlite");
    const store = createStore(path);
    const observation = store.record(makePooled(), source);
    databases[0]?.close();
    const reopened = createStore(path);
    expect(reopened.get(observation.id)).toEqual(observation);
  });

  it("clears derived history only through the explicit rebuild operation", () => {
    const store = createStore();
    const observation = store.record(makePooled(), source);
    store.clearForRebuild();
    expect(store.get(observation.id)).toBeNull();
    expect(
      databases[0]?.prepare("SELECT COUNT(*) AS count FROM observation_sources").get(),
    ).toEqual({ count: 0 });
  });

  it("uses every source coordinate in the opaque provenance reference", () => {
    const reference = sourceReference(source);
    expect(sourceReference({ ...source })).toBe(reference);
    for (const changed of [
      { ...source, segmentKey: "other" },
      { ...source, operation: 1 },
      { ...source, path: "other" },
      { ...source, position: 1 },
    ]) {
      expect(sourceReference(changed)).not.toBe(reference);
    }
  });
});
