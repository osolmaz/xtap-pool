import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statSync, writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { consumerFixture, consumerTweet, BOOTSTRAP } from "./consumer-http-fixture.js";
import type { ConsumerFixture } from "./consumer-http-fixture.js";
import { ConsumerWorkers } from "../src/consumer-workers.js";
import { readConsumerTask } from "../src/consumer-worker-read.js";
import type { ConsumerWorkerTask } from "../src/consumer-worker-task.js";
import { consumerChangesEnvelopeSchema } from "../src/consumer-http-contract.js";
import { withConsumerDeadline, consumerFetch } from "../src/consumer-deadline.js";

let f: ConsumerFixture;
beforeEach(async () => {
  f = await consumerFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.close();
});
async function task(): Promise<ConsumerWorkerTask> {
  const response = consumerChangesEnvelopeSchema.parse(await (await f.request(BOOTSTRAP)).json());
  const cursor = f.codec.decode(response.cursor);
  const target = await f.options().contexts.read(cursor.target);
  const path = f.options().current().databasePath;
  const stat = statSync(path);
  return {
    path,
    identity: `${String(stat.dev)}:${String(stat.ino)}`,
    source: target.context.source,
    contract: target.context.contract,
    target,
    cursor,
    operation: "page",
    limit: 200,
  };
}

describe("readonly consumer processes", () => {
  it("runs real indexed reads with no DDL or database writes", async () => {
    await f.post(consumerTweet());
    const input = await task();
    const database = new Database(input.path, { readonly: true, fileMustExist: true });
    const exec = vi.spyOn(database, "exec");
    try {
      expect(readConsumerTask(database, input).kind).toBe("changes");
      expect(exec).not.toHaveBeenCalled();
      expect(() => database.exec("CREATE TABLE forbidden (id INTEGER)")).toThrow(/readonly/);
      expect((await f.workers.run(input, new AbortController().signal)).kind).toBe("changes");
    } finally {
      database.close();
    }
  });

  it("fails closed for wrong boundaries and missing or mutated target segments", async () => {
    await f.post(consumerTweet());
    const input = await task();
    await expect(
      f.workers.run({ ...input, source: "f".repeat(64) }, new AbortController().signal),
    ).rejects.toMatchObject({ status: 503 });
    const first = input.target.snapshot.files[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("fixture needs a segment");
    const changed = {
      ...input,
      target: {
        ...input.target,
        snapshot: { ...input.target.snapshot, files: [{ ...first, oid: "f".repeat(64) }] },
      },
    };
    await expect(f.workers.run(changed, new AbortController().signal)).rejects.toMatchObject({
      status: 503,
      code: "source_not_ready",
    });
  });

  it("detects file replacement before a request and reopens only a verified replacement", async () => {
    await f.post(consumerTweet());
    const input = await task();
    await f.workers.run(input, new AbortController().signal);
    const replacement = join(f.directory, "replacement.sqlite");
    await f.index.store.database.backup(replacement);
    renameSync(replacement, input.path);
    await expect(f.workers.run(input, new AbortController().signal)).rejects.toMatchObject({
      code: "database_replaced",
    });
    const stat = statSync(input.path);
    const renewed = { ...input, identity: `${String(stat.dev)}:${String(stat.ino)}` };
    expect((await f.workers.run(renewed, new AbortController().signal)).kind).toBe("changes");
  });

  it("kills a child inside synchronous native SQLite and enforces process capacity", async () => {
    const input = await task();
    const marker = join(f.directory, "query-started");
    const script = join(f.directory, "long-query.mjs");
    const sqlite = new URL("../../node_modules/better-sqlite3/lib/index.js", import.meta.url)
      .pathname;
    writeFileSync(
      script,
      `import Database from ${JSON.stringify(sqlite)};
      import { writeFileSync } from 'node:fs';
      const database = new Database(':memory:');
      process.on('message', () => { writeFileSync(${JSON.stringify(marker)}, String(process.pid));
        database.prepare('WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < 1000000000) SELECT sum(x) FROM n').get(); });`,
    );
    const workers = new ConsumerWorkers(1, new URL(`file://${script}`));
    const controller = new AbortController();
    const running = workers.run(input, controller.signal);
    const rejected = expect(running).rejects.toMatchObject({ code: "deadline_exceeded" });
    try {
      await vi.waitFor(() => {
        expect(existsSync(marker)).toBe(true);
      });
      await expect(workers.run(input, new AbortController().signal)).rejects.toMatchObject({
        status: 429,
      });
      const start = Date.now();
      controller.abort();
      await rejected;
      await workers.close();
      expect(Date.now() - start).toBeLessThan(1500);
      const pid = Number(readFileSync(marker, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(workers.run(input, new AbortController().signal)).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      controller.abort();
      await workers.close();
    }
  });

  it("has a real wall deadline while the event loop remains responsive", async () => {
    const start = Date.now();
    await expect(
      withConsumerDeadline(
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              reject(new Error("cancelled"));
            });
          }),
        new AbortController().signal,
        30,
      ),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("cancels SDK fetch and its retries with the same absolute signal", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    await expect(
      withConsumerDeadline(
        () => consumerFetch("https://example.invalid"),
        new AbortController().signal,
        20,
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
  });
});
