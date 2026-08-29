import { describe, expect, it, vi } from "vitest";

import { remainingWorkerElapsedMs } from "../src/enrich-command.js";
import { verifyEnrichmentJobRevision } from "../src/enrich-job.js";

const REVISION = "a".repeat(40);

describe("Hugging Face enrichment Job entrypoint", () => {
  it("subtracts index restoration from the worker elapsed limit", () => {
    expect(remainingWorkerElapsedMs(2_400_000, 1_000, 601_000)).toBe(1_800_000);
    expect(remainingWorkerElapsedMs(2_400_000, 1_000, 3_001_000)).toBe(0);
    expect(remainingWorkerElapsedMs(undefined, 1_000, 601_000)).toBeUndefined();
  });

  it("accepts the exact embedded source revision", async () => {
    const manifest = {
      source_revision: REVISION,
      enrichment_revision_handoff: null,
    };
    const readText = vi.fn().mockResolvedValue(JSON.stringify(manifest));

    await expect(
      verifyEnrichmentJobRevision({ XTAP_SOURCE_REVISION: REVISION }, readText),
    ).resolves.toEqual(manifest);
    expect(readText).toHaveBeenCalledWith(".xtap-deployment.json");
  });

  it("fails before work when the expected revision is missing", async () => {
    const readText = vi.fn();

    await expect(verifyEnrichmentJobRevision({}, readText)).rejects.toThrow(
      "XTAP_SOURCE_REVISION is required",
    );
    expect(readText).not.toHaveBeenCalled();
  });

  it("rejects stale images and malformed manifests", async () => {
    await expect(
      verifyEnrichmentJobRevision({ XTAP_SOURCE_REVISION: REVISION }, () =>
        Promise.resolve(
          JSON.stringify({
            source_revision: "b".repeat(40),
            enrichment_revision_handoff: null,
          }),
        ),
      ),
    ).rejects.toThrow("Job source revision mismatch");

    await expect(
      verifyEnrichmentJobRevision({ XTAP_SOURCE_REVISION: REVISION }, () =>
        Promise.resolve(
          JSON.stringify({ source_revision: "main", enrichment_revision_handoff: null }),
        ),
      ),
    ).rejects.toThrow();
  });
});
