/* eslint-disable @typescript-eslint/require-await -- The in-memory store implements an asynchronous interface. */
import { describe, expect, it } from "vitest";

import type { CheckpointObjectStore } from "@osolmaz/hf-job-control";

import { withCheckpointClaimPrefetch } from "../src/enrich-checkpoint.js";

class DelayedStore implements CheckpointObjectStore {
  readonly bucketId = "owner/bucket";
  readonly files = new Map<string, Uint8Array>();
  readonly reads = new Map<string, number>();
  activeReads = 0;
  maxActiveReads = 0;

  async read(path: string): Promise<Uint8Array | null> {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    this.activeReads += 1;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return this.files.get(path) ?? null;
    } finally {
      this.activeReads -= 1;
    }
  }

  async writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, Uint8Array.from(bytes));
  }

  async writePointerHint(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, Uint8Array.from(bytes));
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

describe("checkpoint claim prefetch", () => {
  it("prefetches claims with bounded concurrency and serves coordinator reads from cache", async () => {
    const store = new DelayedStore();
    const prefix = "operations/enrichment/runs";
    const runId = "run";
    const claimsPrefix = `${prefix}/${runId}/checkpoints/claims/`;
    const keys = Array.from(
      { length: 18 },
      (_, index) => `${claimsPrefix}sequence-${String(index + 1).padStart(16, "0")}/attempt.json`,
    );
    for (const [index, key] of keys.entries()) {
      store.files.set(key, new TextEncoder().encode(String(index + 1)));
    }
    const observed: [number, number][] = [];
    const wrapped = withCheckpointClaimPrefetch(store, {
      runId,
      prefix,
      concurrency: 4,
      progress: async (completed, total) => {
        observed.push([completed, total]);
      },
    });

    expect(await wrapped.list(claimsPrefix)).toEqual(keys);
    for (const key of keys) expect(await wrapped.read(key)).not.toBeNull();

    expect(store.maxActiveReads).toBe(4);
    expect([...store.reads.values()]).toEqual(keys.map(() => 1));
    expect(observed).toEqual([
      [4, 18],
      [8, 18],
      [12, 18],
      [16, 18],
      [18, 18],
    ]);
  });
});
