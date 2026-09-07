import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { ConsumerWorkers } from "../src/consumer-workers.js";
import { ConsumerRuntime } from "../src/consumer-runtime.js";
import type { ConsumerFixture } from "./consumer-http-fixture.js";

const eventsSchema = z.array(
  z.object({
    operation: z.string(),
    mode: z.string().optional(),
    bodies: z.record(z.string(), z.number()),
    body_queries: z.number(),
  }),
);
/** Test-only SQL instrumentation in the real forked worker. The identity function
 * counts evaluated body-column expressions, including JSON privacy predicates. */
export function coverageProbe(f: ConsumerFixture) {
  const path = join(f.directory, "coverage-reads.json");
  const script = join(f.directory, "coverage-probe.mjs");
  const require = createRequire(import.meta.url);
  const main = fileURLToPath(new URL("../dist/src/consumer-worker-main.js", import.meta.url));
  writeFileSync(path, "[]");
  writeFileSync(
    script,
    `
    import Database from ${JSON.stringify(require.resolve("better-sqlite3"))};
    import { readFileSync, writeFileSync } from 'node:fs';
    const original = Database.prototype.prepare;
    const json = new Database(':memory:');
    const type = json.prepare('SELECT json_type(?, ?) AS value');
    const extract = json.prepare('SELECT json_extract(?, ?) AS value');
    const registered = new WeakSet();
    const events = JSON.parse(readFileSync(${JSON.stringify(path)}, "utf8"));
    let event;
    function measure(body) {
      if (typeof body !== 'string') return;
      let value;
      try { value = JSON.parse(body); } catch { return; }
      if (event && value && typeof value.text === 'string' && value.author)
        event.bodies[value.id] = (event.bodies[value.id] ?? 0) + 1;
    }
    process.on('message', (task) => { event = { operation: task.operation, bodies: {}, body_queries: 0 }; });
    Database.prototype.prepare = function(sql) {
      if (!registered.has(this)) {
        registered.add(this);
        this.function('coverage_json_type', { deterministic: true }, (body, path) => { measure(body); return type.get(body, path).value; });
        this.function('coverage_json_extract', { deterministic: true }, (body, path) => { measure(body); return extract.get(body, path).value; });
      }
      const measured = sql.replace(/\\bjson_type\\(/g, 'coverage_json_type(').replace(/\\bjson_extract\\(/g, 'coverage_json_extract(');
      if (event && /[a-zA-Z_]+\\.(?:json|payload_json)\\b/.test(sql)) event.body_queries++;
      const statement = original.call(this, measured);
      for (const method of ['get', 'all']) {
        const call = statement[method].bind(statement);
        statement[method] = (...args) => {
          const result = call(...args);
          for (const row of Array.isArray(result) ? result : [result]) {
            measure(row?.json);
            measure(row?.payload_json);
          }
          return result;
        };
      }
      return statement;
    };
    const send = process.send.bind(process);
    process.send = (message) => {
      if (event) {
        if (message.result?.mode) event.mode = message.result.mode;
        events.push(event);
        writeFileSync(${JSON.stringify(path)}, JSON.stringify(events));
      }
      return send(message);
    };
    await import(${JSON.stringify(main)});
  `,
  );
  let workers = new ConsumerWorkers(2, pathToFileURL(script));
  const attach = () => {
    f.setRuntime(new ConsumerRuntime({ ...f.options(), workers }));
  };
  attach();
  return {
    get workers() {
      return workers;
    },
    attach,
    async restart() {
      await workers.close();
      workers = new ConsumerWorkers(2, pathToFileURL(script));
      attach();
    },
    events: () => eventsSchema.parse(JSON.parse(readFileSync(path, "utf8"))),
  };
}
