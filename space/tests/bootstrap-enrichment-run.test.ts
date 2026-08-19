import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointCoordinator, type CheckpointObjectStore } from "@osolmaz/hf-job-control";

import {
  bootstrapEnrichmentRun,
  compactEnrichmentWorkDatabase,
} from "../src/bootstrap-enrichment-run.js";
import { EnrichmentCheckpointAdapter } from "../src/enrich-checkpoint.js";
import { createEmptyEnrichmentState } from "../src/enrich-state.js";

const directories: string[] = [];
const CREATED_AT = "2026-08-19T12:00:00.000Z";

class MemoryObjects implements CheckpointObjectStore {
  readonly bucketId = "memory/checkpoints";
  readonly files = new Map<string, Uint8Array>();

  read(path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
    const existing = this.files.get(path);
    if (existing !== undefined && !Buffer.from(existing).equals(Buffer.from(bytes))) {
      throw new Error("immutable object differs");
    }
    this.files.set(path, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  writePointerHint(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  list(prefix: string): Promise<readonly string[]> {
    return Promise.resolve([...this.files.keys()].filter((key) => key.startsWith(prefix)).sort());
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("enrichment production bootstrap", () => {
  it("compacts a verified index to unresolved queue and registry evidence", async () => {
    const directory = await makeFixture();
    const result = await compactEnrichmentWorkDatabase({
      sourcePath: join(directory, "source.sqlite"),
      destinationPath: join(directory, "work.sqlite"),
      registryBaselineScanned: 7,
    });
    expect(result).toMatchObject({
      queueTotal: 5,
      queueBaselineDone: 2,
      registryTotal: 8,
      retainedQueueUnits: 3,
      retainedTweets: 4,
      queueRetrying: [
        {
          ordinal: 3,
          attempts: 2,
          error_class: "timeout",
          next_retry_at: "2026-08-19T13:00:00.000Z",
        },
      ],
    });
    expect(result.queueBlocked).toHaveLength(1);
    expect(result.queueBlocked[0]).toMatchObject({
      ordinal: 2,
      attempts: 5,
      reason: "invalid_output",
    });
    expect(result.queueBlocked[0]?.evidence_sha256).toMatch(/^[0-9a-f]{64}$/u);
    const work = new Database(join(directory, "work.sqlite"), { readonly: true });
    expect(
      work.prepare("SELECT ordinal, unit_id FROM worker_queue_plan ORDER BY ordinal").all(),
    ).toEqual([
      { ordinal: 0, unit_id: "u1" },
      { ordinal: 1, unit_id: "u2" },
      { ordinal: 2, unit_id: "u3" },
      { ordinal: 3, unit_id: "u4" },
      { ordinal: 4, unit_id: "u5" },
    ]);
    expect(work.prepare("SELECT ordinal, name FROM worker_registry_plan").all()).toEqual([
      { ordinal: 7, name: "candidate" },
    ]);
    expect(
      work
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'worker_unit_payloads'",
        )
        .get(),
    ).toEqual({ count: 0 });
    work.close();
    expect((await stat(join(directory, "work.sqlite"))).size).toBeLessThan(
      (await stat(join(directory, "source.sqlite"))).size,
    );
  });

  it("rejects malformed blocked source state instead of inventing attempts", async () => {
    const directory = await makeFixture();
    const sourcePath = join(directory, "source.sqlite");
    const source = new Database(sourcePath);
    source.prepare("UPDATE enrich_queue SET attempts = 0 WHERE status = 'blocked'").run();
    source.close();
    await expect(
      compactEnrichmentWorkDatabase({
        sourcePath,
        destinationPath: join(directory, "invalid-work.sqlite"),
        registryBaselineScanned: 7,
      }),
    ).rejects.toThrow("positive attempt count");
  });

  it("writes only isolated immutable bootstrap objects", async () => {
    const directory = await makeFixture();
    const store = new MemoryObjects();
    const bootstrapped = await bootstrapEnrichmentRun({
      sourceDatabasePath: join(directory, "source.sqlite"),
      compactDatabasePath: join(directory, "work.sqlite"),
      registryBaselineScanned: 7,
      store,
      attemptId: "attempt-1",
      prefix: "test-import",
      createdAt: CREATED_AT,
      planInput: {
        schema_version: 1,
        created_at: CREATED_AT,
        source: {
          bucket: "owner/raw",
          snapshot_revision: "a".repeat(64),
          ordered_segments: { key: "unused", sha256: "b".repeat(64), bytes: 1 },
        },
        contract: {
          worker_revision: "c".repeat(64),
          contract_sha256: "d".repeat(64),
          taxonomy_version: 1,
          model: "model",
          provider: "provider",
        },
        base_index: {
          key: "index/databases/base.sqlite",
          sha256: "e".repeat(64),
          bytes: 100,
          source_segment_count: 1,
          receipt_count: 1,
          registry_revision: 10,
        },
      },
    });
    expect(bootstrapped.runId).toMatch(/^xtap-/u);
    expect([...store.files.keys()].every((key) => key.startsWith("test-import/"))).toBe(true);
    expect([...store.files.keys()].some((key) => key.endsWith("/plan.json"))).toBe(true);
    expect([...store.files.keys()].some((key) => key.includes("/claims/"))).toBe(true);
    expect([...store.files.keys()].some((key) => key === "index/current.json")).toBe(false);
    const adapter = new EnrichmentCheckpointAdapter(
      createEmptyEnrichmentState({
        runId: bootstrapped.runId,
        planSha256: bootstrapped.planSha256,
        queueTotal: 5,
        queueBaselineDone: 0,
        registryTotal: 8,
        registryBaselineScanned: 7,
      }),
    );
    const coordinator = CheckpointCoordinator.create({
      runId: bootstrapped.runId,
      attemptId: "attempt-2",
      planSha256: bootstrapped.planSha256,
      store,
      prefix: "test-import",
    });
    await expect(coordinator.restoreLatest(adapter)).resolves.not.toBeNull();
    expect(adapter.state.queue).toMatchObject({
      total: 5,
      done: 2,
      retrying: [
        {
          ordinal: 3,
          attempts: 2,
          error_class: "timeout",
          next_retry_at: "2026-08-19T13:00:00.000Z",
        },
      ],
    });
    expect(adapter.state.queue.blocked).toHaveLength(1);
    expect(adapter.state.queue.blocked[0]).toMatchObject({
      ordinal: 2,
      attempts: 5,
      reason: "invalid_output",
    });
  });
});

async function makeFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xtap-work-plan-"));
  directories.push(directory);
  const db = new Database(join(directory, "source.sqlite"));
  db.exec(`
    CREATE TABLE tweets (id TEXT, contributed_by TEXT, captured_at TEXT, pooled_at TEXT,
      sort_ts TEXT, author_username TEXT, text TEXT, has_media INTEGER,
      is_article INTEGER, json TEXT, PRIMARY KEY (id, contributed_by));
    CREATE VIRTUAL TABLE tweets_fts USING fts5(text, author_username, content='tweets', content_rowid='rowid');
    CREATE TABLE unit_members (tweet_id TEXT PRIMARY KEY, unit_id TEXT, captured_at TEXT);
    CREATE TABLE enrich_queue (unit_id TEXT PRIMARY KEY, status TEXT, attempts INTEGER,
      last_error TEXT, last_error_class TEXT, taxonomy_version INTEGER, input_hash TEXT,
      contract_hash TEXT, first_queued_at TEXT, latest_activity_at TEXT, next_retry_at TEXT,
      lease_owner TEXT, lease_expires_at TEXT, updated_at TEXT);
    CREATE TABLE enrichment (unit_id TEXT PRIMARY KEY, taxonomy_version INTEGER, tweet_ids TEXT,
      input_hash TEXT, contract_hash TEXT, model TEXT, enriched_at TEXT);
    CREATE TABLE label_assignments (unit_id TEXT, name TEXT, kind TEXT,
      PRIMARY KEY (unit_id, name, kind));
    CREATE TABLE label_evidence (unit_id TEXT, name TEXT, kind TEXT, tweet_id TEXT, quote TEXT,
      PRIMARY KEY (unit_id, name, kind, tweet_id, quote));
    CREATE TABLE free_label_registry (name TEXT PRIMARY KEY, status TEXT,
      first_observed_at TEXT, updated_at TEXT, reason TEXT);
    CREATE TABLE registry_revision (singleton INTEGER PRIMARY KEY, revision INTEGER);
    CREATE TABLE recent_errors (seq INTEGER PRIMARY KEY, at TEXT, error_class TEXT);
    CREATE TABLE source_segments (key TEXT PRIMARY KEY, oid TEXT, listed_oid TEXT,
      byte_length INTEGER, content_sha256 TEXT, tweet_rows INTEGER, enrichment_rows INTEGER,
      attempt_rows INTEGER, registry_rows INTEGER, receipt_rows INTEGER);
    CREATE TABLE index_metadata (singleton INTEGER PRIMARY KEY, schema_version INTEGER,
      raw_bucket TEXT, raw_snapshot_revision TEXT, contract_hash TEXT);
  `);
  const insertTweet = db.prepare(
    "INSERT INTO tweets VALUES (?, 'owner', ?, ?, ?, 'author', ?, 0, 0, ?)",
  );
  const insertMember = db.prepare("INSERT INTO unit_members VALUES (?, ?, ?)");
  const insertQueue = db.prepare(
    `INSERT INTO enrich_queue VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  );
  for (const [index, status] of ["done", "pending", "blocked", "retrying", "done"].entries()) {
    const id = `t${String(index + 1)}`;
    const unit = `u${String(index + 1)}`;
    const time = `2026-08-19T12:00:0${String(index)}.000Z`;
    insertTweet.run(id, time, time, time, id, JSON.stringify({ id, padding: "x".repeat(100_000) }));
    insertMember.run(id, unit, time);
    const attempts = status === "blocked" ? 5 : status === "retrying" ? 2 : 0;
    const errorClass =
      status === "blocked" ? "invalid_output" : status === "retrying" ? "timeout" : null;
    const nextRetry = status === "retrying" ? "2026-08-19T13:00:00.000Z" : null;
    insertQueue.run(
      unit,
      status,
      attempts,
      errorClass,
      String(index).repeat(64),
      "c".repeat(64),
      time,
      time,
      nextRetry,
      time,
    );
  }
  db.prepare("INSERT INTO free_label_registry VALUES ('candidate', 'candidate', ?, ?, NULL)").run(
    CREATED_AT,
    CREATED_AT,
  );
  db.prepare("INSERT INTO label_assignments VALUES ('u1', 'candidate', 'free')").run();
  db.prepare("INSERT INTO label_evidence VALUES ('u1', 'candidate', 'free', 't1', 'quote')").run();
  db.prepare("INSERT INTO registry_revision VALUES (1, 10)").run();
  db.prepare(`INSERT INTO source_segments VALUES ('segment', ?, NULL, 1, ?, 5, 0, 0, 0, 0)`).run(
    "f".repeat(64),
    "f".repeat(64),
  );
  db.close();
  return directory;
}
