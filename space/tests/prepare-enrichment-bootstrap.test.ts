import { describe, expect, it, vi } from "vitest";

import { bucketSnapshotSchema } from "../src/bucket-log.js";
import { DEFAULT_TAXONOMY } from "../src/enrich-config.js";
import { resolveEnrichmentTaxonomyForContract } from "../src/enrich-taxonomy-contract.js";
import { contractHashFor } from "../src/enrich-worker.js";

const MODEL = "zai-org/GLM-5.2:fireworks-ai";
const SNAPSHOT = bucketSnapshotSchema.parse({
  schema_version: 1,
  bucket: "osolmaz/xtap-pool-data",
  files: [],
});

describe("resolveEnrichmentTaxonomyForContract", () => {
  it("validates the latest default taxonomy before accepting its contract", async () => {
    const primeTextCacheFromLatestWrites = vi.fn(() => Promise.resolve());
    const readText = vi.fn(() => Promise.resolve(undefined));
    const progress: [number, number][] = [];
    const expectedContractHash = contractHashFor({
      taxonomy: { labels: DEFAULT_TAXONOMY, version: 1, source: "default" },
      model: MODEL,
    });

    const resolved = await resolveEnrichmentTaxonomyForContract({
      log: { primeTextCacheFromLatestWrites, readText },
      snapshot: SNAPSHOT,
      taxonomyVersion: 1,
      llmModel: MODEL,
      expectedContractHash,
      concurrency: 16,
      progress: (completed, total) => {
        progress.push([completed, total]);
        return Promise.resolve();
      },
    });

    expect(primeTextCacheFromLatestWrites).toHaveBeenCalledWith(SNAPSHOT, 16, expect.any(Function));
    expect(readText).toHaveBeenCalledWith("config/labels.json", undefined);
    expect(resolved.contractHash).toBe(expectedContractHash);
    expect(resolved.taxonomy).toMatchObject({ source: "default", version: 1 });
  });

  it("validates the latest custom taxonomy", async () => {
    const labels = [{ name: "custom", description: "Custom label." }];
    const expectedContractHash = contractHashFor({
      taxonomy: { labels, version: 1, source: "bucket" },
      model: MODEL,
    });
    const primeTextCacheFromLatestWrites = vi.fn(() => Promise.resolve());
    const readText = vi.fn(() => Promise.resolve(JSON.stringify(labels)));

    const resolved = await resolveEnrichmentTaxonomyForContract({
      log: { primeTextCacheFromLatestWrites, readText },
      snapshot: SNAPSHOT,
      taxonomyVersion: 1,
      llmModel: MODEL,
      expectedContractHash,
      concurrency: 4,
    });

    expect(primeTextCacheFromLatestWrites).toHaveBeenCalledWith(SNAPSHOT, 4, undefined);
    expect(resolved).toMatchObject({ contractHash: expectedContractHash });
    expect(resolved.taxonomy.labels).toEqual(labels);
  });

  it("rejects a source taxonomy that disagrees with the authenticated contract", async () => {
    const labels = [{ name: "custom", description: "Custom label." }];
    const expectedContractHash = contractHashFor({
      taxonomy: { labels: DEFAULT_TAXONOMY, version: 1, source: "default" },
      model: MODEL,
    });

    await expect(
      resolveEnrichmentTaxonomyForContract({
        log: {
          primeTextCacheFromLatestWrites: () => Promise.resolve(),
          readText: () => Promise.resolve(JSON.stringify(labels)),
        },
        snapshot: SNAPSHOT,
        taxonomyVersion: 1,
        llmModel: MODEL,
        expectedContractHash,
        concurrency: 4,
      }),
    ).rejects.toThrow("taxonomy-derived contract does not match the authenticated contract");
  });
});
