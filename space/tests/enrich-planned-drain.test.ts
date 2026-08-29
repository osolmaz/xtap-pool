import { describe, expect, it } from "vitest";

import { remainingWorkerCostUsd, runBoundedSuccessorDrain } from "../src/enrich-planned-command.js";

describe("bounded successor drain", () => {
  it("continues verified successors in one physical attempt", async () => {
    const budgets: { maxElapsedMs?: number; maxCostUsd?: number }[] = [];
    const results = [
      { providerCostUsd: 1.5, successorHasWork: true },
      { providerCostUsd: 2.25, successorHasWork: false },
    ];

    const result = await runBoundedSuccessorDrain({
      maxElapsedMs: 2_400_000,
      maxCostUsd: 10,
      maxCostPerCallUsd: 0.25,
      now: () => 1_000,
      run: (budget) => {
        budgets.push(budget);
        const next = results.shift();
        if (next === undefined) throw new Error("unexpected logical run");
        return Promise.resolve(next);
      },
    });

    expect(result).toEqual({ logicalRuns: 2, providerCostUsd: 3.75 });
    expect(budgets).toEqual([
      { commandStartedAtMs: 1_000, maxElapsedMs: 2_400_000, maxCostUsd: 10 },
      { commandStartedAtMs: 1_000, maxElapsedMs: 2_400_000, maxCostUsd: 8.5 },
    ]);
  });

  it("stops after the first zero-work successor", async () => {
    let calls = 0;
    const result = await runBoundedSuccessorDrain({
      maxElapsedMs: 2_400_000,
      maxCostUsd: 10,
      maxCostPerCallUsd: 0.25,
      now: () => 0,
      run: () => {
        calls += 1;
        return Promise.resolve({ providerCostUsd: 0, successorHasWork: false });
      },
    });

    expect(result).toEqual({ logicalRuns: 1, providerCostUsd: 0 });
    expect(calls).toBe(1);
  });

  it("does not enter a successor after the elapsed ceiling", async () => {
    let now = 0;
    let calls = 0;
    const result = await runBoundedSuccessorDrain({
      maxElapsedMs: 1_000,
      maxCostUsd: 10,
      maxCostPerCallUsd: 0.25,
      now: () => now,
      run: () => {
        calls += 1;
        now = 1_000;
        return Promise.resolve({ providerCostUsd: 1, successorHasWork: true });
      },
    });

    expect(result).toEqual({ logicalRuns: 1, providerCostUsd: 1 });
    expect(calls).toBe(1);
  });

  it("does not enter a successor without one call reservation", async () => {
    let calls = 0;
    const result = await runBoundedSuccessorDrain({
      maxCostUsd: 10,
      maxCostPerCallUsd: 0.25,
      now: () => 0,
      run: () => {
        calls += 1;
        return Promise.resolve({ providerCostUsd: 9.8, successorHasWork: true });
      },
    });

    expect(result).toEqual({ logicalRuns: 1, providerCostUsd: 9.8 });
    expect(calls).toBe(1);
  });

  it("runs logical plans serially without overlap", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    await runBoundedSuccessorDrain({
      maxCostUsd: 10,
      maxCostPerCallUsd: 0.25,
      now: () => 0,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls += 1;
        await Promise.resolve();
        active -= 1;
        return { providerCostUsd: 0, successorHasWork: calls === 1 };
      },
    });

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("propagates interruption without starting another logical run", async () => {
    let calls = 0;
    await expect(
      runBoundedSuccessorDrain({
        maxCostUsd: 10,
        maxCostPerCallUsd: 0.25,
        now: () => 0,
        run: () => {
          calls += 1;
          throw new Error("interrupted after durable boundary");
        },
      }),
    ).rejects.toThrow("interrupted after durable boundary");
    expect(calls).toBe(1);
  });

  it("rejects cost that exceeds the remaining physical-attempt budget", async () => {
    await expect(
      runBoundedSuccessorDrain({
        maxCostUsd: 1,
        maxCostPerCallUsd: 0.25,
        now: () => 0,
        run: () => Promise.resolve({ providerCostUsd: 1.01, successorHasWork: true }),
      }),
    ).rejects.toThrow("exceeded the remaining physical-attempt cost");
  });

  it.each([Number.NaN, -0.01])("rejects invalid reported provider cost %s", async (cost) => {
    await expect(
      runBoundedSuccessorDrain({
        maxCostUsd: 1,
        now: () => 0,
        run: () => Promise.resolve({ providerCostUsd: cost, successorHasWork: true }),
      }),
    ).rejects.toThrow("reported invalid provider cost");
  });

  it("continues without a configured cost ceiling or per-call reservation", async () => {
    let calls = 0;
    const result = await runBoundedSuccessorDrain({
      now: () => 0,
      run: (budget) => {
        calls += 1;
        expect(budget).toEqual({ commandStartedAtMs: 0 });
        return Promise.resolve({ providerCostUsd: 0, successorHasWork: calls === 1 });
      },
    });

    expect(result).toEqual({ logicalRuns: 2, providerCostUsd: 0 });
  });

  it("stops when a completed run consumes the exact cost ceiling", async () => {
    let calls = 0;
    const result = await runBoundedSuccessorDrain({
      maxCostUsd: 1,
      now: () => 0,
      run: () => {
        calls += 1;
        return Promise.resolve({ providerCostUsd: 1, successorHasWork: true });
      },
    });

    expect(result).toEqual({ logicalRuns: 1, providerCostUsd: 1 });
    expect(calls).toBe(1);
  });

  it("computes remaining physical-attempt cost without going negative", () => {
    expect(remainingWorkerCostUsd(undefined, 4)).toBeUndefined();
    expect(remainingWorkerCostUsd(10, 4)).toBe(6);
    expect(remainingWorkerCostUsd(10, 12)).toBe(0);
  });
});
