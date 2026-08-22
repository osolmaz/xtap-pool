import { describe, expect, it } from "vitest";

import { consumeBatchesInOrder, mapBatchesInOrder } from "../src/bounded-concurrency.js";

describe("bounded concurrency", () => {
  it("reports an exact empty map", async () => {
    const progress: [number, number][] = [];
    await expect(
      mapBatchesInOrder({
        inputs: [],
        concurrency: 2,
        operation: (value: number) => Promise.resolve(value),
        progress: (completed, total) => {
          progress.push([completed, total]);
          return Promise.resolve();
        },
      }),
    ).resolves.toEqual([]);
    expect(progress).toEqual([[0, 0]]);
  });

  it("reports an exact empty consume", async () => {
    const progress: [number, number][] = [];
    await consumeBatchesInOrder({
      inputs: [],
      concurrency: 2,
      load: (value: number) => Promise.resolve(value),
      consume: () => Promise.resolve(),
      progress: (completed, total) => {
        progress.push([completed, total]);
        return Promise.resolve();
      },
    });
    expect(progress).toEqual([[0, 0]]);
  });

  it("rejects invalid concurrency before consuming input", async () => {
    for (const concurrency of [0, 1.5]) {
      await expect(
        consumeBatchesInOrder({
          inputs: [1],
          concurrency,
          load: (value) => Promise.resolve(value),
          consume: () => Promise.resolve(),
        }),
      ).rejects.toThrow("positive safe integer");
    }
  });
});
