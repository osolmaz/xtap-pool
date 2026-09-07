import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConsumerRuntime } from "../src/consumer-runtime.js";
import { ConsumerChangeEngine } from "../src/consumer-changes.js";
import { ConsumerPrivacyEffects } from "../src/consumer-privacy.js";
import { HistoricalUnitReader } from "../src/historical-unit-reader.js";
import {
  consumerChangesEnvelopeSchema,
  consumerHistoryEnvelopeSchema,
  consumerReconciliationEnvelopeSchema,
} from "../src/consumer-http-contract.js";
import type { ConsumerChange } from "../src/consumer-page.js";
import type { consumerRemovalSchema } from "../src/consumer-privacy.js";
import { PAGE_LEASE_MS } from "../src/consumer-cursor.js";
import { BOOTSTRAP, consumerFixture, consumerTweet } from "./consumer-http-fixture.js";
import type { ConsumerFixture } from "./consumer-http-fixture.js";

let f: ConsumerFixture;
beforeEach(async () => {
  f = await consumerFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.close();
});
const history = (at: string) =>
  `/api/observations?at=${at}&post_ids=100&since=2026-09-05T00:00:00Z&until=2026-09-07T00:00:00Z`;
async function changes(path: string) {
  const response = await f.request(path);
  expect(response.status, await response.clone().text()).toBe(200);
  return consumerChangesEnvelopeSchema.parse(await response.json());
}
async function withdraw(id: string) {
  await f.post(
    consumerTweet(id, { is_subscriber_only: true, captured_at: "2026-09-06T08:00:00.000Z" }),
    false,
  );
}
async function recovery(path: string) {
  const response = await f.request(path);
  expect(response.status, await response.clone().text()).toBe(409);
  const raw = await response.text();
  expect(raw).not.toContain("model release");
  return z
    .object({
      error: z.object({
        code: z.literal("privacy_changed"),
        recovery: z.object({
          action: z.literal("reconcile"),
          path: z.literal("/api/reconcile"),
          cursor: z.string(),
        }),
      }),
    })
    .parse(JSON.parse(raw)).error.recovery.cursor;
}
async function removals(cursor: string, limit = 1) {
  const response = await f.request(`/api/reconcile?cursor=${cursor}&limit=${String(limit)}`);
  expect(response.status, await response.clone().text()).toBe(200);
  const raw = await response.text();
  expect(raw).not.toContain("model release");
  return consumerReconciliationEnvelopeSchema.parse(JSON.parse(raw));
}
async function finishRecovery(cursor: string, replica = new Replica()) {
  let page = await removals(cursor);
  for (let n = 0; n < 100; n++) {
    replica.remove(page.removals);
    if (!page.has_more) {
      expect(page.next_cursor).toBeNull();
      expect(page.resume_cursor).not.toBeNull();
      return { cursor: page.resume_cursor ?? "", path: page.resume_path };
    }
    expect(page.resume_cursor).toBeNull();
    page = await removals(page.next_cursor ?? "");
  }
  throw new Error("recovery did not finish");
}
async function finishChanges(path: string, replica = new Replica()) {
  let page = await changes(path);
  for (let n = 0; n < 100; n++) {
    replica.apply(page.changes);
    if (!page.has_more) return page;
    const route =
      f.codec.decode(page.cursor).position.kind === "bootstrap"
        ? "/api/units?cursor"
        : "/api/changes?after";
    page = await changes(`${route}=${page.cursor}&limit=500`);
  }
  throw new Error("content did not finish");
}

/** The client has an index from posts to accepted units. Removal work follows
 * those references, including published stories; unrelated units survive. */
class Replica {
  readonly units = new Map<string, string[]>();
  readonly posts = new Set<string>();
  readonly stories = new Set<string>();
  readonly observations = new Map<string, string>();
  private readonly references = new Map<string, Set<string>>();
  apply(changes: ConsumerChange[]): void {
    for (const change of changes) {
      if (change.type === "unit_remove") this.removeUnit(change.unit_id);
      if (change.type === "observation")
        this.observations.set(change.observation.id, change.observation.post_id);
      if (change.type === "unit_upsert") this.upsert(change);
    }
  }
  remove(removals: z.infer<typeof consumerRemovalSchema>[]): void {
    for (const removal of removals) {
      if (removal.type === "post_remove") {
        for (const id of this.references.get(removal.post_id) ?? []) this.removeUnit(id);
        this.purge(removal.post_id);
      } else if (this.units.get(removal.unit_id)?.includes(removal.post_id))
        this.removeUnit(removal.unit_id);
    }
  }
  private upsert(change: Extract<ConsumerChange, { type: "unit_upsert" }>): void {
    this.removeUnit(change.unit.id);
    this.units.set(
      change.unit.id,
      change.unit.posts.map((post) => post.id),
    );
    for (const post of change.unit.posts) {
      const references = this.references.get(post.id) ?? new Set<string>();
      references.add(change.unit.id);
      this.references.set(post.id, references);
      this.posts.add(post.id);
      this.stories.add(post.id);
    }
  }
  private removeUnit(id: string): void {
    for (const post of this.units.get(id) ?? []) {
      const references = this.references.get(post);
      references?.delete(id);
      if (references?.size === 0) this.purge(post);
    }
    this.units.delete(id);
  }
  private purge(post: string): void {
    this.posts.delete(post);
    this.stories.delete(post);
    for (const [id, member] of this.observations) if (member === post) this.observations.delete(id);
  }
}

describe("paged privacy reconciliation", () => {
  it("removes a post accepted on an early bootstrap page and keeps unrelated published content", async () => {
    for (const id of ["100", "200", "300"]) await f.post(consumerTweet(id));
    const replica = new Replica();
    const metadata = await changes(`${BOOTSTRAP}&limit=1`);
    const first = await changes(`/api/units?cursor=${metadata.cursor}&limit=1`);
    const second = await changes(`/api/units?cursor=${first.cursor}&limit=1`);
    replica.apply([...first.changes, ...second.changes]);
    replica.observations.set("saved-private-sample", "100");
    replica.observations.set("saved-public-sample", "200");
    await withdraw("100");
    const token = await recovery(`/api/units?cursor=${second.cursor}`);
    const pending = f.codec.decode(token);
    expect(pending.position).toEqual(f.codec.decode(second.cursor).position);
    expect(pending.privacy).toBeUndefined();
    const firstRemoval = await removals(token);
    expect(firstRemoval.removals).toEqual([
      { type: "post_remove", post_id: "100", reason: "not_available" },
    ]);
    expect(firstRemoval.has_more).toBe(true);
    expect(f.codec.decode(firstRemoval.next_cursor ?? "").privacy).toBeUndefined();
    expect(await removals(token)).toEqual(firstRemoval);
    replica.remove(firstRemoval.removals);
    f.restart();
    const resumed = await finishRecovery(firstRemoval.next_cursor ?? "", replica);
    expect(replica.posts).toEqual(new Set(["200"]));
    expect(replica.stories).toEqual(new Set(["200"]));
    expect([...replica.observations.values()]).toEqual(["200"]);
    expect(resumed.path).toBe("/api/units");
    expect(f.codec.decode(resumed.cursor).position).toEqual(pending.position);
    const final = await finishChanges(`/api/units?cursor=${resumed.cursor}`, replica);
    expect(final.source).toBe(metadata.source);
    expect(replica.posts).toEqual(new Set(["200", "300"]));
    await finishChanges(`/api/changes?after=${final.cursor}`, replica);
    expect(replica.stories).toEqual(new Set(["200", "300"]));
  });

  it("finishes fixed removal ranges across new withdrawals, restoration, and restart", async () => {
    for (const id of ["100", "200", "300", "400"]) await f.post(consumerTweet(id));
    const replica = new Replica();
    const source = await finishChanges(BOOTSTRAP, replica);
    await withdraw("200");
    await withdraw("300");
    const token = await recovery(history(source.cursor));
    const first = await removals(token);
    const oldSource = first.source;
    replica.remove(first.removals);
    await withdraw("100"); // Sorts before the completed key in the first range.
    await f.post(consumerTweet("300", { captured_at: "2026-09-06T10:00:00.000Z" }));
    f.restart();
    let next = first.next_cursor ?? "";
    const removed: string[] = [...first.removals.map((r) => `${r.post_id}:${r.type}`)];
    const sources = new Set([oldSource]);
    let receipt = "";
    for (let n = 0; n < 20; n++) {
      const page = await removals(next);
      sources.add(page.source);
      removed.push(...page.removals.map((r) => `${r.post_id}:${r.type}`));
      replica.remove(page.removals);
      if (!page.has_more) {
        receipt = page.resume_cursor ?? "";
        break;
      }
      next = page.next_cursor ?? "";
    }
    expect(removed).toEqual([
      "200:post_remove",
      "200:unit_remove",
      "300:post_remove",
      "300:unit_remove",
      "100:post_remove",
      "100:unit_remove",
    ]);
    expect(sources.size).toBe(2);
    expect(replica.posts).toEqual(new Set(["400"]));
    expect(f.codec.decode(receipt).position.kind).toBe("history");
    const safe = consumerHistoryEnvelopeSchema.parse(
      await (await f.request(`/api/observations?cursor=${receipt}`)).json(),
    );
    expect(safe.observations).toEqual([]);
    const restored = await finishChanges(
      `/api/changes?after=${source.cursor}&reconciled=${receipt}`,
      replica,
    );
    expect(replica.posts).toEqual(new Set(["300", "400"]));
    expect(replica.stories).toEqual(new Set(["300", "400"]));
    expect(f.codec.decode(restored.cursor).privacy).toBeUndefined();
    expect([...replica.observations.values()]).toContain("300");
    expect([...replica.observations.values()]).not.toContain("100");
  });

  it("restores same-hash content after bootstrap recovery without rereading unrelated units", async () => {
    for (const id of ["100", "200", "300"]) await f.post(consumerTweet(id));
    const meta = await changes(BOOTSTRAP);
    const first = await changes(`/api/units?cursor=${meta.cursor}&limit=1`);
    const replica = new Replica();
    replica.apply(first.changes);
    await withdraw("100");
    const resumed = await finishRecovery(
      await recovery(`/api/units?cursor=${first.cursor}`),
      replica,
    );
    const source = await finishChanges(`/api/units?cursor=${resumed.cursor}`, replica);
    await f.post(consumerTweet("100", { captured_at: "2026-09-06T10:00:00.000Z" }));
    const before = f.codec.decode(source.cursor);
    const target = await f.options().contexts.pin({
      ...f.options().current(),
      selection: (await f.options().contexts.read(before.target)).context.selection,
      completeThrough: null,
      observationsThrough: null,
    });
    const base = await f.options().contexts.read(before.target);
    const privacy = await f.options().contexts.read(before.privacy ?? "");
    const read = vi.spyOn(HistoricalUnitReader.prototype, "read");
    const step = new ConsumerChangeEngine(f.index.store.database, target, base, privacy).step(
      { ...before, target: target.id, base: base.id, position: { kind: "content" } },
      1,
    );
    expect(step.changes[0]?.type).toBe("unit_upsert");
    expect(read.mock.calls.every((call) => JSON.stringify(call[0]) === '["100:a"]')).toBe(true);
    const firstUnit = first.changes.find((change) => change.type === "unit_upsert");
    expect(step.changes[0]).toMatchObject({ content_hash: firstUnit?.content_hash });
    await finishChanges(`/api/changes?after=${source.cursor}`, replica);
    expect(replica.posts).toEqual(new Set(["100", "200", "300"]));
  });

  it("stops an unfinished change activation, removes its accepted body, and resumes the fixed comparison", async () => {
    await f.post(consumerTweet("200"));
    const replica = new Replica();
    const source = await finishChanges(BOOTSTRAP, replica);
    await f.post(consumerTweet());
    const first = await changes(`/api/changes?after=${source.cursor}&limit=1`);
    replica.apply(first.changes);
    expect(f.codec.decode(first.cursor).position.kind).toBe("activation");
    await withdraw("100");
    const resumed = await finishRecovery(
      await recovery(`/api/changes?after=${first.cursor}`),
      replica,
    );
    expect(resumed.path).toBe("/api/changes");
    const final = await finishChanges(`/api/changes?after=${resumed.cursor}`, replica);
    expect(final.source).toBe(first.source);
    expect(replica.posts).toEqual(new Set(["200"]));
    expect(replica.stories).toEqual(new Set(["200"]));
    expect([...replica.observations.values()]).not.toContain("100");
  });

  it("keeps a public unit that reused an old unit ID after its withdrawn post moved", async () => {
    await f.post(consumerTweet());
    await f.post(consumerTweet("400"));
    const replica = new Replica();
    const source = await finishChanges(BOOTSTRAP, replica);
    await f.post(
      consumerTweet("100", { conversation_id: "500", captured_at: "2026-09-06T06:00:00.000Z" }),
    );
    await f.post(consumerTweet("200", { conversation_id: "100" }));
    const first = await changes(`/api/changes?after=${source.cursor}&limit=1`);
    replica.apply(first.changes);
    expect(replica.units.get("100:a")).toEqual(["200"]);
    await withdraw("100");
    const token = await recovery(`/api/changes?after=${first.cursor}`);
    const page = await removals(token, 500);
    expect(page.removals).toContainEqual({
      type: "unit_remove",
      unit_id: "100:a",
      post_id: "100",
      reason: "not_available",
    });
    expect(page.removals).toContainEqual({
      type: "unit_remove",
      unit_id: "500:a",
      post_id: "100",
      reason: "not_available",
    });
    replica.remove(page.removals);
    expect(replica.units.get("100:a")).toEqual(["200"]);
    expect(replica.stories).toEqual(new Set(["200", "400"]));
    await finishChanges(`/api/changes?after=${page.resume_cursor ?? ""}`, replica);
    expect(replica.posts).toEqual(new Set(["200", "400"]));
  });

  it("checks current privacy again if another withdrawal follows a completed recovery", async () => {
    for (const id of ["100", "200"]) await f.post(consumerTweet(id));
    const source = await finishChanges(BOOTSTRAP);
    await withdraw("100");
    const first = await finishRecovery(await recovery(history(source.cursor)));
    await withdraw("200");
    const second = await recovery(`/api/observations?cursor=${first.cursor}`);
    const page = await removals(second, 500);
    expect(page.removals.map((r) => r.post_id)).toEqual(["200", "200"]);
    expect(page.has_more).toBe(false);
  });

  it("rejects pending removal cursors and conflicting or unsigned completion receipts", async () => {
    await f.post(consumerTweet());
    const source = await finishChanges(BOOTSTRAP);
    await withdraw("100");
    const token = await recovery(history(source.cursor));
    for (const path of [
      `/api/units?cursor=${token}`,
      `/api/changes?after=${token}`,
      `/api/observations?cursor=${token}`,
      history(token),
      `/api/reconcile?cursor=${source.cursor}`,
      `/api/reconcile?cursor=${token}&author_ids=22`,
      `/api/reconcile?cursor=${token}&post_ids=100`,
      `/api/changes?after=${source.cursor}&reconciled=${token}`,
      `/api/changes?after=${source.cursor}&reconciled=unsigned`,
    ])
      expect((await f.request(path)).status, path).toBe(400);
    const receipt = await finishRecovery(token);
    expect(
      (await f.request(`/api/observations?cursor=${receipt.cursor}&reconciled=${receipt.cursor}`))
        .status,
    ).toBe(400);
    expect((await f.request(history(source.cursor) + `&reconciled=${receipt.cursor}`)).status).toBe(
      200,
    );
    const other = await finishChanges("/api/units?author_ids=22&publication=public-original");
    expect(
      (await f.request(`/api/changes?after=${other.cursor}&reconciled=${receipt.cursor}`)).status,
    ).toBe(400);
  });

  it("requires current unit scope on every removal page and does not extend its lease", async () => {
    await f.post(consumerTweet());
    const source = await finishChanges(BOOTSTRAP);
    await withdraw("100");
    const token = await recovery(history(source.cursor));
    const limited = await f.accounts.issue("operator", "taxonomy-only", ["taxonomy:read"]);
    expect(
      (
        await f.request(`/api/reconcile?cursor=${token}`, {
          authorization: `Bearer ${limited.token}`,
        })
      ).status,
    ).toBe(403);
    const ids = await f.accounts.issue("operator", "removals", ["units:read"]);
    expect(
      (await f.request(`/api/reconcile?cursor=${token}`, { authorization: `Bearer ${ids.token}` }))
        .status,
    ).toBe(200);
    await f.accounts.revoke("operator", ids.account.id);
    expect(
      (await f.request(`/api/reconcile?cursor=${token}`, { authorization: `Bearer ${ids.token}` }))
        .status,
    ).toBe(401);
    f.advanceTime(PAGE_LEASE_MS);
    const expired = await f.request(`/api/reconcile?cursor=${token}`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).not.toContain('"cursor":');
  });

  it("does not reconstruct bodies for removal pages or acknowledge a timeout", async () => {
    await f.post(consumerTweet());
    const source = await finishChanges(BOOTSTRAP);
    await withdraw("100");
    const token = await recovery(history(source.cursor));
    const cursor = f.codec.decode(token);
    const target = await f.options().contexts.read(cursor.target);
    const checkpoint = await f.options().contexts.read(cursor.reconciliation?.target ?? "");
    const read = vi.spyOn(HistoricalUnitReader.prototype, "read");
    const effects = new ConsumerPrivacyEffects(
      f.index.store.database,
      [target],
      [target],
      checkpoint,
    );
    expect(effects.page(500).removals).toHaveLength(2);
    expect(read).not.toHaveBeenCalled();
    vi.spyOn(f.options().contexts, "read").mockImplementation(
      () =>
        new Promise(() => {
          /* Deliberately stalled source read. */
        }),
    );
    f.setRuntime(new ConsumerRuntime({ ...f.options(), deadlineMs: 20 }));
    const timeout = await f.request(`/api/reconcile?cursor=${token}`);
    expect(timeout.status).toBe(503);
    expect(await timeout.text()).not.toContain('"cursor":');
  });

  it("bounds removal pages at 500 records and preserves exact IDs across all pages", async () => {
    const ids = Array.from({ length: 260 }, (_, i) => String(1000 + i));
    await f.postMany(ids.map((id) => consumerTweet(id)));
    const source = await finishChanges(BOOTSTRAP);
    await f.postMany(
      ids.map((id) =>
        consumerTweet(id, { is_subscriber_only: true, captured_at: "2026-09-06T08:00:00.000Z" }),
      ),
      false,
    );
    const token = await recovery(history(source.cursor));
    expect((await f.request(`/api/reconcile?cursor=${token}&limit=501`)).status).toBe(400);
    const defaultResponse = await f.request(`/api/reconcile?cursor=${token}`);
    const defaultPage = consumerReconciliationEnvelopeSchema.parse(await defaultResponse.json());
    expect(defaultPage.removals).toHaveLength(200);
    const first = await removals(token, 500);
    expect(first.removals).toHaveLength(500);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(2 * 1_048_576);
    expect(first.resume_cursor).toBeNull();
    const last = await removals(first.next_cursor ?? "", 500);
    expect(last.removals).toHaveLength(20);
    expect(last.has_more).toBe(false);
    expect(
      [...first.removals, ...last.removals]
        .filter((r) => r.type === "post_remove")
        .map((r) => r.post_id),
    ).toEqual(ids);
  });

  it("checks revocation again after a removal worker finishes", async () => {
    await f.post(consumerTweet());
    const source = await finishChanges(BOOTSTRAP);
    await withdraw("100");
    const token = await recovery(history(source.cursor));
    const run = f.workers.run.bind(f.workers);
    vi.spyOn(f.workers, "run").mockImplementation(async (task, signal) => {
      const result = await run(task, signal);
      if (task.operation === "reconcile")
        await f.accounts.revoke("operator", f.credential.account.id);
      return result;
    });
    const response = await f.request(`/api/reconcile?cursor=${token}`);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('"cursor":');
  });

  it("returns an empty next range for unrelated writes without moving the original page position", async () => {
    await f.post(consumerTweet());
    const source = await finishChanges(BOOTSTRAP);
    await withdraw("100");
    const token = await recovery(history(source.cursor));
    const first = await removals(token);
    await f.post(consumerTweet("200"));
    const endOfRange = await removals(first.next_cursor ?? "");
    expect(endOfRange.has_more).toBe(true);
    expect(endOfRange.resume_cursor).toBeNull();
    const empty = await removals(endOfRange.next_cursor ?? "");
    expect(empty.removals).toEqual([]);
    expect(empty.has_more).toBe(false);
    expect(f.codec.decode(empty.resume_cursor ?? "").position).toEqual(
      f.codec.decode(token).position,
    );
    const receipt = empty.resume_cursor ?? "";
    const safe = await finishChanges(`/api/changes?after=${source.cursor}&reconciled=${receipt}`);
    expect(safe.has_more).toBe(false);
  });

  it("keeps long history recovery cursors bounded and bound to all 100 requested IDs", async () => {
    const ids = Array.from({ length: 100 }, (_, i) =>
      (10000000000000000000n + BigInt(i)).toString(),
    );
    await f.post(consumerTweet(ids[0]));
    const source = await finishChanges(BOOTSTRAP);
    await withdraw(ids[0] ?? "");
    const token = await recovery(
      history(source.cursor).replace("post_ids=100&", `post_ids=${ids.join(",")}&`),
    );
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(8192);
    const receipt = await finishRecovery(token);
    expect(f.codec.decode(receipt.cursor).position).toMatchObject({
      kind: "history",
      post_ids: ids,
    });
    expect(
      (await f.request(`/api/observations?cursor=${receipt.cursor}&post_ids=100`)).status,
    ).toBe(400);
  });
});
