import type Database from "better-sqlite3";
import { z } from "zod";
import { ConsumerBootstrapRequired } from "./consumer-index-state.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const rowSchema = z.object({ source: hash });

/** A partial replay is useful saved work, but never a publishable source index.
 * Keep this marker in SQLite so copying a checkpoint cannot discard the gate. */
export class IndexBootstrapState {
  constructor(private readonly database: Database.Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS index_bootstrap (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      source TEXT NOT NULL CHECK(length(source) = 64)
    ) STRICT`);
  }
  begin(source: string): void {
    hash.parse(source);
    const previous = this.source();
    if (previous !== undefined && previous !== source)
      throw new Error("bootstrap target changed in its saved database");
    this.database.prepare("INSERT OR IGNORE INTO index_bootstrap VALUES (1, ?)").run(source);
  }
  finish(source: string, applied: string): void {
    if (this.source() !== source || applied !== source)
      throw new Error("index bootstrap is incomplete; finish its exact frozen source");
    this.database.prepare("DELETE FROM index_bootstrap").run();
  }
  requireComplete(): void {
    if (this.source() !== undefined)
      throw new ConsumerBootstrapRequired(
        "index bootstrap is incomplete; finish preparation before serving or publishing",
      );
  }
  private source(): string | undefined {
    const value = this.database
      .prepare("SELECT source FROM index_bootstrap WHERE singleton = 1")
      .get();
    return value === undefined ? undefined : rowSchema.parse(value).source;
  }
}
