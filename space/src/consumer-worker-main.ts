import { statSync } from "node:fs";
import Database from "better-sqlite3";
import { consumerWorkerTaskSchema } from "./consumer-worker-task.js";
import { readConsumerTask } from "./consumer-worker-read.js";
import { consumerError, ConsumerHttpError } from "./consumer-errors.js";

let database: Database.Database | undefined;
let opened: string | undefined;
process.on("message", (message: unknown) => {
  try {
    const task = consumerWorkerTaskSchema.parse(message);
    const stat = statSync(task.path);
    const identity = `${String(stat.dev)}:${String(stat.ino)}`;
    if (identity !== task.identity)
      throw new ConsumerHttpError(
        503,
        "database_replaced",
        "The database changed before the read. Retry the same cursor.",
      );
    const reader = openDatabase(task.path, identity);
    const result = readConsumerTask(reader, task);
    const after = statSync(task.path);
    if (`${String(after.dev)}:${String(after.ino)}` !== identity)
      throw new ConsumerHttpError(
        503,
        "database_replaced",
        "The database changed during the read. Retry the same cursor.",
      );
    process.send?.({ ok: true, result });
  } catch (error) {
    const failure = consumerError(error);
    process.send?.({
      ok: false,
      status: failure.status,
      code: failure.code,
      message: failure.message,
      recovery: failure.recovery,
    });
  }
});
process.on("disconnect", () => {
  database?.close();
  process.exit(0);
});

function openDatabase(path: string, identity: string): Database.Database {
  if (opened !== identity) {
    database?.close();
    database = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
    database.pragma("query_only = ON");
    opened = identity;
  }
  if (database === undefined) throw new Error("consumer database was not opened");
  return database;
}
