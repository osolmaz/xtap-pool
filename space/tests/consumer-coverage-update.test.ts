import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { computeInputHash } from "@xtap-pool/shared";
import { consumerChangesEnvelopeSchema } from "../src/consumer-http-contract.js";
import { ConsumerRuntime } from "../src/consumer-runtime.js";
import { updateConsumerCoverage } from "../src/consumer-coverage-update.js";
import { selectedObservationThrough } from "../src/consumer-coverage.js";
import { selectedCompleteThrough } from "../src/enrich-store.js";
import { historicalSelection } from "../src/consumer-changes.js";
import {
  BOOTSTRAP,
  consumerFixture,
  consumerTweet,
  HTTP_CONTRACT,
} from "./consumer-http-fixture.js";
import type { ConsumerFixture } from "./consumer-http-fixture.js";
import { consumerQueryPlan } from "./consumer-query-plan.js";
import { coverageProbe } from "./consumer-coverage-probe.js";

let f: ConsumerFixture;
let probe: ReturnType<typeof coverageProbe>;
beforeEach(async () => {
  f = await consumerFixture();
  probe = coverageProbe(f);
});
afterEach(async () => {
  await probe.workers.close();
  await f.close();
});
async function page(path: string) {
  const response = await f.request(path);
  expect(response.status, await response.clone().text()).toBe(200);
  return consumerChangesEnvelopeSchema.parse(await response.json());
}
async function finish(path: string) {
  let response = await page(path);
  const changes = [...response.changes];
  for (let n = 0; response.has_more && n < 100; n++) {
    const route = path.startsWith("/api/units") ? "units?cursor" : "changes?after";
    response = await page(`/api/${route}=${response.cursor}`);
    changes.push(...response.changes);
  }
  expect(response.has_more).toBe(false);
  return { ...response, changes };
}
async function context(cursor: string) {
  return f.options().contexts.read(f.codec.decode(cursor).target);
}
async function assertFullCoverage(cursor: string, previous?: string) {
  const pinned = await context(cursor);
  const database = f.index.store.database;
  const full = updateConsumerCoverage(database, pinned);
  // Compare full selection and explicitly selected post coverage.
  expect(full.completeThrough).toBe(
    selectedCompleteThrough(database, historicalSelection(pinned)) ?? null,
  );
  const allPosts = database
    .prepare("SELECT DISTINCT tweet_id FROM unit_members")
    .all()
    .map((row) => z.object({ tweet_id: z.string() }).parse(row).tweet_id);
  expect(full.observationsThrough).toBe(selectedObservationThrough(database, pinned, allPosts));
  expect(pinned.context.complete_through).toBe(full.completeThrough);
  expect(pinned.context.observations_through).toBe(full.observationsThrough);
  if (previous !== undefined) {
    const incremental = updateConsumerCoverage(
      f.index.store.database,
      pinned,
      await context(previous),
    );
    expect(incremental.completeThrough).toBe(full.completeThrough);
    expect(incremental.observationsThrough).toBe(full.observationsThrough);
  }
}
function readsSince(start: number, operation?: string) {
  return probe
    .events()
    .slice(start)
    .filter((event) => operation === undefined || event.operation === operation);
}
function bodyIds(start: number, operation?: string) {
  return [
    ...new Set(readsSince(start, operation).flatMap((event) => Object.keys(event.bodies))),
  ].sort();
}
async function attempt(outcome: "blocked" | "dispatched", id = "100:a") {
  const queue = f.index.enrichStore.queueEntry(id);
  await f.log.commitBatch(
    [
      {
        path: "enrichment/attempts/2026/09/attempts-2026-09-07.jsonl",
        lines: [
          JSON.stringify({
            unit_id: id,
            input_hash: queue?.inputHash ?? "missing",
            contract_hash: HTTP_CONTRACT,
            attempt: 10,
            outcome,
            at: f.now().toISOString(),
          }),
        ],
      },
    ],
    [],
  );
  await f.index.advanceToLatest();
}

async function registry(name: string, status: "candidate" | "approved" | "rejected") {
  await f.log.commitBatch(
    [
      {
        path: "enrichment/registry/2026/09/registry-2026-09-07.jsonl",
        lines: [
          JSON.stringify({
            name,
            status,
            registry_revision: f.index.enrichStore.registryRevision() + 1,
            at: f.now().toISOString(),
            contract_hash: HTTP_CONTRACT,
            actor: "operator",
            quotes: [],
          }),
        ],
      },
    ],
    [],
  );
  await f.index.advanceToLatest();
}
describe("source coverage maintenance", () => {
  it("looks up each observation before testing a large exact source boundary", async () => {
    await f.postMany(Array.from({ length: 100 }, (_, n) => consumerTweet(String(100 + n))));
    const source = await finish(BOOTSTRAP);
    const pinned = await context(source.cursor);
    await f.post(
      consumerTweet("100", { captured_at: "2026-09-06T05:00:00.000Z", metrics: { likes: 5 } }),
      false,
    );
    const file = pinned.snapshot.files[0];
    if (file === undefined) throw new Error("missing fixture source");
    const target = {
      ...pinned,
      snapshot: {
        ...pinned.snapshot,
        files: [
          ...pinned.snapshot.files,
          ...Array.from({ length: 38219 }, (_, n) => ({ ...file, key: `unused-${String(n)}` })),
        ],
      },
    };
    const plan = consumerQueryPlan(f.index.store.database, /AS latest FROM selected_posts/u);
    const coverage = updateConsumerCoverage(f.index.store.database, target);
    expect(coverage.observationsThrough).toBe(source.observations_through);
    expect(coverage.completeThrough).toBe(source.complete_through);
    expect(plan.some((line) => /SEARCH s .*\(observation_id=\?\)/u.test(line))).toBe(true);
    expect(plan.some((line) => line.includes("segment_key=? AND observation_id=?"))).toBe(false);
  });

  it("uses the indexed current selection for both semantic coverage clocks", async () => {
    await f.postMany([
      consumerTweet("100"),
      consumerTweet("200"),
      consumerTweet("300", { author: { id: "22", username: "other" } }),
    ]);
    const source = await finish(BOOTSTRAP);
    const pinned = await context(source.cursor);
    const database = f.index.store.database;
    const plan = consumerQueryPlan(
      database,
      /WITH candidates AS MATERIALIZED|AS latest FROM selected_posts/u,
    );
    const coverage = updateConsumerCoverage(database, pinned);
    expect(coverage.completeThrough).toBe(source.complete_through);
    expect(coverage.observationsThrough).toBe(source.observations_through);
    expect(plan.some((line) => line.includes("idx_consumer_post_units_author"))).toBe(true);
    expect(plan.some((line) => line.includes("observation_sources"))).toBe(false);
  });

  it("does zero body reads for twenty no-op polls and twenty harmless revisions, including restart and replay", async () => {
    await f.postMany(Array.from({ length: 250 }, (_, n) => consumerTweet(String(100 + n))));
    let source = await finish(BOOTSTRAP);
    const original = source;
    expect(bodyIds(0, "coverage")).toHaveLength(250);
    const started = probe.events().length;
    for (let n = 0; n < 20; n++) {
      f.advanceTime(1000);
      source = await page(`/api/changes?after=${source.cursor}`);
      expect(source.changes).toEqual([]);
      expect(source.has_more).toBe(false);
      expect(f.codec.decode(source.cursor).position.kind).toBe("idle");
    }
    expect(source.source).toBe(original.source);
    expect(source.history_until > original.history_until).toBe(true);
    for (let n = 0; n < 20; n++) {
      await f.log.writeText("config/service-accounts.json", JSON.stringify({ revision: n }));
      await f.index.advanceToLatest();
      if (n === 5) await attempt("blocked");
      if (n === 6) await attempt("dispatched");
      if (n === 7) await registry("unused", "candidate");
      if (n === 10) {
        f.restart();
        await probe.restart();
      }
      source = await finish(`/api/changes?after=${source.cursor}`);
      expect(source.changes).toEqual([]);
    }
    expect(source.source).not.toBe(original.source);
    expect(source.complete_through).toBe(original.complete_through);
    expect(source.observations_through).toBe(original.observations_through);
    expect(f.index.enrichStore.queueEntry("100:a")?.status).toBe("done");
    expect(bodyIds(started)).toEqual([]);
    const coverage = readsSince(started, "coverage");
    expect(coverage).toHaveLength(40);
    expect(coverage.every((event) => event.mode === "reuse" && event.body_queries === 0)).toBe(
      true,
    );
    await assertFullCoverage(source.cursor, original.cursor);
  }, 20000);

  it("reads only affected posts for ten metric updates among 250 unrelated posts", async () => {
    await f.postMany(Array.from({ length: 260 }, (_, n) => consumerTweet(String(100 + n))));
    let source = await finish(BOOTSTRAP);
    const complete = source.complete_through;
    const affected = Array.from({ length: 10 }, (_, n) => String(100 + n));
    const started = probe.events().length;
    for (let n = 1; n <= 10; n++) {
      const at = `2026-09-06T${String(n).padStart(2, "0")}:00:00.000Z`;
      await f.postMany(
        affected.map((id) => consumerTweet(id, { captured_at: at, metrics: { likes: n } })),
        false,
      );
      const response = await finish(`/api/changes?after=${source.cursor}`);
      expect(response.complete_through).toBe(complete);
      expect(response.observations_through).toBe(at);
      expect(response.changes.some((change) => change.type === "unit_upsert")).toBe(false);
      await assertFullCoverage(response.cursor, source.cursor);
      source = response;
    }
    expect(bodyIds(started, "coverage")).toEqual(affected);
    expect(bodyIds(started)).toEqual(affected);
    expect(readsSince(started, "coverage").map((event) => event.mode)).toEqual(
      Array<string>(10).fill("metrics"),
    );
  }, 15000);

  it("keeps the maximum for delayed samples and recalculates a corrected content-run clock", async () => {
    await f.post(consumerTweet("100", { captured_at: "2026-09-06T01:00:00.000Z" }));
    await f.post(consumerTweet("200", { captured_at: "2026-09-06T00:30:00.000Z" }));
    let source = await finish(BOOTSTRAP);
    await f.post(
      consumerTweet("100", { captured_at: "2026-09-06T04:00:00.000Z", metrics: { likes: 4 } }),
      false,
    );
    source = await finish(`/api/changes?after=${source.cursor}`);
    const started = probe.events().length;
    await f.post(
      consumerTweet("100", { captured_at: "2026-09-06T02:00:00.000Z", metrics: { likes: 2 } }),
      false,
    );
    source = await finish(`/api/changes?after=${source.cursor}`);
    expect(source.observations_through).toBe("2026-09-06T04:00:00.000Z");
    expect(readsSince(started, "coverage")[0]?.mode).toBe("metrics");
    await f.post(
      consumerTweet("100", { captured_at: "2026-09-06T00:00:00.000Z", metrics: { likes: 1 } }),
      false,
    );
    source = await finish(`/api/changes?after=${source.cursor}`);
    expect(source.complete_through).toBe("2026-09-06T00:30:00.000Z");
    expect(readsSince(started, "coverage").at(-1)?.mode).toBe("semantic");
    await assertFullCoverage(source.cursor);
  });

  it("handles mixed edits and counters, pending activation, and withdrawal of the previous maximum", async () => {
    await f.post(consumerTweet());
    await f.post(consumerTweet("200", { captured_at: "2026-09-06T02:00:00.000Z" }));
    let source = await finish(BOOTSTRAP);
    const started = probe.events().length;
    await f.postMany(
      [
        consumerTweet("100", { text: "model edited", captured_at: "2026-09-06T03:00:00.000Z" }),
        consumerTweet("200", { captured_at: "2026-09-06T04:00:00.000Z", metrics: { likes: 4 } }),
      ],
      false,
    );
    source = await finish(`/api/changes?after=${source.cursor}`);
    expect(source.complete_through).toBe("2026-09-06T02:00:00.000Z");
    expect(source.observations_through).toBe("2026-09-06T04:00:00.000Z");
    await assertFullCoverage(source.cursor);
    await f.post(
      consumerTweet("100", { text: "model edited", captured_at: "2026-09-06T03:00:00.000Z" }),
    );
    source = await finish(`/api/changes?after=${source.cursor}`);
    expect(source.complete_through).toBe("2026-09-06T03:00:00.000Z");
    await f.post(
      consumerTweet("200", { is_subscriber_only: true, captured_at: "2026-09-06T05:00:00.000Z" }),
      false,
    );
    source = await finish(`/api/changes?after=${source.cursor}`);
    expect(source.observations_through).toBe("2026-09-06T03:00:00.000Z");
    expect(readsSince(started, "coverage").map((event) => event.mode)).toEqual([
      "semantic",
      "semantic",
      "semantic",
    ]);
    await assertFullCoverage(source.cursor);
  });

  it("does not move selected clocks for private, pending, or unselected metric sources", async () => {
    await f.post(consumerTweet());
    await f.post(consumerTweet("200", { is_subscriber_only: true }));
    await f.post(consumerTweet("300"), false);
    await f.post(consumerTweet("400", { author: { id: "22", username: "other" } }));
    let source = await finish(BOOTSTRAP);
    const original = source;
    const started = probe.events().length;
    await f.postMany(
      [
        consumerTweet("200", { is_subscriber_only: true, captured_at: "2026-09-06T05:00:00.000Z" }),
        consumerTweet("300", { captured_at: "2026-09-06T06:00:00.000Z" }),
        consumerTweet("400", {
          author: { id: "22", username: "other" },
          captured_at: "2026-09-06T07:00:00.000Z",
        }),
      ],
      false,
    );
    source = await finish(`/api/changes?after=${source.cursor}`);
    expect(source.observations_through).toBe(original.observations_through);
    expect(source.complete_through).toBe(original.complete_through);
    expect(bodyIds(started, "coverage")).not.toContain("100");
    expect(bodyIds(started, "coverage")).not.toContain("400");
    expect(readsSince(started, "coverage")[0]?.mode).toBe("metrics");
    await assertFullCoverage(source.cursor);
  });

  it("emits actual metadata changes while reusing clocks when only descriptions or approval timestamps change", async () => {
    await f.post(consumerTweet());
    const source = await finish(BOOTSTRAP);
    const options = f.options();
    const current = options.current();
    f.setRuntime(
      new ConsumerRuntime({
        ...options,
        workers: probe.workers,
        current: () => ({
          ...current,
          taxonomy: { version: 1, labels: [{ name: "ai", description: "Changed description" }] },
          boundary: {
            ...current.boundary,
            registry: {
              ...current.boundary.registry,
              revision: 42,
              approved: [
                {
                  name: "unused",
                  first_observed_at: f.now().toISOString(),
                  updated_at: f.now().toISOString(),
                },
              ],
            },
          },
        }),
      }),
    );
    const started = probe.events().length;
    const response = await finish(`/api/changes?after=${source.cursor}`);
    expect(response.changes.map((change) => change.type)).toEqual(["metadata"]);
    expect(response.complete_through).toBe(source.complete_through);
    expect(response.observations_through).toBe(source.observations_through);
    expect(readsSince(started, "coverage")[0]?.mode).toBe("reuse");
    expect(bodyIds(started)).toEqual([]);
  });

  it("recalculates eligibility when a selected free label gains approval", async () => {
    await f.post(consumerTweet());
    const id = "100:a";
    f.advanceTime(1000);
    await f.log.commitBatch(
      [
        {
          path: "enrichment/2026/09/enrichment-2026-09-07.jsonl",
          lines: [
            JSON.stringify({
              unit_id: id,
              tweet_ids: ["100"],
              input_hash: computeInputHash(id, f.index.enrichStore.unitSemanticMembers(id)),
              contract_hash: HTTP_CONTRACT,
              taxonomy_version: 1,
              model: "fixture",
              enriched_at: f.now().toISOString(),
              preset_labels: [{ name: "ai", evidence: [{ tweet_id: "100", quote: "model" }] }],
              free_labels: [{ name: "model", evidence: [{ tweet_id: "100", quote: "model" }] }],
            }),
          ],
        },
      ],
      [],
    );
    await f.index.advanceToLatest();
    await registry("model", "candidate");
    const source = await finish(`${BOOTSTRAP}&free_label=model`);
    expect(source.observations_through).toBeNull();
    await registry("model", "approved");
    const started = probe.events().length;
    const response = await finish(`/api/changes?after=${source.cursor}`);
    expect(response.observations_through).toBe("2026-09-06T00:00:00.000Z");
    expect(readsSince(started, "coverage")[0]?.mode).toBe("semantic");
    await assertFullCoverage(response.cursor);
  });
  it("reuses coverage for duplicate results and new sources outside the selected units", async () => {
    await f.post(consumerTweet());
    let source = await finish(BOOTSTRAP);
    const original = source;
    const row = z
      .object({ payload_json: z.string() })
      .parse(
        f.index.store.database.prepare("SELECT payload_json FROM consumer_results LIMIT 1").get(),
      );
    await f.log.commitBatch(
      [{ path: "enrichment/2026/09/enrichment-2026-09-07.jsonl", lines: [row.payload_json] }],
      [],
    );
    await f.index.advanceToLatest();
    const started = probe.events().length;
    source = await finish(`/api/changes?after=${source.cursor}`);
    expect(bodyIds(started)).toEqual([]);
    await f.post(
      consumerTweet("999", {
        author: { id: "22", username: "other" },
        captured_at: "2026-09-06T07:00:00.000Z",
      }),
    );
    source = await finish(`/api/changes?after=${source.cursor}`);
    expect(source.complete_through).toBe(original.complete_through);
    expect(source.observations_through).toBe(original.observations_through);
    expect(bodyIds(started, "coverage")).toEqual([]);
    expect(readsSince(started, "coverage").map((event) => event.mode)).toEqual(["reuse", "reuse"]);
    await assertFullCoverage(source.cursor);
  });

  it("does not reuse a base with a changed taxonomy version or selection", async () => {
    await f.post(consumerTweet());
    const source = await finish(BOOTSTRAP);
    const base = await context(source.cursor);
    const target = {
      ...base,
      context: { ...base.context, taxonomy: { ...base.context.taxonomy, version: 2 } },
    };
    expect(updateConsumerCoverage(f.index.store.database, target, base)).toMatchObject({
      mode: "semantic",
      observationsThrough: null,
    });
    const other = {
      ...base,
      context: { ...base.context, selection: { ...base.context.selection, author_ids: ["22"] } },
    };
    expect(updateConsumerCoverage(f.index.store.database, other, base)).toMatchObject({
      mode: "semantic",
      completeThrough: null,
      observationsThrough: null,
    });
  });
  it("finds the newest permitted observation when later samples are outside the pinned source", async () => {
    await f.postMany([
      consumerTweet("100", { captured_at: "2026-09-06T01:00:00.000Z" }),
      consumerTweet("200", { conversation_id: "100", captured_at: "2026-09-06T02:00:00.000Z" }),
    ]);
    const source = await finish(BOOTSTRAP);
    const pinned = await context(source.cursor);
    for (let hour = 3; hour < 12; hour++) {
      await f.post(
        consumerTweet("100", {
          captured_at: `2026-09-06T${String(hour).padStart(2, "0")}:00:00.000Z`,
          metrics: { likes: hour },
        }),
        false,
      );
    }
    expect(selectedObservationThrough(f.index.store.database, pinned)).toBe(
      "2026-09-06T02:00:00.000Z",
    );
    expect(selectedObservationThrough(f.index.store.database, pinned, ["100"])).toBe(
      "2026-09-06T01:00:00.000Z",
    );
    expect(selectedObservationThrough(f.index.store.database, pinned, [])).toBeNull();
    const next = await finish(`/api/changes?after=${source.cursor}`);
    expect(next.observations_through).toBe("2026-09-06T11:00:00.000Z");
    await assertFullCoverage(next.cursor, source.cursor);
  });

  it("drops the old observation maximum when one member becomes a retweet", async () => {
    await f.postMany([
      consumerTweet("100", { captured_at: "2026-09-06T01:00:00.000Z" }),
      consumerTweet("200", { conversation_id: "100", captured_at: "2026-09-06T05:00:00.000Z" }),
    ]);
    const source = await finish(BOOTSTRAP);
    expect(source.observations_through).toBe("2026-09-06T05:00:00.000Z");
    await f.post(
      consumerTweet("200", {
        conversation_id: "100",
        is_retweet: true,
        captured_at: "2026-09-06T06:00:00.000Z",
      }),
    );
    const next = await finish(`/api/changes?after=${source.cursor}`);
    expect(next.observations_through).toBe("2026-09-06T01:00:00.000Z");
    await assertFullCoverage(next.cursor, source.cursor);
  });

  it("detects a contributor winner change even when the set of copy hashes is unchanged", async () => {
    const first = consumerTweet("100", {
      contributed_by: "one",
      captured_at: "2026-09-06T01:00:00.000Z",
      text: "model alpha",
    });
    const second = consumerTweet("100", {
      contributed_by: "two",
      captured_at: "2026-09-06T02:00:00.000Z",
      text: "model beta",
    });
    await f.post(first);
    await f.post(second);
    const source = await finish(BOOTSTRAP);
    await f.post(
      { ...first, captured_at: "2026-09-06T03:00:00.000Z", metrics: { likes: 9 } },
      false,
    );
    const started = probe.events().length;
    const next = await finish(`/api/changes?after=${source.cursor}`);
    expect(readsSince(started, "coverage")[0]?.mode).toBe("semantic");
    expect(next.complete_through).toBe("2026-09-06T03:00:00.000Z");
    await assertFullCoverage(next.cursor, source.cursor);
  });
});
