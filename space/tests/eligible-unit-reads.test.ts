import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { unitIdFor } from "@xtap-pool/shared";
import { eligibleUnits } from "../src/enrich-store.js";
import { consumerFixture, consumerTweet, HTTP_CONTRACT } from "./consumer-http-fixture.js";
import type { ConsumerFixture } from "./consumer-http-fixture.js";

let f: ConsumerFixture;
beforeEach(async () => {
  f = await consumerFixture();
});
afterEach(async () => {
  await f.close();
});

it("uses the access index without rereading bodies for multi-label selection", async () => {
  const posts = Array.from({ length: 20 }, (_, n) =>
    consumerTweet(String(100 + n), { conversation_id: "100" }),
  );
  await f.postMany(posts);
  const first = posts[0];
  if (first === undefined) throw new Error("missing fixture post");
  const unit = unitIdFor(first);
  const db = f.index.store.database;
  db.prepare(
    "INSERT INTO label_assignments (unit_id, name, kind) VALUES (?, 'local-models', 'preset')",
  ).run(unit);
  const json = new Database(":memory:");
  const extract = json.prepare("SELECT json_extract(?, ?) AS value");
  let reads = 0;
  db.function("json_extract", (body, path) => {
    reads++;
    return z
      .object({ value: z.union([z.string(), z.number(), z.null()]) })
      .parse(extract.get(body, path)).value;
  });
  const select = (labels: string[], labelMode: "any" | "all" = "any") => {
    reads = 0;
    const query = eligibleUnits({
      labels,
      labelMode,
      authorIds: ["11"],
      publication: "public-original",
      unitIds: [unit],
      cutoff: "2026-09-08T00:00:00.000Z",
      taxonomyVersion: 1,
      contractHash: HTTP_CONTRACT,
    });
    const rows = db.prepare(query.sql).all(...query.params);
    return { rows, reads };
  };
  try {
    const one = select(["ai"]);
    expect(one.rows).toEqual([{ unit_id: unit }]);
    expect(one.reads).toBe(0);
    expect(select(["ai", "local-models"])).toEqual(one);
    expect(select(["ai", "local-models"], "all")).toEqual(one);
    expect(select([])).toEqual(one);
    expect(select(["ai", "missing"], "all").rows).toEqual([]);
  } finally {
    json.close();
  }
});
