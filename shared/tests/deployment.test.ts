import { describe, expect, it } from "vitest";

import { DEPLOYMENT_MANIFEST_PATH, deploymentManifestSchema } from "../src/deployment.js";

describe("deployment manifest", () => {
  it("accepts one exact Git source revision", () => {
    expect(DEPLOYMENT_MANIFEST_PATH).toBe(".xtap-deployment.json");
    expect(deploymentManifestSchema.parse({ source_revision: "a".repeat(40) })).toEqual({
      source_revision: "a".repeat(40),
    });
  });

  it("rejects missing, malformed, and extended manifests", () => {
    expect(deploymentManifestSchema.safeParse({}).success).toBe(false);
    expect(deploymentManifestSchema.safeParse({ source_revision: "main" }).success).toBe(false);
    expect(
      deploymentManifestSchema.safeParse({
        source_revision: "a".repeat(40),
        secret: "must-not-pass",
      }).success,
    ).toBe(false);
  });
});
