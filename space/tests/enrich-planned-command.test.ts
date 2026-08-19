import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { AttemptEvent, FreeLabelEvent } from "@xtap-pool/shared";

import {
  applyCheckpointToWorkerDatabase,
  applyDurableOutput,
  outputsFromSegment,
  parseSourceSegments,
  registryOutputOrdinals,
  runIsComplete,
} from "../src/enrich-planned-command.js";
import {
  createEmptyEnrichmentState,
  recordQueueAttempt,
  validateEnrichmentState,
} from "../src/enrich-state.js";

const SHA = "a".repeat(64);
const SEGMENT = `v1/segments/attempt/2026/08/19/1787140800000-11111111-1111-4111-8111-111111111111-${"b".repeat(64)}.json.gz`;

function state() {
  return createEmptyEnrichmentState({
    runId: "run",
    planSha256: SHA,
    queueTotal: 3,
    queueBaselineDone: 1,
    registryTotal: 2,
    registryBaselineScanned: 0,
  });
}

function attempt(outcome: AttemptEvent["outcome"]): AttemptEvent {
  return {
    unit_id: "u2",
    input_hash: "input",
    contract_hash: SHA,
    attempt: 2,
    outcome,
    error_class: outcome === "blocked" ? "invalid_output" : "timeout",
    at: "2026-08-19T12:00:00.000Z",
    first_queued_at: "2026-08-19T10:00:00.000Z",
    next_retry_at: "2026-08-19T12:01:00.000Z",
  };
}

function decision(status: "candidate" | "approved" | "rejected"): FreeLabelEvent {
  return {
    name: "candidate",
    status,
    at: "2026-08-19T12:00:00.000Z",
    contract_hash: SHA,
    registry_revision: 2,
    quotes: [],
    actor: "worker",
  };
}

describe("planned enrichment recovery", () => {
  it("applies completed, retrying, and blocked checkpoint state to the worker database", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE worker_queue_plan (ordinal INTEGER PRIMARY KEY, unit_id TEXT UNIQUE);
      CREATE TABLE enrich_queue (unit_id TEXT PRIMARY KEY, status TEXT, attempts INTEGER,
        last_error_class TEXT, next_retry_at TEXT, lease_owner TEXT, lease_expires_at TEXT);
      INSERT INTO worker_queue_plan VALUES (0, 'u1'), (1, 'u2'), (2, 'u3');
      INSERT INTO enrich_queue VALUES
        ('u1', 'pending', 0, NULL, NULL, NULL, NULL),
        ('u2', 'pending', 0, NULL, NULL, NULL, NULL),
        ('u3', 'pending', 0, NULL, NULL, NULL, NULL);
    `);
    let checkpoint = recordQueueAttempt(state(), {
      status: "retrying",
      value: {
        ordinal: 1,
        attempts: 2,
        error_class: "timeout",
        next_retry_at: "2026-08-19T12:01:00.000Z",
      },
    });
    checkpoint = recordQueueAttempt(checkpoint, {
      status: "blocked",
      value: {
        ordinal: 2,
        attempts: 5,
        reason: "invalid_output",
        evidence_sha256: SHA,
      },
    });

    applyCheckpointToWorkerDatabase(db, checkpoint);

    expect(
      db.prepare("SELECT unit_id, status, attempts FROM enrich_queue ORDER BY unit_id").all(),
    ).toEqual([
      { unit_id: "u1", status: "done", attempts: 0 },
      { unit_id: "u2", status: "retrying", attempts: 2 },
      { unit_id: "u3", status: "blocked", attempts: 5 },
    ]);
    db.close();
  });

  it("maps registry results through a nonzero frozen baseline", () => {
    expect(
      registryOutputOrdinals(
        [decision("candidate"), { ...decision("approved"), name: "second" }],
        ["candidate", "second"],
        7,
        7,
      ),
    ).toEqual([7, 8]);
    expect(() => registryOutputOrdinals([decision("candidate")], ["other"], 7, 7)).toThrow(
      "frozen ordinal",
    );
  });

  it("updates queue, attempt, registry, and receipt frontiers", () => {
    expect(runIsComplete(state())).toBe(false);
    const ordinals = new Map([
      ["u1", 0],
      ["u2", 1],
      ["u3", 2],
    ]);
    let checkpoint = applyDurableOutput(
      state(),
      { kind: "queue", segmentKey: SEGMENT, successfulUnitIds: ["u2"] },
      ordinals,
      "1".repeat(64),
    );
    checkpoint = applyDurableOutput(
      checkpoint,
      {
        kind: "attempt",
        segmentKey: SEGMENT,
        event: { ...attempt("transient_failure"), unit_id: "u3" },
      },
      ordinals,
      "2".repeat(64),
    );
    checkpoint = applyDurableOutput(
      checkpoint,
      {
        kind: "attempt",
        segmentKey: SEGMENT,
        event: { ...attempt("blocked"), unit_id: "u3" },
      },
      ordinals,
      "5".repeat(64),
    );
    checkpoint = applyDurableOutput(
      checkpoint,
      {
        kind: "registry",
        segmentKey: SEGMENT,
        decisions: [decision("approved"), decision("candidate")],
      },
      ordinals,
      "3".repeat(64),
    );
    checkpoint = applyDurableOutput(
      checkpoint,
      { kind: "receipt", segmentKey: SEGMENT },
      ordinals,
      "4".repeat(64),
    );

    expect(checkpoint.queue.done).toBe(2);
    expect(checkpoint.queue.blocked).toHaveLength(1);
    expect(checkpoint.registry).toMatchObject({
      next_ordinal: 2,
      approved: 1,
      rejected: 0,
    });
    expect(checkpoint.outputs.receipt.sequence).toBe(1);
    expect(runIsComplete(checkpoint)).toBe(true);
  });

  it("rejects duplicate and overlapping unresolved queue ordinals", () => {
    const base = state();
    const retry = {
      ordinal: 1,
      attempts: 1,
      error_class: "timeout",
      next_retry_at: null,
    };
    expect(() =>
      validateEnrichmentState({
        ...base,
        queue: { ...base.queue, retrying: [retry, retry] },
      }),
    ).toThrow("retry ordinals must be unique");
    expect(() =>
      validateEnrichmentState({
        ...base,
        queue: {
          ...base.queue,
          retrying: [retry],
          blocked: [
            {
              ordinal: 1,
              attempts: 5,
              reason: "invalid_output",
              evidence_sha256: SHA,
            },
          ],
        },
      }),
    ).toThrow("unique and disjoint");
  });

  it("reconstructs retry and registry outputs from orphan raw segments", () => {
    const segment = {
      schema_version: 1 as const,
      transaction_id: "11111111-1111-4111-8111-111111111111",
      created_at: "2026-08-19T12:00:00.000Z",
      operations: [
        {
          mode: "append" as const,
          path: "enrichment/2026/08/enrichment-2026-08-19.jsonl",
          lines: [
            JSON.stringify({
              unit_id: "u1",
              tweet_ids: ["t1"],
              input_hash: "input",
              contract_hash: SHA,
              preset_labels: [],
              free_labels: [],
              model: "model",
              taxonomy_version: 1,
              enriched_at: "2026-08-19T12:00:00.000Z",
            }),
          ],
        },
        {
          mode: "append" as const,
          path: "enrichment/attempts/2026/08/attempts-2026-08-19.jsonl",
          lines: [
            JSON.stringify(attempt("transient_failure")),
            JSON.stringify({ ...attempt("success"), unit_id: "u1" }),
          ],
        },
        {
          mode: "append" as const,
          path: "enrichment/registry/2026/08/registry-2026-08-19.jsonl",
          lines: [
            JSON.stringify(decision("approved")),
            JSON.stringify({ ...decision("approved"), name: "outside", status: "candidate" }),
          ],
        },
        {
          mode: "append" as const,
          path: "enrichment/receipts/2026-08-19.jsonl",
          lines: [
            JSON.stringify({
              started_at: "2026-08-19T12:00:00.000Z",
              finished_at: "2026-08-19T12:01:00.000Z",
              units: 1,
              calls: 1,
              prompt_tokens: 1,
              completion_tokens: 1,
              failures: 0,
              retries: 0,
              blocked: 0,
              contract_hash: SHA,
              worker_id: "worker",
              discarded_assignments: 0,
              new_candidates: 0,
              new_approvals: 1,
              new_rejections: 0,
            }),
          ],
        },
      ],
    };
    const identities = new Map([
      ["u1", { inputHash: "input", taxonomyVersion: 1, contractHash: SHA }],
      ["u2", { inputHash: "input", taxonomyVersion: 1, contractHash: SHA }],
    ]);
    expect(outputsFromSegment(segment, ["candidate"], 0, identities, SHA)).toEqual([
      { kind: "queue", successfulUnitIds: ["u1"] },
      { kind: "attempt", event: attempt("transient_failure") },
      { kind: "registry", decisions: [decision("approved")] },
      { kind: "receipt" },
    ]);
    expect(() => outputsFromSegment(segment, ["candidate"], 2, identities, SHA)).toThrow(
      "cursor is outside",
    );
    const conflicting = structuredClone(segment);
    const enrichment = conflicting.operations[0];
    if (enrichment === undefined) throw new Error("enrichment operation is missing");
    enrichment.lines[0] = (enrichment.lines[0] ?? "").replace(
      '"input_hash":"input"',
      '"input_hash":"different"',
    );
    expect(() => outputsFromSegment(conflicting, ["candidate"], 0, identities, SHA)).toThrow(
      "frozen queue identity",
    );
  });

  it("rejects or ignores orphan records outside the frozen identity", () => {
    const identities = new Map([
      ["u2", { inputHash: "input", taxonomyVersion: 1, contractHash: SHA }],
    ]);
    expect(
      outputsFromSegment(
        orphanSegment("enrichment/attempts/2026/08/attempts-2026-08-19.jsonl", {
          ...attempt("transient_failure"),
          unit_id: "outside",
        }),
        [],
        0,
        identities,
        SHA,
      ),
    ).toEqual([]);
    expect(
      outputsFromSegment(
        orphanSegment("enrichment/attempts/2026/08/attempts-2026-08-19.jsonl", attempt("success")),
        [],
        0,
        identities,
        SHA,
      ),
    ).toEqual([]);
    expect(() =>
      outputsFromSegment(
        orphanSegment("enrichment/attempts/2026/08/attempts-2026-08-19.jsonl", {
          ...attempt("transient_failure"),
          contract_hash: "different",
        }),
        [],
        0,
        identities,
        SHA,
      ),
    ).toThrow("frozen queue identity");
    expect(
      outputsFromSegment(
        orphanSegment(
          "enrichment/registry/2026/08/registry-2026-08-19.jsonl",
          decision("candidate"),
        ),
        ["other"],
        0,
        identities,
        SHA,
      ),
    ).toEqual([]);
    expect(() =>
      outputsFromSegment(
        orphanSegment("enrichment/registry/2026/08/registry-2026-08-19.jsonl", {
          ...decision("candidate"),
          contract_hash: "different",
        }),
        ["candidate"],
        0,
        identities,
        SHA,
      ),
    ).toThrow("frozen contract");
    expect(
      outputsFromSegment(
        {
          schema_version: 1,
          transaction_id: "11111111-1111-4111-8111-111111111111",
          created_at: "2026-08-19T12:00:00.000Z",
          operations: [{ mode: "write", path: "config/taxonomy.json", content: "{}" }],
        },
        [],
        0,
        identities,
        SHA,
      ),
    ).toEqual([]);
    expect(
      outputsFromSegment(
        orphanSegment("enrichment/2026/08/enrichment-2026-08-19.jsonl", {}),
        [],
        0,
        identities,
        SHA,
      ),
    ).toEqual([]);
    expect(
      outputsFromSegment(
        orphanSegment("enrichment/2026/08/enrichment-2026-08-19.jsonl", {
          unit_id: "outside",
          tweet_ids: ["t1"],
          input_hash: "input",
          contract_hash: SHA,
          preset_labels: [],
          free_labels: [],
          model: "model",
          taxonomy_version: 1,
          enriched_at: "2026-08-19T12:00:00.000Z",
        }),
        [],
        0,
        identities,
        SHA,
      ),
    ).toEqual([]);
    expect(
      outputsFromSegment(
        orphanSegment("enrichment/receipts/2026-08-19.jsonl", {
          started_at: "2026-08-19T12:00:00.000Z",
          finished_at: "2026-08-19T12:01:00.000Z",
          units: 0,
          calls: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          failures: 0,
          retries: 0,
          blocked: 0,
          contract_hash: "different",
          worker_id: "worker",
          discarded_assignments: 0,
          new_candidates: 0,
          new_approvals: 0,
          new_rejections: 0,
        }),
        [],
        0,
        identities,
        SHA,
      ),
    ).toEqual([]);
  });

  it("validates ordered source-segment metadata", () => {
    const source = [
      {
        key: SEGMENT,
        oid: SHA,
        listed_oid: "listed",
        byte_length: 10,
        content_sha256: "b".repeat(64),
        tweet_rows: 0,
        enrichment_rows: 0,
        attempt_rows: 1,
        registry_rows: 0,
        receipt_rows: 0,
      },
    ];
    expect(parseSourceSegments(Buffer.from(`${JSON.stringify(source)}\n`))).toEqual([
      {
        key: SEGMENT,
        oid: SHA,
        listed_oid: "listed",
        size: 10,
        content_sha256: "b".repeat(64),
      },
    ]);
    expect(
      parseSourceSegments(Buffer.from(`${JSON.stringify([{ ...source[0], listed_oid: null }])}\n`)),
    ).toEqual([
      {
        key: SEGMENT,
        oid: SHA,
        size: 10,
        content_sha256: "b".repeat(64),
      },
    ]);
    expect(() => parseSourceSegments(Buffer.from("{}"))).toThrow();
  });
});

function orphanSegment(path: string, value: unknown) {
  return {
    schema_version: 1 as const,
    transaction_id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-08-19T12:00:00.000Z",
    operations: [{ mode: "append" as const, path, lines: [JSON.stringify(value)] }],
  };
}
