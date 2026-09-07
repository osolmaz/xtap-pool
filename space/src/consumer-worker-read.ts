import type Database from "better-sqlite3";
import { updateConsumerCoverage } from "./consumer-coverage-update.js";
import { ConsumerIndexState } from "./consumer-index-state.js";
import { ConsumerChangeEngine, historicalSelection } from "./consumer-changes.js";
import { ConsumerObservationReader } from "./consumer-observations.js";
import { ConsumerPrivacyEffects } from "./consumer-privacy.js";
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
    if (task.operation === "coverage")
      return updateConsumerCoverage(database, task.target, task.base);
    const privacy = privacyEffects(database, task);
    if (task.operation === "reconcile") return reconciliationPage(privacy, task);
    privacy.assertUnchanged();
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
      step: new ConsumerChangeEngine(database, task.target, task.base, task.privacy).step(
        task.cursor,
        task.limit,
      ),
    };
  })();
}
function assertTargetMembership(database: Database.Database, task: ConsumerWorkerTask): void {
  for (const context of [task.target, task.base, task.privacy, task.reconciliation]) {
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

function privacyEffects(
  database: Database.Database,
  task: ConsumerWorkerTask,
): ConsumerPrivacyEffects {
  const exposed = task.base === undefined ? [task.target] : [task.target, task.base];
  const baseline = task.privacy === undefined ? [task.target] : [task.target, task.privacy];
  return new ConsumerPrivacyEffects(database, baseline, exposed, task.reconciliation);
}
function reconciliationPage(
  privacy: ConsumerPrivacyEffects,
  task: ConsumerWorkerTask,
): ConsumerWorkerResult {
  if (task.reconciliation === undefined || task.cursor.reconciliation === undefined)
    throw new Error("missing reconciliation context");
  return { kind: "reconcile", page: privacy.page(task.limit, task.cursor.reconciliation.after) };
}
