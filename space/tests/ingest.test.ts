import { describe, expect, it } from "vitest";

import { Mutex, prepareIngest } from "../src/ingest.js";
import { makeTweet } from "./helpers.js";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const POOLED_AT = new Date("2026-07-06T11:00:00.000Z");

describe("prepareIngest", () => {
  it("stamps verified attribution over client-supplied values", () => {
    const prepared = prepareIngest(
      [{ ...makeTweet(), contributed_by: "mallory", pooled_at: "2020-01-01T00:00:00.000Z" }],
      "osolmaz",
      POOLED_AT,
      NOW,
    );
    expect(prepared.rejected).toEqual([]);
    expect(prepared.stamped).toEqual([
      expect.objectContaining({ contributed_by: "osolmaz", pooled_at: POOLED_AT.toISOString() }),
    ]);
  });

  it("rejects invalid candidates by index and keeps the valid ones", () => {
    const prepared = prepareIngest([{ id: 1 }, makeTweet({ id: "2" })], "osolmaz", POOLED_AT, NOW);
    expect(prepared.stamped.map((tweet) => tweet.id)).toEqual(["2"]);
    expect(prepared.rejected).toEqual([{ index: 0, reason: expect.any(String) as string }]);
  });

  it("rejects a future observation without preventing a valid delayed observation", () => {
    const prepared = prepareIngest(
      [
        makeTweet({ captured_at: "2026-07-06T12:05:00.001Z" }),
        makeTweet({ captured_at: "2026-07-01T00:00:00Z" }),
      ],
      "osolmaz",
      POOLED_AT,
      NOW,
    );
    expect(prepared.stamped).toHaveLength(1);
    expect(prepared.rejected).toEqual([
      { index: 0, reason: "captured_at is more than five minutes in the future" },
    ]);
  });

  it("accepts an observation exactly five minutes ahead", () => {
    const prepared = prepareIngest(
      [makeTweet({ captured_at: "2026-07-06T12:05:00.000Z" })],
      "osolmaz",
      POOLED_AT,
      NOW,
    );
    expect(prepared.rejected).toEqual([]);
  });
});

describe("Mutex", () => {
  it("serializes critical sections in order, surviving rejections", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const slow = mutex.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow");
      return "slow";
    });
    const failing = mutex.run(() => {
      order.push("failing");
      return Promise.reject(new Error("boom"));
    });
    const fast = mutex.run(() => {
      order.push("fast");
      return Promise.resolve("fast");
    });
    await expect(slow).resolves.toBe("slow");
    await expect(failing).rejects.toThrow("boom");
    await expect(fast).resolves.toBe("fast");
    expect(order).toEqual(["slow", "failing", "fast"]);
  });
});
