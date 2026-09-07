import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash, normalizeObservation } from "@xtap-pool/shared";
import type { EnrichedUnit } from "@xtap-pool/shared";
import { consumerUnitHash } from "../src/consumer-content.js";
import {
  consumerChangesEnvelopeSchema,
  consumerHistoryEnvelopeSchema,
} from "../src/consumer-http-contract.js";
import {
  ConsumerPageBuilder,
  HARD_PAGE_BYTES,
  consumerUnitUpsertSchema,
} from "../src/consumer-page.js";
import type { ConsumerChange } from "../src/consumer-page.js";
import { BOOTSTRAP, consumerFixture, consumerTweet } from "./consumer-http-fixture.js";
import type { ConsumerFixture } from "./consumer-http-fixture.js";

let f: ConsumerFixture;
beforeEach(async () => {
  f = await consumerFixture();
});
afterEach(async () => {
  await f.close();
});
async function consume(path: string) {
  const changes: ConsumerChange[] = [];
  for (let pages = 0; pages < 100; pages++) {
    const response = await f.request(path);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = consumerChangesEnvelopeSchema.parse(await response.json());
    changes.push(...body.changes);
    if (!body.has_more) return { ...body, changes };
    const operation = path.startsWith("/api/units") ? "units?cursor" : "changes?after";
    path = `/api/${operation}=${body.cursor}`;
  }
  throw new Error("fixture page bound exceeded");
}
function firstUpsert(changes: ConsumerChange[]) {
  return consumerUnitUpsertSchema.parse(upserts(changes)[0]);
}
function upserts(changes: ConsumerChange[]) {
  return changes.filter((change) => change.type === "unit_upsert");
}
const historyPath = (cursor: string) =>
  `/api/observations?at=${cursor}&post_ids=100&since=2026-08-10T00:00:00Z&until=2026-09-07T00:00:00Z`;
function makeUpsert(posts = [consumerTweet()]) {
  const unit: EnrichedUnit = {
    id: "100:a",
    posts,
    contributors: posts.map((post) => post.contributed_by),
    preset_labels: [],
    free_labels: [],
  };
  return {
    type: "unit_upsert" as const,
    content_hash: consumerUnitHash(unit),
    post_content_hashes: posts.map(contentHash),
    unit,
  };
}

describe("source post hashes in consumer upserts", () => {
  it("supplies the exact normalized source hash even without hot observation history", async () => {
    const post = consumerTweet("100", {
      captured_at: "2026-07-01T00:00:00.000Z",
      pooled_at: "2026-07-01T00:01:00.000Z",
      media: [{ url: "https://example.org/image", alt: "model" }],
      extra_content: { z: "preserved", a: [1, 2] },
    });
    await f.post(post);
    const result = await consume(BOOTSTRAP);
    const upsert = firstUpsert(result.changes);
    expect(upsert.post_content_hashes).toEqual([normalizeObservation(post).content_hash]);
    expect(upsert.post_content_hashes).toEqual(
      upsert.unit.posts.map((body) => normalizeObservation(body).content_hash),
    );
    expect(
      f.index.store.database
        .prepare("SELECT content_hash FROM post_content_versions WHERE post_id = ?")
        .get("100"),
    ).toEqual({ content_hash: upsert.post_content_hashes[0] });
    const history = consumerHistoryEnvelopeSchema.parse(
      await (await f.request(historyPath(result.cursor))).json(),
    );
    expect(history.observations).toEqual([]);
    expect(history.coverage).toMatchObject([{ post_id: "100", state: "no_history", count: 0 }]);
  });

  it("keeps hashes stable through counters, followers, attribution, transport, and receipt changes", async () => {
    const post = consumerTweet();
    await f.post(post);
    const before = await consume(BOOTSTRAP);
    const later = {
      ...post,
      captured_at: "2026-09-06T06:00:00.000Z",
      pooled_at: "2026-09-06T07:00:00.000Z",
      contributed_by: "another-member",
      source_endpoint: "another-source",
      observation_id: "transport-observation",
      __xtap_image_backfill: true,
      metrics: { format: "exact-v1", likes: 123, replies: 4 },
      author: { ...post.author, follower_count: 789 },
    };
    expect(normalizeObservation(later).content_hash).toBe(normalizeObservation(post).content_hash);
    await f.post(later, false);
    const delta = await consume(`/api/changes?after=${before.cursor}`);
    expect(upserts(delta.changes)).toEqual([]);
    const samples = delta.changes.filter((change) => change.type === "observation");
    expect(samples.length).toBeGreaterThan(0);
    expect(
      samples.every(
        (sample) =>
          sample.observation.content_hash === upserts(before.changes)[0]?.post_content_hashes[0],
      ),
    ).toBe(true);
    const explicit = await consume(BOOTSTRAP);
    expect(upserts(explicit.changes)[0]?.unit.posts[0]?.contributed_by).toBe("another-member");
    expect(upserts(explicit.changes)[0]?.post_content_hashes).toEqual(
      upserts(before.changes)[0]?.post_content_hashes,
    );
    expect(upserts(explicit.changes)[0]?.content_hash).toBe(
      upserts(before.changes)[0]?.content_hash,
    );
  });

  it("changes only the edited post hash and matches its emitted observation", async () => {
    const first = consumerTweet();
    const second = consumerTweet("200", { conversation_id: "100", text: "another model release" });
    await f.postMany([first, second]);
    const before = await consume(BOOTSTRAP);
    const edit = {
      ...first,
      text: "model release with an edit",
      captured_at: "2026-09-06T06:00:00.000Z",
    };
    await f.post(edit);
    const delta = await consume(`/api/changes?after=${before.cursor}`);
    const upsert = firstUpsert(delta.changes);
    expect(upsert.unit.posts.map((post) => post.id)).toEqual(["100", "200"]);
    expect(upsert.post_content_hashes).toEqual([
      normalizeObservation(edit).content_hash,
      normalizeObservation(second).content_hash,
    ]);
    expect(upsert.post_content_hashes[0]).not.toBe(
      upserts(before.changes)[0]?.post_content_hashes[0],
    );
    expect(upsert.post_content_hashes[1]).toBe(upserts(before.changes)[0]?.post_content_hashes[1]);
    expect(upsert.content_hash).not.toBe(upserts(before.changes)[0]?.content_hash);
    const samples = delta.changes.filter((change) => change.type === "observation");
    expect(samples.map((sample) => sample.observation.content_hash)).toContain(
      upsert.post_content_hashes[0],
    );
  });

  it.each([false, true])(
    "matches the deterministic returned contributor copy, reverse insertion=%s",
    async (reverse) => {
      const copies = [
        consumerTweet("100", { contributed_by: "one", text: "model alpha" }),
        consumerTweet("100", { contributed_by: "two", text: "model beta" }),
      ];
      const selected = [...copies].sort((a, b) => (contentHash(a) < contentHash(b) ? 1 : -1))[0];
      await f.postMany(reverse ? [...copies].reverse() : copies);
      const result = await consume(BOOTSTRAP);
      const upsert = firstUpsert(result.changes);
      expect(upsert.unit.posts).toHaveLength(1);
      expect(upsert.unit.posts[0]).toMatchObject({
        text: selected?.text,
        contributed_by: selected?.contributed_by,
      });
      expect(upsert.post_content_hashes).toEqual(upsert.unit.posts.map(contentHash));
      expect(upsert.unit.contributors).toEqual(["one", "two"]);
      const history = consumerHistoryEnvelopeSchema.parse(
        await (await f.request(historyPath(result.cursor))).json(),
      );
      expect(new Set(history.observations.map((sample) => sample.content_hash))).toEqual(
        new Set(copies.map(contentHash)),
      );
    },
  );

  it("keeps a separate validated entry for each returned same-ID contributor copy", () => {
    const copies = [
      consumerTweet("100", { contributed_by: "one", text: "model alpha" }),
      consumerTweet("100", { contributed_by: "two", text: "model beta" }),
    ];
    const value = makeUpsert(copies);
    expect(consumerUnitUpsertSchema.parse(value).post_content_hashes).toEqual(
      copies.map((post) => normalizeObservation(post).content_hash),
    );
    expect(new Set(value.post_content_hashes).size).toBe(2);
    expect(
      consumerUnitUpsertSchema.safeParse({
        ...value,
        post_content_hashes: [...value.post_content_hashes].reverse(),
      }).success,
    ).toBe(false);
    const identical = makeUpsert([
      copies[0] ?? consumerTweet(),
      { ...(copies[0] ?? consumerTweet()), contributed_by: "other" },
    ]);
    expect(consumerUnitUpsertSchema.parse(identical).post_content_hashes).toHaveLength(2);
    expect(new Set(identical.post_content_hashes).size).toBe(1);
  });

  it.each(["missing", "empty", "extra", "malformed", "wrong", "edited_body"])(
    "rejects %s post hash data before a page is accepted",
    (kind) => {
      const value: Record<string, unknown> = makeUpsert();
      const changes: Record<string, unknown> = {
        missing: undefined,
        empty: [],
        extra: [contentHash(consumerTweet()), contentHash(consumerTweet())],
        malformed: ["not-a-hash"],
        wrong: ["0".repeat(64)],
      };
      if (kind === "edited_body")
        value["unit"] = makeUpsert([consumerTweet("100", { text: "changed body" })]).unit;
      else value["post_content_hashes"] = changes[kind];
      expect(consumerUnitUpsertSchema.safeParse(value).success).toBe(false);
    },
  );

  it("fails closed if a stored source hash does not match its reconstructed body", async () => {
    await f.post(consumerTweet());
    const response = await f.request(BOOTSTRAP);
    const first = consumerChangesEnvelopeSchema.parse(await response.json());
    f.index.store.database
      .prepare(
        "UPDATE post_content_versions SET payload_json = json_set(payload_json, '$.text', 'corrupted model body') WHERE post_id = ?",
      )
      .run("100");
    const failed = await f.request(`/api/units?cursor=${first.cursor}`);
    expect(failed.status).toBe(502);
    const body = await failed.text();
    expect(body).not.toContain('"cursor":');
    expect(body).not.toContain("corrupted model body");
  });

  it("counts the hash array in the complete-item hard byte limit without accepting a partial item", () => {
    const small = makeUpsert();
    const { post_content_hashes: hashes, ...previousShape } = small;
    expect(hashes).toHaveLength(1);
    const padding = HARD_PAGE_BYTES - 8193 - Buffer.byteLength(JSON.stringify(previousShape)) - 32;
    const oversized = makeUpsert([
      consumerTweet("100", { text: consumerTweet().text + "x".repeat(padding) }),
    ]);
    const { post_content_hashes: addedHashes, ...oldShape } = oversized;
    expect(addedHashes).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(oldShape)) + 8193).toBeLessThan(HARD_PAGE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(oversized)) + 8193).toBeGreaterThan(HARD_PAGE_BYTES);
    const page = new ConsumerPageBuilder(500);
    expect(() => page.add(consumerUnitUpsertSchema.parse(oversized))).toThrow(/byte bound/);
    expect(page.changes).toEqual([]);
  });
});
