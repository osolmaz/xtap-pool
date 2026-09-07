import type Database from "better-sqlite3";
import { selectedObservationThrough } from "./consumer-coverage.js";
import { ConsumerIndexState } from "./consumer-index-state.js";
import { ConsumerChangeEngine, historicalSelection } from "./consumer-changes.js";
import { ConsumerObservationReader } from "./consumer-observations.js";
import { selectedCompleteThrough } from "./enrich-store.js";
import { assertConsumerPrivacy } from "./consumer-privacy.js";
import type { ConsumerWorkerTask, ConsumerWorkerResult } from "./consumer-worker-task.js";
import { ConsumerHttpError } from "./consumer-errors.js";

export function readConsumerTask(
  database: Database.Database,
  task: ConsumerWorkerTask,
): ConsumerWorkerResult {
  return database.transaction((): ConsumerWorkerResult => {
    new ConsumerIndexState(database, task.contract, "read").require(task.source);
    assertTargetMembership(database, task);
    const selection = historicalSelection(task.target);
    if (task.operation === "coverage") {
      return {
        kind: "coverage",
        completeThrough: selectedCompleteThrough(database, selection) ?? null,
        observationsThrough: selectedObservationThrough(database, task.target),
      };
    }
    assertConsumerPrivacy(database, task.target);
    if (task.operation === "privacy") return { kind: "privacy" };
    if (task.cursor.position.kind === "history") {
      const position = task.cursor.position;
      const page = new ConsumerObservationReader(
        database,
        task.target.context.taxonomy.version,
        task.contract,
      ).history({
        postIds: position.post_ids,
        since: position.since,
        until: position.until,
        ...(position.after === undefined ? {} : { after: position.after }),
        limit: task.limit,
        boundary: {
          segments: task.target.snapshot.files.map((f) => f.key),
          registry: task.target.context.registry,
        },
        selection,
      });
      return { kind: "history", page };
    }
    return {
      kind: "changes",
      step: new ConsumerChangeEngine(database, task.target, task.base).step(
        task.cursor,
        task.limit,
      ),
    };
  })();
}
function assertTargetMembership(database: Database.Database, task: ConsumerWorkerTask): void {
  for (const context of [task.target, task.base]) {
    if (context === undefined) continue;
    const mismatch = database
      .prepare(
        `SELECT 1 FROM json_each(?) f LEFT JOIN source_segments s ON s.key = json_extract(f.value, '$.key')
      WHERE s.key IS NULL OR s.oid <> json_extract(f.value, '$.oid')
        OR s.listed_oid IS NOT json_extract(f.value, '$.listed_oid') OR s.content_sha256 <> json_extract(f.value, '$.content_sha256') OR s.byte_length <> json_extract(f.value, '$.size') LIMIT 1`,
      )
      .get(JSON.stringify(context.snapshot.files));
    if (mismatch !== undefined)
      throw new ConsumerHttpError(
        503,
        "source_not_ready",
        "The current database does not contain the pinned source.",
      );
  }
}
