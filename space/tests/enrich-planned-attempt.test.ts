import { describe, expect, it, vi } from "vitest";

import { runSinglePlannedEnrichmentAttempt } from "../src/enrich-planned-command.js";

describe("planned enrichment attempt", () => {
  it("runs one logical plan even when the verified successor has work", async () => {
    const run = vi.fn(() => Promise.resolve({ providerCostUsd: 1.5, successorHasWork: true }));

    await expect(
      runSinglePlannedEnrichmentAttempt({
        commandStartedAtMs: 1_000,
        maxElapsedMs: 2_400_000,
        maxCostUsd: 10,
        run,
      }),
    ).resolves.toEqual({ providerCostUsd: 1.5, successorHasWork: true });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith({
      commandStartedAtMs: 1_000,
      maxElapsedMs: 2_400_000,
      maxCostUsd: 10,
    });
  });

  it("keeps optional limits absent", async () => {
    const run = vi.fn(() => Promise.resolve({ providerCostUsd: 0, successorHasWork: false }));

    await runSinglePlannedEnrichmentAttempt({
      commandStartedAtMs: 2_000,
      run,
    });

    expect(run).toHaveBeenCalledWith({ commandStartedAtMs: 2_000 });
  });

  it("propagates an interrupted logical run without starting another", async () => {
    const error = new Error("interrupted after durable boundary");
    const run = vi.fn(() => Promise.reject(error));

    await expect(
      runSinglePlannedEnrichmentAttempt({
        commandStartedAtMs: 3_000,
        maxElapsedMs: 2_400_000,
        maxCostUsd: 10,
        run,
      }),
    ).rejects.toBe(error);
    expect(run).toHaveBeenCalledOnce();
  });
});
