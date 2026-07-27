import type Database from "better-sqlite3";

import {
  computeInputHash,
  isCurrentEnrichmentRow,
  semanticTweetFields,
  unitIdFor,
} from "@xtap-pool/shared";
import { readVisibleAssignments } from "./label-visibility.js";
import { validateEvidenceQuotes } from "./free-label-rules.js";
import type {
  AttemptEvent,
  EnrichmentRow,
  ErrorClass,
  FreeLabelCandidateDetail,
  FreeLabelCount,
  FreeLabelDetail,
  FreeLabelEvent,
  FreeLabelStatus,
  FreeLabelSummary,
  GraphLink,
  GraphNode,
  LabelAssignment,
  LabelConfig,
  LabelsSummary,
  PooledTweet,
  QueueDepth,
  RelatedFreeLabel,
  SemanticTweetFields,
} from "@xtap-pool/shared";

/** Maximum transient/invalid attempts before a unit is marked `blocked`. */
export const MAX_ATTEMPTS = 5;

/** Bounded lookback for the recent-error breakdown surfaced by /status. */
export const RECENT_ERROR_WINDOW = 100;

/** Query caps applied by consumer helpers. */
const FREE_LABEL_LIMIT = 50;
const RELATED_LIMIT = 50;

/** One unit ready for the worker; includes the hashes that produced it. */
export type QueueItem = {
  unitId: string;
  tweetIds: readonly string[];
  attempts: number;
  inputHash: string;
  contractHash: string;
  firstQueuedAt: string;
  leaseExpiresAt: string;
};

export type QueueStatus = "pending" | "running" | "retrying" | "done" | "blocked";

type QueueEntryRow = {
  unit_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  last_error_class: string | null;
  input_hash: string;
  contract_hash: string;
  first_queued_at: string;
  latest_activity_at: string;
  next_retry_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
};

type FreeLabelRegistryRow = {
  name: string;
  status: FreeLabelStatus;
  first_observed_at: string;
  updated_at: string;
  reason: string | null;
};

function isLegalRegistryTransition(
  previous: FreeLabelStatus | undefined,
  next: FreeLabelStatus,
): boolean {
  if (previous === undefined) return next === "candidate" || next === "rejected";
  if (previous === "candidate") return true;
  // An approved label can be administratively rejected, but a rejected label
  // cannot silently reopen within the same contract.
  return previous === "approved" && next === "rejected";
}

/**
 * Enrichment tables live beside the tweet index so label filters compose
 * with tweet queries in one SQL statement. Everything here is a cache
 * rebuilt from the dataset (tweets + result shards + attempt events +
 * registry events).
 */
export function ensureEnrichmentTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_members (
      tweet_id TEXT PRIMARY KEY,
      unit_id TEXT NOT NULL,
      captured_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_unit_members_unit ON unit_members(unit_id, tweet_id);
    CREATE TABLE IF NOT EXISTS enrich_queue (
      unit_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_error_class TEXT,
      taxonomy_version INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      contract_hash TEXT NOT NULL,
      first_queued_at TEXT NOT NULL,
      latest_activity_at TEXT NOT NULL,
      next_retry_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_enrich_queue_status
      ON enrich_queue(status, next_retry_at, latest_activity_at, first_queued_at, unit_id);
    CREATE TABLE IF NOT EXISTS enrichment (
      unit_id TEXT NOT NULL,
      taxonomy_version INTEGER NOT NULL,
      tweet_ids TEXT NOT NULL,
      input_hash TEXT,
      contract_hash TEXT,
      model TEXT NOT NULL,
      enriched_at TEXT NOT NULL,
      PRIMARY KEY (unit_id)
    );
    CREATE TABLE IF NOT EXISTS label_assignments (
      unit_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (unit_id, name, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_label_assignments_kind_name
      ON label_assignments(kind, name, unit_id);
    CREATE TABLE IF NOT EXISTS label_evidence (
      unit_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      tweet_id TEXT NOT NULL,
      quote TEXT NOT NULL,
      PRIMARY KEY (unit_id, name, kind, tweet_id, quote)
    );
    CREATE INDEX IF NOT EXISTS idx_label_evidence_lookup
      ON label_evidence(kind, name, unit_id);
    CREATE TABLE IF NOT EXISTS free_label_registry (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      first_observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_free_label_registry_status
      ON free_label_registry(status, name);
    CREATE TABLE IF NOT EXISTS registry_revision (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL DEFAULT 1
    );
    INSERT OR IGNORE INTO registry_revision (singleton, revision) VALUES (1, 1);
    CREATE TABLE IF NOT EXISTS recent_errors (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      error_class TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recent_errors_at ON recent_errors(seq);
  `);
}

/**
 * SQLite layer for the enrichment pipeline: queue, label assignments,
 * per-assignment evidence, free-label registry.
 */
export class EnrichStore {
  private contractHash: string;

  constructor(
    private readonly db: Database.Database,
    private readonly taxonomyVersion: number,
    private readonly now: () => Date = (): Date => new Date(),
    contractHash = "unset-contract",
  ) {
    this.contractHash = contractHash;
    ensureEnrichmentTables(db);
  }

  setContractHash(contractHash: string): void {
    if (contractHash === this.contractHash) return;
    const changedAt = this.now().toISOString();
    const invalidate = this.db.transaction(() => {
      for (const table of [
        "label_evidence",
        "label_assignments",
        "enrichment",
        "free_label_registry",
        "recent_errors",
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db
        .prepare(
          `UPDATE enrich_queue SET
             status = 'pending', attempts = 0, last_error = NULL, last_error_class = NULL,
             taxonomy_version = ?, contract_hash = ?, next_retry_at = NULL,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?`,
        )
        .run(this.taxonomyVersion, contractHash, changedAt);
      this.db.prepare("UPDATE registry_revision SET revision = 1 WHERE singleton = 1").run();
    });
    invalidate();
    this.contractHash = contractHash;
  }

  currentContractHash(): string {
    return this.contractHash;
  }

  registryRevision(): number {
    const row = this.db
      .prepare("SELECT revision FROM registry_revision WHERE singleton = 1")
      .get() as { revision: number } | undefined;
    return row?.revision ?? 1;
  }

  bumpRegistryRevision(): number {
    const next = this.registryRevision() + 1;
    this.db.prepare("UPDATE registry_revision SET revision = ? WHERE singleton = 1").run(next);
    return next;
  }

  /** Clear all derived enrichment state before replaying a complete dataset snapshot. */
  clearForRebuild(): void {
    const clear = this.db.transaction(() => {
      for (const table of [
        "label_evidence",
        "label_assignments",
        "enrichment",
        "enrich_queue",
        "unit_members",
        "free_label_registry",
        "recent_errors",
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db.prepare("UPDATE registry_revision SET revision = 1 WHERE singleton = 1").run();
    });
    clear();
  }

  /** Record unit membership. New units enter as `pending`. */
  registerTweets(tweets: readonly PooledTweet[]): string[] {
    const register = this.db.transaction((batch: readonly PooledTweet[]): string[] => {
      const dirty = new Set<string>();
      for (const tweet of batch) {
        const unitId = unitIdFor(tweet);
        const result = this.registerMembership(tweet, unitId);
        if (result.dirty) dirty.add(unitId);
        if (result.previousUnitId !== undefined) {
          this.clearUnitEnrichment(result.previousUnitId);
          if (this.unitMemberIds(result.previousUnitId).length > 0) {
            dirty.add(result.previousUnitId);
          }
        }
      }
      for (const unitId of [...dirty]) {
        if (this.unitMemberIds(unitId).length === 0) {
          dirty.delete(unitId);
          this.clearUnitEnrichment(unitId);
        }
      }
      for (const unitId of dirty) this.refreshQueueForUnit(unitId);
      return [...dirty].sort();
    });
    return register(tweets);
  }

  private registerMembership(
    tweet: PooledTweet,
    unitId: string,
  ): { dirty: boolean; previousUnitId?: string } {
    const tweetId = tweet.id;
    const capturedAt = tweet.captured_at;
    const existing = this.db
      .prepare("SELECT unit_id, captured_at FROM unit_members WHERE tweet_id = ?")
      .get(tweetId) as { unit_id: string; captured_at: string } | undefined;
    if (existing === undefined) {
      this.db
        .prepare("INSERT INTO unit_members (tweet_id, unit_id, captured_at) VALUES (?, ?, ?)")
        .run(tweetId, unitId, capturedAt);
      return { dirty: true };
    }
    if (existing.captured_at > capturedAt) return { dirty: false };
    if (existing.unit_id !== unitId) {
      this.db
        .prepare("UPDATE unit_members SET unit_id = ?, captured_at = ? WHERE tweet_id = ?")
        .run(unitId, capturedAt, tweetId);
      return { dirty: true, previousUnitId: existing.unit_id };
    }
    this.db
      .prepare("UPDATE unit_members SET captured_at = ? WHERE tweet_id = ?")
      .run(capturedAt, tweetId);
    return { dirty: true };
  }

  private refreshQueueForUnit(unitId: string): void {
    const members = this.semanticMembersFor(unitId);
    if (members.length === 0) return;
    const inputHash = computeInputHash(unitId, members);
    const latestActivityAt = this.latestActivityAt(unitId);
    if (this.hasCurrentEnrichment(unitId, inputHash)) {
      this.settleDone(unitId, inputHash, latestActivityAt);
      return;
    }
    const nowIso = this.now().toISOString();
    const existing = this.rawQueueEntry(unitId);
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO enrich_queue
             (unit_id, status, attempts, last_error, last_error_class,
              taxonomy_version, input_hash, contract_hash, first_queued_at,
              latest_activity_at, next_retry_at, lease_owner, lease_expires_at, updated_at)
           VALUES (?, 'pending', 0, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(
          unitId,
          this.taxonomyVersion,
          inputHash,
          this.contractHash,
          latestActivityAt,
          latestActivityAt,
          nowIso,
        );
      return;
    }
    const contractChanged = existing.contract_hash !== this.contractHash;
    const inputChanged = existing.input_hash !== inputHash;
    if (contractChanged || inputChanged) {
      this.db
        .prepare(
          `UPDATE enrich_queue SET
             status = 'pending', attempts = 0, last_error = NULL, last_error_class = NULL,
             taxonomy_version = ?, input_hash = ?, contract_hash = ?,
             latest_activity_at = ?, next_retry_at = NULL,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE unit_id = ?`,
        )
        .run(this.taxonomyVersion, inputHash, this.contractHash, latestActivityAt, nowIso, unitId);
      return;
    }
    this.db
      .prepare(
        `UPDATE enrich_queue SET
           taxonomy_version = ?, latest_activity_at = ?, updated_at = ?
         WHERE unit_id = ?`,
      )
      .run(this.taxonomyVersion, latestActivityAt, nowIso, unitId);
  }

  private settleDone(unitId: string, inputHash: string, latestActivityAt: string): void {
    const nowIso = this.now().toISOString();
    const existing = this.rawQueueEntry(unitId);
    const firstQueued = existing?.first_queued_at ?? nowIso;
    this.db
      .prepare(
        `INSERT INTO enrich_queue
           (unit_id, status, attempts, last_error, last_error_class,
            taxonomy_version, input_hash, contract_hash, first_queued_at,
            latest_activity_at, next_retry_at, lease_owner, lease_expires_at, updated_at)
         VALUES (?, 'done', 0, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
         ON CONFLICT (unit_id) DO UPDATE SET
           status = 'done',
           attempts = 0,
           last_error = NULL,
           last_error_class = NULL,
           taxonomy_version = excluded.taxonomy_version,
           input_hash = excluded.input_hash,
           contract_hash = excluded.contract_hash,
           first_queued_at = COALESCE(enrich_queue.first_queued_at, excluded.first_queued_at),
           latest_activity_at = excluded.latest_activity_at,
           next_retry_at = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        unitId,
        this.taxonomyVersion,
        inputHash,
        this.contractHash,
        firstQueued,
        latestActivityAt,
        nowIso,
      );
  }

  private clearUnitEnrichment(unitId: string): void {
    this.db.prepare("DELETE FROM label_assignments WHERE unit_id = ?").run(unitId);
    this.db.prepare("DELETE FROM label_evidence WHERE unit_id = ?").run(unitId);
    this.db.prepare("DELETE FROM enrichment WHERE unit_id = ?").run(unitId);
    this.db.prepare("DELETE FROM enrich_queue WHERE unit_id = ?").run(unitId);
  }

  private hasCurrentEnrichment(unitId: string, inputHash: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM enrichment WHERE unit_id = ? AND taxonomy_version = ?
           AND input_hash = ? AND contract_hash = ?`,
      )
      .get(unitId, this.taxonomyVersion, inputHash, this.contractHash);
    return row !== undefined;
  }

  private rawQueueEntry(unitId: string): QueueEntryRow | undefined {
    return this.db
      .prepare(
        `SELECT unit_id, status, attempts, last_error, last_error_class, input_hash,
                contract_hash, first_queued_at, latest_activity_at, next_retry_at,
                lease_owner, lease_expires_at
         FROM enrich_queue WHERE unit_id = ?`,
      )
      .get(unitId) as QueueEntryRow | undefined;
  }

  private semanticMembersFor(unitId: string): SemanticTweetFields[] {
    const rows = this.db
      .prepare(
        `SELECT tweets.json FROM (
           SELECT tweets.rowid, tweets.id,
                  ROW_NUMBER() OVER (PARTITION BY tweets.id ORDER BY tweets.captured_at DESC, tweets.contributed_by) AS rn
           FROM tweets
           JOIN unit_members um ON um.tweet_id = tweets.id
           WHERE um.unit_id = ?
         ) picks JOIN tweets ON tweets.rowid = picks.rowid
         WHERE picks.rn = 1 ORDER BY tweets.id`,
      )
      .all(unitId) as { json: string }[];
    return rows.map((row) => semanticTweetFields(JSON.parse(row.json) as PooledTweet));
  }

  private latestActivityAt(unitId: string): string {
    const row = this.db
      .prepare(
        `SELECT MAX(tweets.captured_at) AS latest FROM tweets
         JOIN unit_members um ON um.tweet_id = tweets.id
         WHERE um.unit_id = ?`,
      )
      .get(unitId) as { latest: string | null };
    return row.latest ?? this.now().toISOString();
  }

  unitMemberIds(unitId: string): string[] {
    const rows = this.db
      .prepare("SELECT tweet_id FROM unit_members WHERE unit_id = ? ORDER BY tweet_id")
      .all(unitId) as { tweet_id: string }[];
    return rows.map((row) => row.tweet_id);
  }

  unitSemanticMembers(unitId: string): SemanticTweetFields[] {
    return this.semanticMembersFor(unitId);
  }

  /** Tweet text for prompt building, ordered oldest first and truncated. */
  unitText(unitId: string, maxChars: number): string {
    const rows = this.db
      .prepare(
        `SELECT text FROM (
           SELECT id, sort_ts AS ts, text,
                  ROW_NUMBER() OVER (PARTITION BY id ORDER BY captured_at DESC) AS rn
           FROM tweets
           WHERE id IN (SELECT tweet_id FROM unit_members WHERE unit_id = ?)
         ) WHERE rn = 1 ORDER BY ts, id`,
      )
      .all(unitId) as { text: string }[];
    return rows
      .map((row) => row.text)
      .join("\n\n")
      .slice(0, maxChars);
  }

  /** Return tweet text keyed by id for evidence-quote validation. */
  unitTweetTexts(unitId: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT id, text FROM (
           SELECT tweets.id, tweets.text,
                  ROW_NUMBER() OVER (PARTITION BY tweets.id ORDER BY tweets.captured_at DESC) AS rn
           FROM tweets
           JOIN unit_members um ON um.tweet_id = tweets.id
           WHERE um.unit_id = ?
         ) WHERE rn = 1`,
      )
      .all(unitId) as { id: string; text: string }[];
    return new Map(rows.map((row) => [row.id, row.text]));
  }

  /** Author usernames present in the unit; used for promotion evidence. */
  unitAuthors(unitId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT tweets.author_username AS username FROM tweets
         JOIN unit_members um ON um.tweet_id = tweets.id
         WHERE um.unit_id = ?`,
      )
      .all(unitId) as { username: string }[];
    return rows.map((row) => row.username);
  }

  claimBatch(options: { limit: number; workerId: string; leaseMs: number }): QueueItem[] {
    const nowIso = this.now().toISOString();
    const leaseUntil = new Date(this.now().getTime() + options.leaseMs).toISOString();
    const newestLimit = options.limit === 1 ? 0 : Math.max(1, Math.floor(options.limit / 2));
    const claim = this.db.transaction((): QueueEntryRow[] => {
      const claimed: QueueEntryRow[] = [];
      const eligible = (
        orderBy: string,
        exclude: readonly string[],
        limit: number,
      ): QueueEntryRow[] => {
        if (limit <= 0) return [];
        const placeholders = exclude.length === 0 ? "" : exclude.map(() => "?").join(",");
        const excludeSql = exclude.length === 0 ? "" : `AND unit_id NOT IN (${placeholders})`;
        return this.db
          .prepare(
            `SELECT unit_id, status, attempts, last_error, last_error_class, input_hash,
                    contract_hash, first_queued_at, latest_activity_at, next_retry_at,
                    lease_owner, lease_expires_at
             FROM enrich_queue
             WHERE status IN ('pending', 'retrying', 'blocked')
               AND (next_retry_at IS NULL OR next_retry_at <= ?)
               ${excludeSql}
             ORDER BY ${orderBy} LIMIT ?`,
          )
          .all(nowIso, ...exclude, limit) as QueueEntryRow[];
      };
      const newest = eligible("latest_activity_at DESC, unit_id ASC", [], newestLimit);
      claimed.push(...newest);
      const usedIds = claimed.map((row) => row.unit_id);
      const oldest = eligible(
        "first_queued_at ASC, unit_id ASC",
        usedIds,
        options.limit - claimed.length,
      );
      claimed.push(...oldest);
      const filled = claimed.map((row) => row.unit_id);
      if (claimed.length < options.limit) {
        const fill = eligible(
          "latest_activity_at DESC, unit_id ASC",
          filled,
          options.limit - claimed.length,
        );
        claimed.push(...fill);
      }
      for (const row of claimed) {
        this.db
          .prepare(
            `UPDATE enrich_queue SET
               status = 'running',
               lease_owner = ?,
               lease_expires_at = ?,
               updated_at = ?
             WHERE unit_id = ?`,
          )
          .run(options.workerId, leaseUntil, nowIso, row.unit_id);
      }
      return claimed;
    });
    const rows = claim();
    return rows.map((row) => ({
      unitId: row.unit_id,
      tweetIds: this.unitMemberIds(row.unit_id),
      attempts: row.attempts,
      inputHash: row.input_hash,
      contractHash: row.contract_hash,
      firstQueuedAt: row.first_queued_at,
      leaseExpiresAt: leaseUntil,
    }));
  }

  recoverExpiredLeases(): number {
    const nowIso = this.now().toISOString();
    const rows = this.db
      .prepare(
        `UPDATE enrich_queue SET
           status = CASE WHEN attempts > 0 THEN 'retrying' ELSE 'pending' END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = ?
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
         RETURNING unit_id`,
      )
      .all(nowIso, nowIso) as { unit_id: string }[];
    return rows.length;
  }

  releaseClaims(workerId?: string, unitIds?: readonly string[]): void {
    const owner = workerId === undefined ? "" : " AND lease_owner = ?";
    const ids =
      unitIds === undefined || unitIds.length === 0
        ? ""
        : ` AND unit_id IN (${unitIds.map(() => "?").join(",")})`;
    this.db
      .prepare(
        `UPDATE enrich_queue SET
           status = CASE WHEN attempts > 0 THEN 'retrying' ELSE 'pending' END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = ?
         WHERE status = 'running'${owner}${ids}`,
      )
      .run(
        this.now().toISOString(),
        ...(workerId === undefined ? [] : [workerId]),
        ...(unitIds ?? []),
      );
  }

  claimQueued(limit: number): QueueItem[] {
    return this.claimBatch({ limit, workerId: "test", leaseMs: 60_000 });
  }

  markTransientFailure(
    unitId: string,
    error: string,
    errorClass: ErrorClass,
    nextRetryAt: Date | undefined,
  ): void {
    this.recordAttemptError(unitId, error, errorClass, nextRetryAt, false);
  }

  markInvalidOutput(unitId: string, error: string, nextRetryAt: Date | undefined): void {
    this.recordAttemptError(unitId, error, "invalid_output", nextRetryAt, false);
  }

  markBlocked(unitId: string, error: string, errorClass: ErrorClass, nextRetryAt: Date): void {
    this.recordAttemptError(unitId, error, errorClass, nextRetryAt, true);
  }

  private recordAttemptError(
    unitId: string,
    error: string,
    errorClass: ErrorClass,
    nextRetryAt: Date | undefined,
    forceBlocked: boolean,
  ): void {
    const nowIso = this.now().toISOString();
    this.db
      .prepare("INSERT INTO recent_errors (at, error_class) VALUES (?, ?)")
      .run(nowIso, errorClass);
    this.db
      .prepare(
        `DELETE FROM recent_errors WHERE seq <=
           COALESCE((SELECT seq FROM recent_errors ORDER BY seq DESC LIMIT 1 OFFSET ?), 0)`,
      )
      .run(RECENT_ERROR_WINDOW);
    this.db
      .prepare(
        `UPDATE enrich_queue SET
           attempts = attempts + 1,
           last_error = ?,
           last_error_class = ?,
           status = CASE
             WHEN ? = 1 THEN 'blocked'
             WHEN attempts + 1 >= ? THEN 'blocked'
             ELSE 'retrying'
           END,
           next_retry_at = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = ?
         WHERE unit_id = ?`,
      )
      .run(
        error,
        errorClass,
        forceBlocked ? 1 : 0,
        MAX_ATTEMPTS,
        nextRetryAt === undefined ? null : nextRetryAt.toISOString(),
        nowIso,
        unitId,
      );
  }

  markFailed(unitId: string, error: string): void {
    this.markTransientFailure(unitId, error, "other", undefined);
  }

  queueEntry(unitId: string):
    | {
        status: QueueStatus;
        attempts: number;
        lastError: string | null;
        lastErrorClass: string | null;
        inputHash: string;
        contractHash: string;
        nextRetryAt: string | null;
        firstQueuedAt: string;
        latestActivityAt: string;
      }
    | undefined {
    const row = this.rawQueueEntry(unitId);
    if (row === undefined) return undefined;
    return {
      status: row.status as QueueStatus,
      attempts: row.attempts,
      lastError: row.last_error,
      lastErrorClass: row.last_error_class,
      inputHash: row.input_hash,
      contractHash: row.contract_hash,
      nextRetryAt: row.next_retry_at,
      firstQueuedAt: row.first_queued_at,
      latestActivityAt: row.latest_activity_at,
    };
  }

  /**
   * Upsert one enrichment result: rewrite the unit's evidence-bearing label
   * assignments, then settle the queue entry when the row covers the unit's
   * current membership and hashes. Legacy rows without evidence never settle
   * the queue on replay.
   */
  applyEnrichment(row: EnrichmentRow): void {
    const apply = this.db.transaction((enrichment: EnrichmentRow) => {
      if (this.unitMemberIds(enrichment.unit_id).length === 0) {
        return;
      }
      // Historical rows, rows from another contract, and stale rows may be
      // retained in the append-only dataset, but must never erase a current
      // projection or seed registry state during replay.
      if (!this.matchesCurrentUnit(enrichment)) return;
      const existing = this.db
        .prepare("SELECT enriched_at, input_hash FROM enrichment WHERE unit_id = ?")
        .get(enrichment.unit_id) as { enriched_at: string; input_hash: string } | undefined;
      if (
        existing?.input_hash === enrichment.input_hash &&
        existing.enriched_at >= enrichment.enriched_at
      ) {
        return;
      }
      // Wipe previous assignments/evidence and rewrite from the new row.
      this.db.prepare("DELETE FROM label_assignments WHERE unit_id = ?").run(enrichment.unit_id);
      this.db.prepare("DELETE FROM label_evidence WHERE unit_id = ?").run(enrichment.unit_id);
      this.writeAssignments(enrichment.unit_id, enrichment.preset_labels, "preset");
      this.writeAssignments(enrichment.unit_id, enrichment.free_labels, "free");
      this.upsertEnrichmentRow(enrichment);
      this.settleQueueForRow(enrichment);
    });
    apply(row);
  }

  private writeAssignments(
    unitId: string,
    assignments: readonly LabelAssignment[],
    kind: "preset" | "free",
  ): void {
    const insertAssignment = this.db.prepare(
      "INSERT OR IGNORE INTO label_assignments (unit_id, name, kind) VALUES (?, ?, ?)",
    );
    const insertEvidence = this.db.prepare(
      "INSERT OR IGNORE INTO label_evidence (unit_id, name, kind, tweet_id, quote) VALUES (?, ?, ?, ?, ?)",
    );
    for (const assignment of assignments) {
      insertAssignment.run(unitId, assignment.name, kind);
      for (const evidence of assignment.evidence) {
        insertEvidence.run(unitId, assignment.name, kind, evidence.tweet_id, evidence.quote);
      }
    }
  }

  private settleQueueForRow(row: EnrichmentRow): void {
    if (!this.matchesCurrentUnit(row)) return;
    this.settleDone(row.unit_id, row.input_hash, this.latestActivityAt(row.unit_id));
  }

  /** A row may project labels only when it exactly matches current membership. */
  private matchesCurrentUnit(row: EnrichmentRow): boolean {
    if (!isCurrentEnrichmentRow(row)) return false;
    if (row.taxonomy_version !== this.taxonomyVersion || row.contract_hash !== this.contractHash) {
      return false;
    }
    const members = this.unitMemberIds(row.unit_id);
    const covered = new Set(row.tweet_ids);
    if (covered.size !== members.length || !members.every((id) => covered.has(id))) return false;
    if (row.input_hash !== computeInputHash(row.unit_id, this.semanticMembersFor(row.unit_id))) {
      return false;
    }
    const texts = this.unitTweetTexts(row.unit_id);
    return [...row.preset_labels, ...row.free_labels].every(
      (assignment) => validateEvidenceQuotes(assignment, texts).ok,
    );
  }

  replayAttemptEvent(event: AttemptEvent): void {
    if (!this.isReplayable(event)) return;
    const nowIso = this.now().toISOString();
    const nextStatus: QueueStatus = event.outcome === "blocked" ? "blocked" : "retrying";
    const firstQueuedAt = nullable(event.first_queued_at);
    this.db
      .prepare(
        `UPDATE enrich_queue SET
           attempts = ?,
           status = CASE WHEN ? >= ? THEN 'blocked' ELSE ? END,
           last_error = ?,
           last_error_class = ?,
           first_queued_at = CASE
             WHEN ? IS NOT NULL AND ? < first_queued_at THEN ?
             ELSE first_queued_at
           END,
           next_retry_at = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = ?
         WHERE unit_id = ?`,
      )
      .run(
        event.attempt,
        event.attempt,
        MAX_ATTEMPTS,
        nextStatus,
        nullable(event.error_message),
        nullable(event.error_class),
        firstQueuedAt,
        firstQueuedAt,
        firstQueuedAt,
        nullable(event.next_retry_at),
        nowIso,
        event.unit_id,
      );
  }

  private isReplayable(event: AttemptEvent): boolean {
    if (event.contract_hash !== this.contractHash) return false;
    if (event.outcome === "success") return false;
    const existing = this.rawQueueEntry(event.unit_id);
    if (existing === undefined) return false;
    if (existing.status === "done") return false;
    if (existing.input_hash !== event.input_hash) return false;
    if (event.attempt <= existing.attempts) return false;
    return true;
  }

  /**
   * Upsert a free-label registry row from a durable event. Non-`worker`
   * actors and any successful re-open bump the registry revision so that
   * consumer reads know an approved-set change has occurred.
   */
  applyRegistryEvent(event: FreeLabelEvent): boolean {
    // A lifecycle event belongs to exactly one classifier contract. This
    // prevents pre-migration events from reopening or changing the active
    // registry, and makes replay a strict monotonic log rather than a last
    // writer wins projection.
    if (event.contract_hash !== this.contractHash) return false;
    if (event.registry_revision !== this.registryRevision() + 1) return false;
    const existing = this.registryEntry(event.name);
    if (!isLegalRegistryTransition(existing?.status, event.status)) return false;
    this.db
      .prepare(
        `INSERT INTO free_label_registry (name, status, first_observed_at, updated_at, reason)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           status = excluded.status,
           updated_at = excluded.updated_at,
           reason = excluded.reason`,
      )
      .run(
        event.name,
        event.status,
        existing?.first_observed_at ?? event.at,
        event.at,
        event.reason ?? null,
      );
    this.db
      .prepare("UPDATE registry_revision SET revision = ? WHERE singleton = 1")
      .run(event.registry_revision);
    return true;
  }

  registryEntry(name: string): FreeLabelRegistryRow | undefined {
    return this.db
      .prepare(
        `SELECT name, status, first_observed_at, updated_at, reason
         FROM free_label_registry WHERE name = ?`,
      )
      .get(name) as FreeLabelRegistryRow | undefined;
  }

  registryStatus(name: string): FreeLabelStatus | undefined {
    const row = this.registryEntry(name);
    return row === undefined ? undefined : row.status;
  }

  /** All registry entries; useful for admin surfaces and negative-prompt retrieval. */
  registrySnapshot(): FreeLabelSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.name, r.status, r.first_observed_at, r.updated_at, r.reason,
                (SELECT COUNT(*) FROM label_assignments a
                  WHERE a.kind = 'free' AND a.name = r.name) AS unit_count
         FROM free_label_registry r ORDER BY r.name`,
      )
      .all() as (FreeLabelRegistryRow & { unit_count: number })[];
    return rows.map((row) => ({
      name: row.name,
      status: row.status,
      first_observed_at: row.first_observed_at,
      updated_at: row.updated_at,
      unit_count: row.unit_count,
      ...(row.reason === null ? {} : { reason: row.reason }),
    }));
  }

  rejectedNames(): Set<string> {
    const rows = this.db
      .prepare("SELECT name FROM free_label_registry WHERE status = 'rejected'")
      .all() as { name: string }[];
    return new Set(rows.map((row) => row.name));
  }

  approvedNames(): Set<string> {
    const rows = this.db
      .prepare("SELECT name FROM free_label_registry WHERE status = 'approved'")
      .all() as { name: string }[];
    return new Set(rows.map((row) => row.name));
  }

  candidateDetail(name: string): FreeLabelCandidateDetail | undefined {
    const row = this.registryEntry(name);
    if (row === undefined) return undefined;
    const counts = this.db
      .prepare(
        `SELECT COUNT(DISTINCT a.unit_id) AS units,
                COUNT(DISTINCT json_extract(tw.json, '$.author.id')) AS authors,
                COUNT(DISTINCT substr(tw.captured_at, 1, 10)) AS days
         FROM label_assignments a
         JOIN unit_members um ON um.unit_id = a.unit_id
         JOIN tweets tw ON tw.id = um.tweet_id
         WHERE a.kind = 'free' AND a.name = ?`,
      )
      .get(name) as { units: number; authors: number; days: number };
    const quotes = this.db
      .prepare(
        `SELECT unit_id, tweet_id, quote FROM label_evidence
         WHERE kind = 'free' AND name = ? LIMIT 5`,
      )
      .all(name) as { unit_id: string; tweet_id: string; quote: string }[];
    return {
      name: row.name,
      status: row.status,
      first_observed_at: row.first_observed_at,
      updated_at: row.updated_at,
      unit_count: counts.units,
      distinct_authors: counts.authors,
      distinct_days: counts.days,
      representative_quotes: quotes,
      ...(row.reason === null ? {} : { reason: row.reason }),
    };
  }

  /** Build, but do not apply, a durable candidate event for a new name. */
  candidateEventIfNew(name: string): { created: boolean; event: FreeLabelEvent | undefined } {
    const existing = this.registryEntry(name);
    if (existing !== undefined) return { created: false, event: undefined };
    const nowIso = this.now().toISOString();
    const event: FreeLabelEvent = {
      name,
      status: "candidate",
      at: nowIso,
      contract_hash: this.contractHash,
      registry_revision: this.registryRevision() + 1,
      reason: "first_observed",
      quotes: [],
      actor: "worker",
    };
    return { created: true, event };
  }

  /** Apply a candidate event immediately for explicit local administrative actions. */
  recordCandidateIfNew(name: string): { created: boolean; event: FreeLabelEvent | undefined } {
    const result = this.candidateEventIfNew(name);
    if (result.event !== undefined) this.applyRegistryEvent(result.event);
    return result;
  }

  /** Return durable assignments for a candidate, bounded for a review call. */
  candidateAssignments(name: string): LabelAssignment[] {
    const rows = this.db
      .prepare(
        `SELECT a.unit_id, e.tweet_id, e.quote FROM label_assignments a
         JOIN label_evidence e ON e.unit_id = a.unit_id AND e.name = a.name AND e.kind = a.kind
         WHERE a.kind = 'free' AND a.name = ? ORDER BY a.unit_id, e.tweet_id, e.quote LIMIT 20`,
      )
      .all(name) as { unit_id: string; tweet_id: string; quote: string }[];
    return rows.map((row) => ({ name, evidence: [{ tweet_id: row.tweet_id, quote: row.quote }] }));
  }

  candidateNames(): string[] {
    return (
      this.db
        .prepare("SELECT name FROM free_label_registry WHERE status = 'candidate' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
  }

  candidateAgeDays(name: string): number {
    const entry = this.registryEntry(name);
    if (entry === undefined) return 0;
    return Math.max(0, (this.now().getTime() - Date.parse(entry.first_observed_at)) / 86_400_000);
  }

  nameAppearsInEvidence(name: string): boolean {
    const rows = this.db
      .prepare("SELECT quote FROM label_evidence WHERE kind = 'free' AND name = ?")
      .all(name) as { quote: string }[];
    return rows.some((row) =>
      row.quote
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .includes(name),
    );
  }

  /** Deterministic worker-driven promotion; caller controls the reason field. */
  promoteName(name: string, reason: string): FreeLabelEvent | undefined {
    const existing = this.registryEntry(name);
    if (existing === undefined || existing.status === "approved") return undefined;
    const nowIso = this.now().toISOString();
    const event: FreeLabelEvent = {
      name,
      status: "approved",
      at: nowIso,
      contract_hash: this.contractHash,
      registry_revision: this.registryRevision() + 1,
      reason,
      quotes: [],
      actor: "worker",
    };
    this.applyRegistryEvent(event);
    return event;
  }

  promotionEvent(
    name: string,
    reason: string,
    quotes: readonly FreeLabelEvent["quotes"][number][],
  ): FreeLabelEvent | undefined {
    const existing = this.registryEntry(name);
    if (existing?.status !== "candidate") return undefined;
    return {
      name,
      status: "approved",
      at: this.now().toISOString(),
      contract_hash: this.contractHash,
      registry_revision: this.registryRevision() + 1,
      reason,
      quotes: [...quotes],
      actor: "worker",
    };
  }

  /** Deterministic worker-driven rejection; caller supplies the rule identifier. */
  rejectName(name: string, reason: string): FreeLabelEvent | undefined {
    const existing = this.registryEntry(name);
    const nowIso = this.now().toISOString();
    if (existing?.status === "rejected") return undefined;
    const event: FreeLabelEvent = {
      name,
      status: "rejected",
      at: nowIso,
      contract_hash: this.contractHash,
      registry_revision: this.registryRevision() + 1,
      reason,
      quotes: [],
      actor: "worker",
    };
    this.applyRegistryEvent(event);
    return event;
  }

  rejectionEvent(
    name: string,
    reason: string,
    quotes: readonly FreeLabelEvent["quotes"][number][],
  ): FreeLabelEvent | undefined {
    const existing = this.registryEntry(name);
    if (existing?.status !== "candidate") return undefined;
    return {
      name,
      status: "rejected",
      at: this.now().toISOString(),
      contract_hash: this.contractHash,
      registry_revision: this.registryRevision() + 1,
      reason,
      quotes: [...quotes],
      actor: "worker",
    };
  }

  /** Seed the registry from a durable rejection list (no explicit event yet). */
  seedRejectedNames(names: readonly string[]): void {
    const nowIso = this.now().toISOString();
    for (const name of names) {
      if (this.registryEntry(name)?.status === "rejected") continue;
      this.db
        .prepare(
          `INSERT INTO free_label_registry (name, status, first_observed_at, updated_at, reason)
           VALUES (?, 'rejected', ?, ?, 'seed:hard-rejected')
           ON CONFLICT (name) DO UPDATE SET
             status = 'rejected',
             updated_at = excluded.updated_at,
             reason = excluded.reason`,
        )
        .run(name, nowIso, nowIso);
    }
  }

  /**
   * Aggregate promotion-eligibility signals for a free-label name against
   * the current durable evidence.
   */
  promotionSignals(name: string): { units: number; authors: number; days: number } {
    const eligible = eligibleUnits({
      taxonomyVersion: this.taxonomyVersion,
      contractHash: this.contractHash,
    });
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT a.unit_id) AS units,
                COUNT(DISTINCT json_extract(tw.json, '$.author.id')) AS authors,
                COUNT(DISTINCT substr(tw.captured_at, 1, 10)) AS days
         FROM label_assignments a
         JOIN unit_members um ON um.unit_id = a.unit_id
         JOIN tweets tw ON tw.id = um.tweet_id
         WHERE a.kind = 'free' AND a.name = ?
           AND a.unit_id IN (${eligible.sql})`,
      )
      .get(name, ...eligible.params) as { units: number; authors: number; days: number };
    return { units: row.units, authors: row.authors, days: row.days };
  }

  labelsSummary(
    taxonomy: readonly LabelConfig[],
    selection: UnitSelection = {},
  ): Omit<LabelsSummary, "revision"> {
    const eligible = eligibleUnits({
      ...selection,
      taxonomyVersion: this.taxonomyVersion,
      contractHash: this.contractHash,
    });
    const presetRows = this.db
      .prepare(
        `SELECT a.name AS label, COUNT(DISTINCT a.unit_id) AS n
         FROM label_assignments a
         WHERE a.kind = 'preset' AND a.unit_id IN (${eligible.sql})
         GROUP BY a.name`,
      )
      .all(...eligible.params) as { label: string; n: number }[];
    const presetCounts = new Map(presetRows.map((row) => [row.label, row.n]));
    const freeLabels = this.db
      .prepare(
        `SELECT a.name AS name, COUNT(DISTINCT a.unit_id) AS count
         FROM label_assignments a
         JOIN free_label_registry r ON r.name = a.name AND r.status = 'approved'
         WHERE a.kind = 'free' AND a.unit_id IN (${eligible.sql})
         GROUP BY a.name ORDER BY count DESC, a.name LIMIT ?`,
      )
      .all(...eligible.params, FREE_LABEL_LIMIT) as FreeLabelCount[];
    return {
      taxonomy_version: this.taxonomyVersion,
      labels: taxonomy.map((label) => ({ ...label, count: presetCounts.get(label.name) ?? 0 })),
      free_labels: freeLabels,
      queue: this.queueDepth(selection),
      coverage: this.coverage(selection),
    };
  }

  private queueDepth(selection: UnitSelection): QueueDepth {
    const selected = selectedUnits(selection);
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM enrich_queue
                WHERE unit_id IN (${selected.sql}) GROUP BY status`,
      )
      .all(...selected.params) as { status: string; n: number }[];
    const byStatus = new Map(rows.map((row) => [row.status, row.n]));
    return {
      pending: byStatus.get("pending") ?? 0,
      running: byStatus.get("running") ?? 0,
      retrying: byStatus.get("retrying") ?? 0,
      blocked: byStatus.get("blocked") ?? 0,
      done: byStatus.get("done") ?? 0,
    };
  }

  private coverage(selection: UnitSelection): { units_total: number; units_enriched: number } {
    const selected = selectedUnits(selection);
    const total = this.db
      .prepare(
        `SELECT COUNT(DISTINCT unit_id) AS n FROM unit_members
                WHERE unit_id IN (${selected.sql})`,
      )
      .get(...selected.params) as { n: number };
    const enriched = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM enrichment e
         JOIN enrich_queue q ON q.unit_id = e.unit_id
           AND q.taxonomy_version = e.taxonomy_version AND q.status = 'done'
         WHERE e.taxonomy_version = ? AND e.contract_hash = ?
           AND e.unit_id IN (${selected.sql})`,
      )
      .get(this.taxonomyVersion, this.contractHash, ...selected.params) as { n: number };
    return { units_total: total.n, units_enriched: enriched.n };
  }

  /** Approved free-label vocabulary with counts, most-used first. */
  approvedFreeLabels(options: UnitSelection = {}): FreeLabelCount[] {
    const eligible = eligibleUnits({
      ...options,
      taxonomyVersion: this.taxonomyVersion,
      contractHash: this.contractHash,
    });
    const rows = this.db
      .prepare(
        `SELECT a.name AS name, COUNT(DISTINCT a.unit_id) AS count
         FROM label_assignments a
         JOIN free_label_registry r ON r.name = a.name AND r.status = 'approved'
         WHERE a.kind = 'free' AND a.unit_id IN (${eligible.sql})
         GROUP BY a.name ORDER BY count DESC, a.name`,
      )
      .all(...eligible.params) as FreeLabelCount[];
    return rows;
  }

  /** Detail for one approved free label, including related approved labels. */
  freeLabelDetail(
    name: string,
    options: UnitSelection = {},
  ): Omit<FreeLabelDetail, "revision"> | undefined {
    const status = this.registryStatus(name);
    if (status !== "approved") return undefined;
    const eligible = eligibleUnits({
      ...options,
      taxonomyVersion: this.taxonomyVersion,
      contractHash: this.contractHash,
    });
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT a.unit_id) AS unit_count
         FROM label_assignments a WHERE a.kind = 'free' AND a.name = ?
           AND a.unit_id IN (${eligible.sql})`,
      )
      .get(name, ...eligible.params) as { unit_count: number };
    const tweetCount = this.db
      .prepare(
        `SELECT COUNT(DISTINCT um.tweet_id) AS n FROM label_assignments a
         JOIN unit_members um ON um.unit_id = a.unit_id
         WHERE a.kind = 'free' AND a.name = ? AND a.unit_id IN (${eligible.sql})`,
      )
      .get(name, ...eligible.params) as { n: number };
    const related = this.db
      .prepare(
        `SELECT b.name AS name, COUNT(DISTINCT a.unit_id) AS shared_units
         FROM label_assignments a
         JOIN label_assignments b ON b.unit_id = a.unit_id AND b.name != a.name AND b.kind = 'free'
         JOIN free_label_registry rb ON rb.name = b.name AND rb.status = 'approved'
         WHERE a.kind = 'free' AND a.name = ?
           AND a.unit_id IN (${eligible.sql})
         GROUP BY b.name ORDER BY shared_units DESC, b.name LIMIT ?`,
      )
      .all(name, ...eligible.params, RELATED_LIMIT) as RelatedFreeLabel[];
    return { name, unit_count: row.unit_count, tweet_count: tweetCount.n, related };
  }

  graph(options: UnitSelection & { top: number }): { nodes: GraphNode[]; links: GraphLink[] } {
    const eligible = eligibleUnits({
      ...options,
      taxonomyVersion: this.taxonomyVersion,
      contractHash: this.contractHash,
    });
    const nodes = this.db
      .prepare(
        `SELECT a.name AS name, COUNT(DISTINCT a.unit_id) AS unit_count
         FROM label_assignments a
         JOIN free_label_registry r ON r.name = a.name AND r.status = 'approved'
         WHERE a.kind = 'free' AND a.unit_id IN (${eligible.sql})
         GROUP BY a.name ORDER BY unit_count DESC, a.name LIMIT ?`,
      )
      .all(...eligible.params, options.top) as GraphNode[];
    if (nodes.length === 0) return { nodes: [], links: [] };
    const names = nodes.map((node) => node.name);
    const placeholders = names.map(() => "?").join(",");
    const links = this.db
      .prepare(
        `SELECT a.name AS source, b.name AS target, COUNT(DISTINCT a.unit_id) AS weight
         FROM label_assignments a
         JOIN label_assignments b ON b.unit_id = a.unit_id AND a.name < b.name AND b.kind = 'free'
         WHERE a.kind = 'free' AND a.unit_id IN (${eligible.sql})
           AND a.name IN (${placeholders}) AND b.name IN (${placeholders})
         GROUP BY a.name, b.name ORDER BY weight DESC, source, target LIMIT ?`,
      )
      .all(...eligible.params, ...names, ...names, options.top * 4) as GraphLink[];
    return { nodes, links };
  }

  statusCounts(options: UnitSelection = {}): {
    totals: {
      total: number;
      pending: number;
      running: number;
      retrying: number;
      blocked: number;
      completed: number;
    };
    oldestPendingAt: string | undefined;
    newestCompletedAt: string | undefined;
    completeThrough: string | undefined;
  } {
    const selectedSql = selectedUnits(options);
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n,
                MIN(first_queued_at) AS min_queued,
                MAX(latest_activity_at) AS max_activity
         FROM enrich_queue q
         WHERE unit_id IN (${selectedSql.sql})
         GROUP BY status`,
      )
      .all(...selectedSql.params) as {
      status: string;
      n: number;
      min_queued: string | null;
      max_activity: string | null;
    }[];
    const summary = aggregateStatusRows(rows);
    return {
      totals: summary.totals,
      oldestPendingAt: summary.oldestPendingAt,
      newestCompletedAt: summary.newestCompletedAt,
      completeThrough: this.completeThrough(options),
    };
  }

  private completeThrough(options: UnitSelection): string | undefined {
    const selectedSql = selectedUnits(options);
    const nonDone = this.db
      .prepare(
        `SELECT MIN(latest_activity_at) AS threshold FROM enrich_queue q
         WHERE unit_id IN (${selectedSql.sql}) AND status != 'done'`,
      )
      .get(...selectedSql.params) as { threshold: string | null };
    if (nonDone.threshold === null) {
      const doneMax = this.db
        .prepare(
          `SELECT MAX(latest_activity_at) AS m FROM enrich_queue q
           WHERE unit_id IN (${selectedSql.sql}) AND status = 'done'`,
        )
        .get(...selectedSql.params) as { m: string | null };
      return doneMax.m ?? undefined;
    }
    const row = this.db
      .prepare(
        `SELECT MAX(latest_activity_at) AS m FROM enrich_queue q
         WHERE unit_id IN (${selectedSql.sql}) AND status = 'done'
           AND latest_activity_at < ?`,
      )
      .get(...selectedSql.params, nonDone.threshold) as { m: string | null };
    return row.m ?? undefined;
  }

  recentErrorClasses(): { error_class: ErrorClass; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT error_class, COUNT(*) AS n FROM (
           SELECT error_class FROM recent_errors ORDER BY seq DESC LIMIT ?
         ) GROUP BY error_class ORDER BY n DESC`,
      )
      .all(RECENT_ERROR_WINDOW) as { error_class: string; n: number }[];
    return rows.map((row) => ({ error_class: row.error_class as ErrorClass, count: row.n }));
  }

  /**
   * Return the evidence-bearing assignments for a set of unit IDs, filtered
   * to public rules: preset labels are always visible; only approved free
   * labels appear.
   */
  visibleAssignments(
    unitIds: readonly string[],
  ): Map<string, { preset_labels: LabelAssignment[]; free_labels: LabelAssignment[] }> {
    return readVisibleAssignments(this.db, unitIds);
  }

  private upsertEnrichmentRow(row: EnrichmentRow): void {
    this.db
      .prepare(
        `INSERT INTO enrichment
           (unit_id, taxonomy_version, tweet_ids, input_hash, contract_hash, model, enriched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (unit_id) DO UPDATE SET
           taxonomy_version = excluded.taxonomy_version,
           tweet_ids = excluded.tweet_ids,
           input_hash = excluded.input_hash,
           contract_hash = excluded.contract_hash,
           model = excluded.model,
           enriched_at = excluded.enriched_at`,
      )
      .run(
        row.unit_id,
        row.taxonomy_version,
        JSON.stringify(row.tweet_ids),
        row.input_hash,
        row.contract_hash,
        row.model,
        row.enriched_at,
      );
  }
}

function nullable<T>(value: T | undefined): T | null {
  return value ?? null;
}

type UnitSelection = {
  authorIds?: readonly string[] | undefined;
  labels?: readonly string[] | undefined;
  labelMode?: "any" | "all" | undefined;
  publication?: "public-original" | undefined;
  cutoff?: string | undefined;
};

type EligibleUnitOptions = UnitSelection & {
  taxonomyVersion: number;
  contractHash: string;
};

function eligibleUnits(options: EligibleUnitOptions): { sql: string; params: unknown[] } {
  const labels = options.labels ?? [];
  const labelPlaceholders = labels.map(() => "?").join(",");
  const finalizedJoins = `JOIN enrichment e ON e.unit_id = um.unit_id AND e.taxonomy_version = ? AND e.contract_hash = ?
            JOIN enrich_queue q ON q.unit_id = um.unit_id
              AND q.taxonomy_version = ? AND q.status = 'done'`;
  const selection = `${cutoffWhere(options.cutoff)}${publicationWhere(
    options.publication,
    "um.unit_id",
  )}${authorWhere(options.authorIds, "um.unit_id")}`;
  const cutoffParams = options.cutoff !== undefined ? [options.cutoff] : [];
  const authorParams = options.authorIds ?? [];
  if (labels.length === 0) {
    return {
      sql: `SELECT DISTINCT um.unit_id FROM unit_members um
            ${finalizedJoins}
            WHERE 1 = 1${selection}`,
      params: [
        options.taxonomyVersion,
        options.contractHash,
        options.taxonomyVersion,
        ...cutoffParams,
        ...authorParams,
      ],
    };
  }
  if (options.labelMode !== "all") {
    return {
      sql: `SELECT DISTINCT um.unit_id FROM unit_members um
            ${finalizedJoins}
            JOIN label_assignments la ON la.unit_id = um.unit_id AND la.kind = 'preset'
            WHERE la.name IN (${labelPlaceholders})${selection}`,
      params: [
        options.taxonomyVersion,
        options.contractHash,
        options.taxonomyVersion,
        ...labels,
        ...cutoffParams,
        ...authorParams,
      ],
    };
  }
  return {
    sql: `SELECT um.unit_id FROM unit_members um
          ${finalizedJoins}
          JOIN label_assignments la ON la.unit_id = um.unit_id AND la.kind = 'preset'
          WHERE la.name IN (${labelPlaceholders})${selection}
          GROUP BY um.unit_id HAVING COUNT(DISTINCT la.name) = ?`,
    params: [
      options.taxonomyVersion,
      options.contractHash,
      options.taxonomyVersion,
      ...labels,
      ...cutoffParams,
      ...authorParams,
      labels.length,
    ],
  };
}

function selectedUnits(options: UnitSelection): { sql: string; params: unknown[] } {
  const cutoffSql = cutoffWhere(options.cutoff);
  const authorSql = authorWhere(options.authorIds, "um.unit_id");
  const publicationSql = publicationWhere(options.publication, "um.unit_id");
  const cutoffParams = options.cutoff === undefined ? [] : [options.cutoff];
  const authorParams = options.authorIds ?? [];
  return {
    sql: `SELECT DISTINCT um.unit_id FROM unit_members um
          WHERE 1 = 1${cutoffSql}${publicationSql}${authorSql}`,
    params: [...cutoffParams, ...authorParams],
  };
}

function cutoffWhere(cutoff: string | undefined): string {
  if (cutoff === undefined) return "";
  return " AND (SELECT MAX(t.captured_at) FROM tweets t JOIN unit_members u ON u.tweet_id = t.id WHERE u.unit_id = um.unit_id) <= ?";
}

function authorWhere(authorIds: readonly string[] | undefined, unitIdSql: string): string {
  if (authorIds === undefined || authorIds.length === 0) return "";
  const placeholders = authorIds.map(() => "?").join(",");
  return ` AND NOT EXISTS (
             SELECT 1 FROM unit_members author_um
             JOIN tweets author_tweet ON author_tweet.id = author_um.tweet_id
             WHERE author_um.unit_id = ${unitIdSql}
               AND (
                 json_extract(author_tweet.json, '$.author.id') IS NULL
                 OR json_extract(author_tweet.json, '$.author.id') NOT IN (${placeholders})
               )
           )`;
}

function publicationWhere(publication: UnitSelection["publication"], unitIdSql: string): string {
  if (publication !== "public-original") return "";
  return ` AND NOT EXISTS (
             SELECT 1 FROM unit_members private_um
             JOIN tweets private_tweet ON private_tweet.id = private_um.tweet_id
             WHERE private_um.unit_id = ${unitIdSql}
               AND json_extract(private_tweet.json, '$.is_subscriber_only') = 1
           )
           AND EXISTS (
             SELECT 1 FROM unit_members original_um
             JOIN tweets original_tweet ON original_tweet.id = original_um.tweet_id
             WHERE original_um.unit_id = ${unitIdSql}
               AND COALESCE(json_extract(original_tweet.json, '$.is_retweet'), 0) != 1
           )`;
}

type StatusRow = {
  status: string;
  n: number;
  min_queued: string | null;
  max_activity: string | null;
};

function applyStatusRow(
  row: StatusRow,
  totals: {
    pending: number;
    running: number;
    retrying: number;
    blocked: number;
    completed: number;
  },
): { oldestPendingAt: string | undefined; newestCompletedAt: string | undefined } {
  const result = {
    oldestPendingAt: undefined as string | undefined,
    newestCompletedAt: undefined as string | undefined,
  };
  if (row.status === "pending") {
    totals.pending = row.n;
    result.oldestPendingAt = row.min_queued ?? undefined;
  } else if (row.status === "done") {
    totals.completed = row.n;
    result.newestCompletedAt = row.max_activity ?? undefined;
  } else if (row.status === "running" || row.status === "retrying" || row.status === "blocked") {
    totals[row.status] = row.n;
  }
  return result;
}

function aggregateStatusRows(rows: readonly StatusRow[]): {
  totals: {
    total: number;
    pending: number;
    running: number;
    retrying: number;
    blocked: number;
    completed: number;
  };
  oldestPendingAt: string | undefined;
  newestCompletedAt: string | undefined;
} {
  const totals = { total: 0, pending: 0, running: 0, retrying: 0, blocked: 0, completed: 0 };
  let oldestPendingAt: string | undefined;
  let newestCompletedAt: string | undefined;
  for (const row of rows) {
    totals.total += row.n;
    const applied = applyStatusRow(row, totals);
    if (applied.oldestPendingAt !== undefined) oldestPendingAt = applied.oldestPendingAt;
    if (applied.newestCompletedAt !== undefined) newestCompletedAt = applied.newestCompletedAt;
  }
  return { totals, oldestPendingAt, newestCompletedAt };
}
