import { describe, expect, it, vi } from "vitest";

import { verifyEnrichmentJobRevision } from "../src/enrich-job.js";

const REVISION = "a".repeat(40);

describe("Hugging Face enrichment Job entrypoint", () => {
  it("accepts the exact embedded source revision", async () => {
    const readText = vi.fn().mockResolvedValue(JSON.stringify({ source_revision: REVISION }));

    await expect(
      verifyEnrichmentJobRevision({ XTAP_SOURCE_REVISION: REVISION }, readText),
    ).resolves.toBeUndefined();
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
        Promise.resolve(JSON.stringify({ source_revision: "b".repeat(40) })),
      ),
    ).rejects.toThrow("Job source revision mismatch");

    await expect(
      verifyEnrichmentJobRevision({ XTAP_SOURCE_REVISION: REVISION }, () =>
        Promise.resolve(JSON.stringify({ source_revision: "main" })),
      ),
    ).rejects.toThrow();
  });
});
