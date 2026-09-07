import type Database from "better-sqlite3";
import { vi } from "vitest";
import { z } from "zod";

/** Count result rows entering the window, not only rows returned after its limit. */
export function consumerResultBodyReads(database: Database.Database): () => number {
  let reads = 0;
  database.function("result_body_probe", (value: unknown) => {
    reads++;
    return z.string().parse(value);
  });
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation((sql: string) =>
    prepare(
      sql.includes("WITH requested AS MATERIALIZED")
        ? sql.replace("r.payload_json,", "result_body_probe(r.payload_json) AS payload_json,")
        : sql,
    ),
  );
  return () => reads;
}

/** Inspect the executed statement with its real bindings. This catches planner
 * regressions without a host-dependent elapsed-time assertion. */
export function consumerQueryPlan(database: Database.Database, match: RegExp): string[] {
  const prepare = database.prepare.bind(database);
  const details: string[] = [];
  vi.spyOn(database, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (!match.test(sql)) return statement;
    const measure =
      <T>(call: (...parameters: unknown[]) => T) =>
      (...parameters: unknown[]) => {
        details.push(
          ...z
            .array(z.object({ detail: z.string() }))
            .parse(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters))
            .map((row) => row.detail),
        );
        return call(...parameters);
      };
    statement.get = measure(statement.get.bind(statement));
    statement.all = measure(statement.all.bind(statement));
    statement.iterate = measure(statement.iterate.bind(statement));
    return statement;
  });
  return details;
}
