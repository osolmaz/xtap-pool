import { createHash } from "node:crypto";
import { copyFile, readFile, rm } from "node:fs/promises";

import Database from "better-sqlite3";
import { CheckpointCoordinator } from "@osolmaz/hf-job-control";

import { EnrichmentCheckpointAdapter } from "./enrich-checkpoint.js";
import type { EnrichmentRunPlanInput } from "./enrich-run-plan.js";
import { canonicalPlanBytes, createEnrichmentRunPlan } from "./enrich-run-plan.js";
import {
  createEmptyEnrichmentState,
  markQueueCompleted,
  recordQueueAttempt,
} from "./enrich-state.js";
import type { BlockedRecord, RetryRecord } from "./enrich-state.js";
import type { CheckpointObjectStore } from "@osolmaz/hf-job-control";

const PLAN_PREFIX = "operations/enrichment/runs";

export type CompactWorkResult = {
  queueTotal: number;
  queueBaselineDone: number;
  queueDoneOrdinals: readonly number[];
  queueRetrying: readonly RetryRecord[];
  queueBlocked: readonly BlockedRecord[];
  registryTotal: number;
  retainedQueueUnits: number;
  retainedTweets: number;
  orderedSegments: Uint8Array;
};

type RegistryImportCursor = {
  afterName: string;
  scanned: number;
  observedAt: string;
};

export async function compactEnrichmentWorkDatabase(options: {
  sourcePath: string;
  destinationPath: string;
  registryBaselineScanned: number;
  registryCursor?: RegistryImportCursor;
}): Promise<CompactWorkResult> {
  validateRegistryImportCursor(options.registryCursor, options.registryBaselineScanned);
  await rm(options.destinationPath, { force: true });
  await copyFile(options.sourcePath, options.destinationPath);
  const db = new Database(options.destinationPath);
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = OFF");
    // eslint-disable-next-line complexity -- Compaction validates and maps every imported queue lifecycle state.
    const compact = db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS worker_queue_plan;
        DROP TABLE IF EXISTS worker_registry_plan;
        CREATE TABLE worker_queue_plan (
          ordinal INTEGER PRIMARY KEY,
          unit_id TEXT NOT NULL UNIQUE,
          input_hash TEXT NOT NULL,
          taxonomy_version INTEGER NOT NULL,
          initial_status TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          next_retry_at TEXT
        );
        CREATE TABLE worker_registry_plan (
          ordinal INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          evidence_hash TEXT NOT NULL
        );
      `);
      const queueRows = db
        .prepare(
          `SELECT unit_id, input_hash, taxonomy_version, status, attempts,
                  last_error_class, next_retry_at
           FROM enrich_queue ORDER BY unit_id`,
        )
        .all() as {
        unit_id: string;
        input_hash: string;
        taxonomy_version: number;
        status: string;
        attempts: number;
        last_error_class: string | null;
        next_retry_at: string | null;
      }[];
      for (const row of queueRows) {
        if (!["done", "pending", "retrying", "blocked"].includes(row.status)) {
          throw new Error(`unsupported imported queue status: ${row.status}`);
        }
        if (row.status === "blocked" && row.attempts < 1) {
          throw new Error("imported blocked queue row must have a positive attempt count");
        }
        if (
          (row.status === "retrying" || row.status === "blocked") &&
          row.last_error_class === null
        ) {
          throw new Error("imported unresolved queue row must have an error class");
        }
      }
      const insertQueue = db.prepare(
        `INSERT INTO worker_queue_plan
         (ordinal, unit_id, input_hash, taxonomy_version, initial_status, attempts, next_retry_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [ordinal, row] of queueRows.entries()) {
        insertQueue.run(
          ordinal,
          row.unit_id,
          row.input_hash,
          row.taxonomy_version,
          row.status,
          row.attempts,
          row.next_retry_at,
        );
      }
      const candidateRows = db
        .prepare(
          `SELECT name, first_observed_at
           FROM free_label_registry WHERE status = 'candidate' ORDER BY name`,
        )
        .all() as { name: string; first_observed_at: string }[];
      const candidates = candidateRows.filter((candidate) =>
        registryCandidateIsPending(candidate, options.registryCursor),
      );
      const evidence = db.prepare(
        `SELECT unit_id, tweet_id, quote FROM label_evidence
         WHERE kind = 'free' AND name = ? ORDER BY unit_id, tweet_id, quote`,
      );
      const insertRegistry = db.prepare(
        `INSERT INTO worker_registry_plan (ordinal, name, evidence_hash) VALUES (?, ?, ?)`,
      );
      for (const [index, candidate] of candidates.entries()) {
        const rows = evidence.all(candidate.name);
        insertRegistry.run(
          options.registryBaselineScanned + index,
          candidate.name,
          sha256Canonical(rows),
        );
      }
      db.exec(`
        CREATE TEMP TABLE keep_units AS
        SELECT unit_id FROM worker_queue_plan WHERE initial_status <> 'done'
        UNION
        SELECT DISTINCT unit_id FROM label_assignments
        WHERE kind = 'free' AND name IN (SELECT name FROM worker_registry_plan);

        DELETE FROM unit_members WHERE unit_id NOT IN (SELECT unit_id FROM keep_units);
        DELETE FROM tweets WHERE id NOT IN (SELECT tweet_id FROM unit_members);
        DELETE FROM enrichment WHERE unit_id NOT IN (SELECT unit_id FROM keep_units);
        DELETE FROM label_assignments
          WHERE unit_id NOT IN (SELECT unit_id FROM keep_units)
            OR (kind = 'free' AND name NOT IN (SELECT name FROM worker_registry_plan));
        DELETE FROM label_evidence
          WHERE unit_id NOT IN (SELECT unit_id FROM keep_units)
            OR (kind = 'free' AND name NOT IN (SELECT name FROM worker_registry_plan));
        DELETE FROM enrich_queue
          WHERE unit_id NOT IN (
            SELECT unit_id FROM worker_queue_plan WHERE initial_status <> 'done'
          );
        DELETE FROM recent_errors;
        DROP TABLE keep_units;
        INSERT INTO tweets_fts(tweets_fts) VALUES ('rebuild');
      `);
      const segmentRows = db
        .prepare(
          `SELECT key, oid, listed_oid, byte_length, content_sha256,
                  tweet_rows, enrichment_rows, attempt_rows, registry_rows, receipt_rows
           FROM source_segments ORDER BY key`,
        )
        .all();
      db.exec("DROP TABLE source_segments; DROP TABLE index_metadata;");
      const queueBaselineDone = queueRows.filter((row) => row.status === "done").length;
      return {
        queueTotal: queueRows.length,
        queueBaselineDone,
        queueDoneOrdinals: queueRows.flatMap((row, ordinal) =>
          row.status === "done" ? [ordinal] : [],
        ),
        queueRetrying: queueRows.flatMap((row, ordinal) =>
          row.status === "retrying"
            ? [
                {
                  ordinal,
                  attempts: row.attempts,
                  error_class: requireImportedErrorClass(row),
                  next_retry_at: row.next_retry_at,
                },
              ]
            : [],
        ),
        queueBlocked: queueRows.flatMap((row, ordinal) =>
          row.status === "blocked"
            ? [
                {
                  ordinal,
                  attempts: row.attempts,
                  reason: requireImportedErrorClass(row),
                  evidence_sha256: sha256Canonical({
                    unit_id: row.unit_id,
                    input_hash: row.input_hash,
                    attempts: row.attempts,
                    error_class: row.last_error_class,
                    status: row.status,
                  }),
                },
              ]
            : [],
        ),
        registryTotal: options.registryBaselineScanned + candidates.length,
        retainedQueueUnits: queueRows.length - queueBaselineDone,
        retainedTweets: countTable(db, "tweets"),
        orderedSegments: canonicalPlanBytes(segmentRows),
      };
    });
    const result = compact();
    const integrity = db.pragma("quick_check") as { quick_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      throw new Error("compact enrichment work database failed quick_check");
    }
    if (
      options.registryBaselineScanned < 0 ||
      options.registryBaselineScanned > result.registryTotal
    ) {
      throw new Error("registry baseline is outside the compact work plan");
    }
    db.exec("VACUUM");
    return result;
  } finally {
    db.close();
  }
}

export async function bootstrapEnrichmentRun(options: {
  sourceDatabasePath: string;
  compactDatabasePath: string;
  planInput: Omit<EnrichmentRunPlanInput, "work">;
  registryBaselineScanned: number;
  registryCursor?: RegistryImportCursor;
  store: CheckpointObjectStore;
  attemptId: string;
  jobId?: string;
  prefix?: string;
  createdAt?: string;
}): Promise<{ runId: string; planSha256: string }> {
  const compact = await compactEnrichmentWorkDatabase({
    sourcePath: options.sourceDatabasePath,
    destinationPath: options.compactDatabasePath,
    registryBaselineScanned: options.registryBaselineScanned,
    ...(options.registryCursor === undefined ? {} : { registryCursor: options.registryCursor }),
  });
  const prefix = options.prefix ?? PLAN_PREFIX;
  const workBytes = new Uint8Array(await readFile(options.compactDatabasePath));
  const workSha256 = sha256(workBytes);
  const workKey = `${prefix}/objects/work-plan-${workSha256}.sqlite`;
  await options.store.writeImmutable(workKey, workBytes);
  const segmentsSha256 = sha256(compact.orderedSegments);
  const segmentsKey = `${prefix}/objects/source-segments-${segmentsSha256}.json`;
  await options.store.writeImmutable(segmentsKey, compact.orderedSegments);
  const created = createEnrichmentRunPlan({
    ...options.planInput,
    source: {
      ...options.planInput.source,
      ordered_segments: {
        key: segmentsKey,
        sha256: segmentsSha256,
        bytes: compact.orderedSegments.byteLength,
      },
    },
    work: {
      key: workKey,
      sha256: workSha256,
      bytes: workBytes.byteLength,
      queue_total: compact.queueTotal,
      queue_baseline_done: compact.queueBaselineDone,
      registry_total: compact.registryTotal,
      registry_baseline_scanned: options.registryBaselineScanned,
    },
  });
  const planBytes = canonicalPlanBytes(created.plan);
  const planKey = `${prefix}/${created.plan.run_id}/plan.json`;
  await options.store.writeImmutable(planKey, planBytes);
  let initial = createEmptyEnrichmentState({
    runId: created.plan.run_id,
    planSha256: created.sha256,
    queueTotal: compact.queueTotal,
    queueBaselineDone: 0,
    registryTotal: compact.registryTotal,
    registryBaselineScanned: options.registryBaselineScanned,
  });
  initial = markQueueCompleted(initial, compact.queueDoneOrdinals);
  for (const retrying of compact.queueRetrying) {
    initial = recordQueueAttempt(initial, { status: "retrying", value: retrying });
  }
  for (const blocked of compact.queueBlocked) {
    initial = recordQueueAttempt(initial, { status: "blocked", value: blocked });
  }
  const adapter = new EnrichmentCheckpointAdapter({ ...initial, sequence: 1 });
  const coordinator = CheckpointCoordinator.create({
    runId: created.plan.run_id,
    attemptId: options.attemptId,
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    planSha256: created.sha256,
    store: options.store,
    prefix,
    clock: () => new Date(options.createdAt ?? created.plan.created_at),
  });
  await coordinator.commit(
    {
      name: "bootstrap",
      sequence: 1,
      reached_at: options.createdAt ?? created.plan.created_at,
      metadata: { imported: true },
    },
    adapter,
  );
  return { runId: created.plan.run_id, planSha256: created.sha256 };
}

function validateRegistryImportCursor(
  cursor: RegistryImportCursor | undefined,
  baselineScanned: number,
): void {
  if (cursor === undefined) return;
  if (cursor.scanned !== baselineScanned) {
    throw new Error("registry import cursor does not match the scanned baseline");
  }
  if (cursor.afterName.length === 0) {
    throw new Error("registry import cursor name must not be empty");
  }
  if (Number.isNaN(Date.parse(cursor.observedAt))) {
    throw new Error("registry import cursor timestamp is invalid");
  }
}

function registryCandidateIsPending(
  candidate: { name: string; first_observed_at: string },
  cursor: RegistryImportCursor | undefined,
): boolean {
  return (
    cursor === undefined ||
    candidate.name > cursor.afterName ||
    candidate.first_observed_at > cursor.observedAt
  );
}

function requireImportedErrorClass(row: { last_error_class: string | null }): string {
  if (row.last_error_class === null) {
    throw new Error("imported unresolved queue row must have an error class");
  }
  return row.last_error_class;
}

function countTable(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return sha256(canonicalPlanBytes(value));
}
