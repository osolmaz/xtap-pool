import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumerChangesEnvelopeSchema,
  consumerHistoryEnvelopeSchema,
} from "../src/consumer-http-contract.js";
import { ConsumerRuntime } from "../src/consumer-runtime.js";
import { ConsumerContractChanged } from "../src/consumer-cursor.js";
import { ConsumerHttpError } from "../src/consumer-errors.js";
import { BOOTSTRAP, consumerFixture, consumerTweet } from "./consumer-http-fixture.js";
import type { ConsumerFixture } from "./consumer-http-fixture.js";
import { PAGE_LEASE_MS, CURSOR_RECOVERY_MS } from "../src/consumer-cursor.js";

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
async function bootstrap() {
  let result = await page(BOOTSTRAP);
  for (let i = 0; result.has_more && i < 100; i++)
    result = await page(`/api/units?cursor=${result.cursor}`);
  expect(result.has_more).toBe(false);
  return result;
}
const history = (at: string, extra = "") =>
  `/api/observations?at=${at}&post_ids=100&since=2026-09-05T00:00:00Z&until=2026-09-07T00:00:00Z${extra}`;

describe("incremental consumer HTTP", () => {
  it("resumes metadata-only limit=1 pages after restart and excludes late writes until the next cycle", async () => {
    await f.post(consumerTweet());
    await f.post(consumerTweet("200"));
    const metadata = await page(`${BOOTSTRAP}&limit=1`);
    expect(metadata.changes.map((c) => c.type)).toEqual(["metadata"]);
    f.restart();
    const first = await page(`/api/units?cursor=${metadata.cursor}&limit=1`);
    expect(first.changes.map((c) => c.type)).toEqual(["unit_upsert"]);
    await f.post(consumerTweet("300"));
    const final = await page(`/api/units?cursor=${first.cursor}&limit=1`);
    expect(final.source).toBe(metadata.source);
    expect(final.changes.map((c) => (c.type === "unit_upsert" ? c.unit.id : c.type))).toEqual([
      "200:a",
    ]);
    expect(final.has_more).toBe(false);
    expect(f.codec.decode(final.cursor).position.kind).toBe("idle");
    const delta = await page(`/api/changes?after=${final.cursor}`);
    expect(delta.source).not.toBe(final.source);
    expect(delta.changes.map((c) => (c.type === "unit_upsert" ? c.unit.id : c.type))).toEqual([
      "300:a",
    ]);
    expect(delta.changes.some((c) => c.type === "metadata")).toBe(false);
  });

  it("returns initial metadata and a final idle cursor when no units match", async () => {
    const first = await page(BOOTSTRAP);
    expect(first.changes.map((c) => c.type)).toEqual(["metadata"]);
    const final = await page(`/api/units?cursor=${first.cursor}`);
    expect(final.changes).toEqual([]);
    expect(final.has_more).toBe(false);
    const delta = await page(`/api/changes?after=${final.cursor}`);
    expect(delta.changes).toEqual([]);
    const done = await page(`/api/changes?after=${delta.cursor}`);
    expect(done.has_more).toBe(false);
  });

  it("keeps content coverage unchanged for metric-only and bookkeeping source advances", async () => {
    await f.post(consumerTweet());
    const old = await bootstrap();
    await f.post(
      consumerTweet("100", { captured_at: "2026-09-06T06:00:00.000Z", metrics: { likes: 42 } }),
      false,
    );
    const content = await page(`/api/changes?after=${old.cursor}`);
    expect(content.changes).toEqual([]);
    expect(content.complete_through).toBe(old.complete_through);
    expect(content.observations_through).toBe("2026-09-06T06:00:00.000Z");
    const samples = await page(`/api/changes?after=${content.cursor}`);
    expect(samples.changes.map((c) => c.type)).toEqual(["observation"]);
    expect(samples.has_more).toBe(false);
    await f.log.writeText("config/service-accounts.json", "{}");
    await f.index.advanceToLatest();
    const receipt = await page(`/api/changes?after=${samples.cursor}`);
    expect(receipt.complete_through).toBe(old.complete_through);
    expect(receipt.changes).toEqual([]);
    expect((await page(`/api/changes?after=${receipt.cursor}`)).has_more).toBe(false);
  });

  it("requires explicit scopes and checks revocation on every page", async () => {
    expect((await f.request(BOOTSTRAP, { authorization: "" })).status).toBe(401);
    const limited = await f.accounts.issue("operator", "limited", ["units:read", "taxonomy:read"]);
    const headers = { authorization: `Bearer ${limited.token}` };
    const source = await bootstrap();
    expect((await f.request(`/api/changes?after=${source.cursor}`, headers)).status).toBe(403);
    expect((await f.request(history(source.cursor), headers)).status).toBe(403);
    const first = await page(BOOTSTRAP);
    await f.accounts.revoke("operator", f.credential.account.id);
    expect((await f.request(`/api/units?cursor=${first.cursor}`)).status).toBe(401);
  });

  it.each([
    "author=someone",
    "q=model",
    "cutoff=x",
    "dedup=true",
    "unlabeled=true",
    "revision=old",
    "limit=501",
    "limit=0",
    "limit=1.0",
    "limit=1&limit=2",
    "since=2026-09-01T00:00:00Z",
  ])("rejects unsupported option %s", async (extra) => {
    expect((await f.request(`${BOOTSTRAP}&${extra}`)).status).toBe(400);
  });

  it("normalizes the selection and rejects continuation conflicts and wrong cursor kinds", async () => {
    const first = await page(
      "/api/units?author_ids=22,11,11&labels=ai,ai&label_mode=all&publication=public-original&free_label=glm",
    );
    expect(
      (
        await f.request(
          `/api/units?cursor=${first.cursor}&author_ids=11,22&labels=ai&label_mode=all`,
        )
      ).status,
    ).toBe(200);
    for (const filter of [
      "author_ids=33",
      "labels=other",
      "label_mode=any",
      "free_label=changed",
      "publication=all",
    ])
      expect((await f.request(`/api/units?cursor=${first.cursor}&${filter}`)).status).toBe(400);
    expect((await f.request(`/api/changes?after=${first.cursor}`)).status).toBe(400);
    expect((await f.request(history(first.cursor))).status).toBe(400);
    expect((await f.request("/api/changes")).status).toBe(400);
    expect((await f.request("/api/units?author_ids=11")).status).toBe(400);
  });

  it("binds bounded history to a fully consumed source and never returns a global history cursor", async () => {
    await f.post(consumerTweet());
    await f.post(
      consumerTweet("100", { captured_at: "2026-09-06T06:00:00.000Z", metrics: { likes: 7 } }),
      false,
    );
    const source = await bootstrap();
    const response = await f.request(history(source.cursor, "&limit=1"));
    expect(response.status, await response.clone().text()).toBe(200);
    const first = consumerHistoryEnvelopeSchema.parse(await response.json());
    expect(first.observations).toHaveLength(1);
    expect(first.coverage[0]?.count).toBe(2);
    expect(first.next_cursor).not.toBeNull();
    const token = first.next_cursor ?? "";
    expect(f.codec.decode(token).position.kind).toBe("history");
    f.restart();
    const next = consumerHistoryEnvelopeSchema.parse(
      await (await f.request(`/api/observations?cursor=${token}`)).json(),
    );
    expect(next.observations).toHaveLength(1);
    expect(next.next_cursor).toBeNull();
    expect(next.has_more).toBe(false);
    for (const filter of [
      "post_ids=200",
      "since=2026-09-06T00:00:00Z",
      "until=2026-09-08T00:00:00Z",
      "author_ids=22",
    ])
      expect((await f.request(`/api/observations?cursor=${token}&${filter}`)).status).toBe(400);
    expect((await f.request(`/api/changes?after=${token}`)).status).toBe(400);
    expect((await f.request(history(token))).status).toBe(400);
  });

  it("returns explicit expiry recovery and does not renew old source leases", async () => {
    const first = await page(BOOTSTRAP);
    const source = await bootstrap();
    f.advanceTime(PAGE_LEASE_MS);
    expect((await f.request(`/api/units?cursor=${first.cursor}`)).status).toBe(410);
    f.advanceTime(CURSOR_RECOVERY_MS);
    const expired = await f.request(`/api/changes?after=${source.cursor}`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).not.toContain('"cursor":');
  });

  it("bounds mutex wait and context IO and does not acknowledge a timeout", async () => {
    const options = f.options();
    f.setRuntime(
      new ConsumerRuntime({
        ...options,
        deadlineMs: 30,
        locked: () => new Promise(() => undefined),
      }),
    );
    const response = await f.request(BOOTSTRAP);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("deadline_exceeded");
    f.setRuntime(new ConsumerRuntime({ ...options, deadlineMs: 500 }));
    const source = await bootstrap();
    vi.spyOn(options.contexts, "read").mockImplementation(() => new Promise(() => undefined));
    const stalled = await f.request(`/api/changes?after=${source.cursor}`);
    expect(stalled.status).toBe(503);
    expect(await stalled.text()).not.toContain('"cursor":');
  });

  it("returns structured source failures and capacity errors", async () => {
    const options = f.options();
    f.setRuntime(
      new ConsumerRuntime({
        ...options,
        current: () => {
          throw new ConsumerHttpError(502, "source_unavailable", "fixture failure");
        },
      }),
    );
    expect((await f.request(BOOTSTRAP)).status).toBe(502);
    f.setRuntime(
      new ConsumerRuntime({
        ...options,
        deadlineMs: 100,
        locked: () => new Promise(() => undefined),
      }),
    );
    const first = f.request(BOOTSTRAP);
    const second = f.request(BOOTSTRAP);
    const busy = await f.request(BOOTSTRAP);
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("5");
    await Promise.all([first, second]);
  });
  it("checks final response bytes and replays bounded complete-unit pages without skips", async () => {
    for (const id of ["100", "200", "300"])
      await f.post(consumerTweet(id, { text: "model " + "x".repeat(1_200_000) }));
    const first = await page(BOOTSTRAP);
    const response = await f.request(`/api/units?cursor=${first.cursor}`);
    const bytes = await response.text();
    expect(Buffer.byteLength(bytes)).toBeLessThan(2 * 1_048_576);
    const data = consumerChangesEnvelopeSchema.parse(JSON.parse(bytes));
    expect(data.changes).toHaveLength(1);
    expect(data.has_more).toBe(true);
    expect(await (await f.request(`/api/units?cursor=${first.cursor}`)).text()).toBe(bytes);
    const second = await page(`/api/units?cursor=${data.cursor}`);
    expect(second.changes.map((c) => (c.type === "unit_upsert" ? c.unit.id : c.type))).toEqual([
      "200:a",
    ]);
  });

  it("does not acknowledge one oversized source unit", async () => {
    await f.post(consumerTweet("100", { text: "model " + "x".repeat(8 * 1_048_576) }));
    const first = await page(BOOTSTRAP);
    const response = await f.request(`/api/units?cursor=${first.cursor}`);
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain('"cursor":');
  });

  it.each([
    "post_ids=100,100&since=2026-09-06T00:00:00Z&until=2026-09-07T00:00:00Z",
    "post_ids=100&since=2026-09-07T00:00:00Z&until=2026-09-06T00:00:00Z",
    "post_ids=100&since=2026-08-01T00:00:00Z&until=2026-09-07T00:00:00Z",
    "post_ids=100&since=2026-09-06T00:00:00+01:00&until=2026-09-07T00:00:00Z",
  ])("rejects invalid bounded history %s", async (query) => {
    const source = await bootstrap();
    expect((await f.request(`/api/observations?at=${source.cursor}&${query}`)).status).toBe(400);
  });

  it("rejects more than 100 history IDs and reports requests outside retained history", async () => {
    const source = await bootstrap();
    const ids = Array.from({ length: 101 }, (_, i) => String(i + 1)).join(",");
    expect(
      (
        await f.request(
          `/api/observations?at=${source.cursor}&post_ids=${ids}&since=2026-09-06T00:00:00Z&until=2026-09-07T00:00:00Z`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(
          `/api/observations?at=${source.cursor}&post_ids=100&since=2026-08-01T00:00:00Z&until=2026-08-02T00:00:00Z`,
        )
      ).status,
    ).toBe(410);
  });
  it("reports a changed semantic contract as explicit 409 recovery", async () => {
    const source = await bootstrap();
    vi.spyOn(f.options().contexts, "read").mockRejectedValue(new ConsumerContractChanged());
    const response = await f.request(`/api/changes?after=${source.cursor}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "contract_changed", recovery: { action: "explicit_bootstrap" } },
    });
  });

  it("does not keep adding mutex waiters after deadlines expire", async () => {
    const locked = vi.fn(() => new Promise<never>(() => undefined));
    f.setRuntime(new ConsumerRuntime({ ...f.options(), deadlineMs: 10, locked }));
    await Promise.all([f.request(BOOTSTRAP), f.request(BOOTSTRAP)]);
    expect((await f.request(BOOTSTRAP)).status).toBe(429);
    expect(locked).toHaveBeenCalledTimes(2);
  });
});
