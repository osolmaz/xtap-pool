import { describe, expect, it, vi } from "vitest";

import { bucketSnapshotSchema } from "../src/bucket-log.js";
import { DEFAULT_TAXONOMY } from "../src/enrich-config.js";
import {
  resolveEnrichmentTaxonomyAfterTail,
  resolveEnrichmentTaxonomyForContract,
} from "../src/enrich-taxonomy-contract.js";
import { contractHashFor } from "../src/enrich-worker.js";

const MODEL = "zai-org/GLM-5.2:fireworks-ai";
const SNAPSHOT = bucketSnapshotSchema.parse({
  schema_version: 1,
  bucket: "osolmaz/xtap-pool-data",
  files: [],
});

describe("resolveEnrichmentTaxonomyForContract", () => {
  it("accepts the authenticated default contract without reading historical configuration", async () => {
    const readText = vi.fn(() => Promise.reject(new Error("must not read")));
    const progress: [number, number][] = [];
    const expectedContractHash = contractHashFor({
      taxonomy: { labels: DEFAULT_TAXONOMY, version: 1, source: "default" },
      model: MODEL,
    });

    const resolved = await resolveEnrichmentTaxonomyForContract({
      log: { readText },
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

    expect(readText).not.toHaveBeenCalled();
    expect(resolved.contractHash).toBe(expectedContractHash);
    expect(resolved.taxonomy).toMatchObject({ source: "default", version: 1 });
    expect(progress).toEqual([[1, 1]]);
  });

  it("reads the exact snapshot when the manifest authenticates a custom taxonomy", async () => {
    const labels = [{ name: "custom", description: "Custom label." }];
    const expectedContractHash = contractHashFor({
      taxonomy: { labels, version: 1, source: "bucket" },
      model: MODEL,
    });
    const readText = vi.fn(() => Promise.resolve(JSON.stringify(labels)));

    const resolved = await resolveEnrichmentTaxonomyForContract({
      log: { readText },
      snapshot: SNAPSHOT,
      taxonomyVersion: 1,
      llmModel: MODEL,
      expectedContractHash,
      concurrency: 4,
    });

    expect(readText).toHaveBeenCalledWith(
      "config/labels.json",
      expect.objectContaining({ snapshot: SNAPSHOT, concurrency: 4 }),
    );
    expect(resolved).toMatchObject({ contractHash: expectedContractHash });
    expect(resolved.taxonomy.labels).toEqual(labels);
  });
});

describe("resolveEnrichmentTaxonomyAfterTail", () => {
  const baseTaxonomy = { labels: DEFAULT_TAXONOMY, version: 1, source: "default" as const };
  const expectedContractHash = contractHashFor({ taxonomy: baseTaxonomy, model: MODEL });

  it("retains the authenticated base taxonomy when the tail has no configuration segments", async () => {
    const readText = vi.fn(() => Promise.reject(new Error("must not read")));
    const progress: [number, number][] = [];

    const resolved = await resolveEnrichmentTaxonomyAfterTail({
      log: { readText },
      baseSnapshot: SNAPSHOT,
      finalSnapshot: SNAPSHOT,
      baseTaxonomy,
      taxonomyVersion: 1,
      llmModel: MODEL,
      expectedContractHash,
      concurrency: 16,
      progress: (completed, total) => {
        progress.push([completed, total]);
        return Promise.resolve();
      },
    });

    expect(readText).not.toHaveBeenCalled();
    expect(resolved.contractHash).toBe(expectedContractHash);
    expect(progress).toEqual([[0, 0]]);
  });

  it("rejects a custom taxonomy written in the post-index tail", async () => {
    const labels = [{ name: "custom", description: "Custom label." }];
    const time = Date.parse("2026-08-21T12:00:00.000Z");
    const tail = bucketSnapshotSchema.parse({
      schema_version: 1,
      bucket: SNAPSHOT.bucket,
      files: [
        {
          key: `v1/segments/mixed/2026/08/21/${time.toString()}-00000000-0000-4000-8000-000000000001-${"b".repeat(64)}.json.gz`,
          oid: "a".repeat(64),
          size: 1,
          content_sha256: "b".repeat(64),
        },
      ],
    });
    const readText = vi.fn(() => Promise.resolve(JSON.stringify(labels)));

    await expect(
      resolveEnrichmentTaxonomyAfterTail({
        log: { readText },
        baseSnapshot: SNAPSHOT,
        finalSnapshot: tail,
        baseTaxonomy,
        taxonomyVersion: 1,
        llmModel: MODEL,
        expectedContractHash,
        concurrency: 4,
      }),
    ).rejects.toThrow("post-snapshot taxonomy changes");
    expect(readText).toHaveBeenCalledWith(
      "config/labels.json",
      expect.objectContaining({ concurrency: 4 }),
    );
  });
});
