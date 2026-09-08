import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumerChangesEnvelopeSchema } from "../src/consumer-http-contract.js";
import { ConsumerCoverageEffects } from "../src/consumer-coverage-effects.js";
import { BOOTSTRAP, consumerFixture, consumerTweet } from "./consumer-http-fixture.js";
import type { ConsumerFixture } from "./consumer-http-fixture.js";
import { consumerQueryPlan } from "./consumer-query-plan.js";

let f: ConsumerFixture;
beforeEach(async () => {
  f = await consumerFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.close();
});
async function page(path: string) {
  const response = await f.request(path);
  expect(response.status, await response.clone().text()).toBe(200);
  return consumerChangesEnvelopeSchema.parse(await response.json());
}
async function baseline() {
  await f.post(consumerTweet());
  const metadata = await page(BOOTSTRAP);
  const result = await page(`/api/units?cursor=${metadata.cursor}`);
  expect(result.has_more).toBe(false);
  return result;
}

describe("changed-source request boundaries", () => {
  it("separates source pinning from body reads without sending unchanged metadata", async () => {
    const old = await baseline();
    await f.post(consumerTweet("200"));
    const calls = vi.spyOn(f.workers, "run");
    const boundary = await page(`/api/changes?after=${old.cursor}&limit=1`);
    expect(boundary.changes).toEqual([]);
    expect(boundary.has_more).toBe(true);
    expect(boundary.source).not.toBe(old.source);
    expect(boundary.cursor).not.toBe(old.cursor);
    expect(f.codec.decode(boundary.cursor).metadata_sent).toBe(true);
    expect(calls.mock.calls.map(([task]) => task.operation)).toEqual(["coverage", "privacy"]);

    await f.post(consumerTweet("300"));
    f.restart();
    calls.mockClear();
    const content = await page(`/api/changes?after=${boundary.cursor}&limit=1`);
    expect(content.source).toBe(boundary.source);
    expect(
      content.changes.map((change) =>
        change.type === "unit_upsert" ? change.unit.id : change.type,
      ),
    ).toEqual(["200:a"]);
    expect(calls.mock.calls.map(([task]) => task.operation)).toEqual(["page"]);
  });

  it("keeps an unchanged source as a single empty completed response", async () => {
    const old = await baseline();
    const calls = vi.spyOn(f.workers, "run");
    const idle = await page(`/api/changes?after=${old.cursor}`);
    expect(idle.changes).toEqual([]);
    expect(idle.has_more).toBe(false);
    expect(idle.source).toBe(old.source);
    expect(calls.mock.calls.map(([task]) => task.operation)).toEqual(["coverage", "page"]);
  });

  it("still requires removal reconciliation after a boundary-only response", async () => {
    const old = await baseline();
    await f.post(consumerTweet("200"));
    const boundary = await page(`/api/changes?after=${old.cursor}`);
    expect(boundary.changes).toEqual([]);
    await f.post(
      consumerTweet("100", {
        captured_at: "2026-09-06T06:00:00.000Z",
        is_subscriber_only: true,
      }),
      false,
    );
    const response = await f.request(`/api/changes?after=${boundary.cursor}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "privacy_changed" } });
  });

  it("deduplicates changed posts before checking selected unit membership", async () => {
    const old = await baseline();
    const base = await f.options().contexts.read(f.codec.decode(old.cursor).target);
    for (const hour of [1, 2, 3]) {
      await f.post(
        consumerTweet("100", {
          captured_at: `2026-09-06T0${String(hour)}:00:00.000Z`,
          metrics: { likes: hour },
        }),
        false,
      );
    }
    await f.post(consumerTweet("200", { author: { id: "22", username: "other" } }));
    const boundary = await page(`/api/changes?after=${old.cursor}`);
    const target = await f.options().contexts.read(f.codec.decode(boundary.cursor).target);
    const plan = consumerQueryPlan(f.index.store.database, /WITH changed_posts AS MATERIALIZED/u);
    const effects = new ConsumerCoverageEffects(f.index.store.database, base, target);
    expect(effects.posts()).toEqual(["100"]);
    expect(effects.posts("100")).toEqual([]);
    expect(plan).toContain("MATERIALIZE changed_posts");
    expect(plan.some((line) => line.includes("idx_observation_source_segment"))).toBe(true);
    expect(plan.some((line) => line.includes("idx_consumer_post_units_post"))).toBe(true);
  });
});
