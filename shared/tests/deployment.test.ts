import { describe, expect, it } from "vitest";

import {
  DEPLOYMENT_MANIFEST_PATH,
  deploymentManifestSchema,
  enrichmentRevisionHandoffSchema,
  serializeDeploymentManifest,
} from "../src/deployment.js";

const SOURCE_REVISION = "a".repeat(40);
const PLAN_REVISION = "b".repeat(40);
const SHA = "c".repeat(64);

function handoff() {
  return {
    active_generation: 29,
    activation_sha256: "1".repeat(64),
    run_id: "xtap-1321e3a40c38f32c0c210d8859622379",
    plan_sha256: "2".repeat(64),
    plan_worker_revision: PLAN_REVISION,
    target_worker_revision: SOURCE_REVISION,
    contract_sha256: "3".repeat(64),
    source_snapshot_revision: "4".repeat(64),
    checkpoint_pointer_sha256: "5".repeat(64),
    checkpoint_sequence: 807,
    checkpoint_key: `operations/enrichment/runs/run/checkpoints/sha256-${SHA}/checkpoint.hfjob`,
    checkpoint_sha256: SHA,
    checkpoint_bytes: 1234,
  };
}

describe("deployment manifest", () => {
  it("accepts direct revision equality through an explicit null handoff", () => {
    expect(DEPLOYMENT_MANIFEST_PATH).toBe(".xtap-deployment.json");
    expect(
      deploymentManifestSchema.parse({
        source_revision: SOURCE_REVISION,
        enrichment_revision_handoff: null,
      }),
    ).toEqual({
      source_revision: SOURCE_REVISION,
      enrichment_revision_handoff: null,
    });
  });

  it("accepts one exact immutable revision handoff", () => {
    expect(
      deploymentManifestSchema.parse({
        source_revision: SOURCE_REVISION,
        enrichment_revision_handoff: handoff(),
      }),
    ).toEqual({
      source_revision: SOURCE_REVISION,
      enrichment_revision_handoff: handoff(),
    });
  });

  it("serializes deterministic strict manifest bytes", () => {
    const value = {
      source_revision: SOURCE_REVISION,
      enrichment_revision_handoff: handoff(),
    };
    expect(serializeDeploymentManifest(value)).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(serializeDeploymentManifest(value)).toBe(serializeDeploymentManifest(value));
  });

  it("rejects missing, malformed, and extended manifests", () => {
    expect(deploymentManifestSchema.safeParse({ source_revision: SOURCE_REVISION }).success).toBe(
      false,
    );
    expect(
      deploymentManifestSchema.safeParse({
        source_revision: "main",
        enrichment_revision_handoff: null,
      }).success,
    ).toBe(false);
    expect(
      deploymentManifestSchema.safeParse({
        source_revision: SOURCE_REVISION,
        enrichment_revision_handoff: null,
        secret: "must-not-pass",
      }).success,
    ).toBe(false);
  });

  it("rejects target disagreement, self-handoffs, missing checkpoint identity, and extra revisions", () => {
    expect(
      deploymentManifestSchema.safeParse({
        source_revision: "d".repeat(40),
        enrichment_revision_handoff: handoff(),
      }).success,
    ).toBe(false);
    expect(
      enrichmentRevisionHandoffSchema.safeParse({
        ...handoff(),
        plan_worker_revision: SOURCE_REVISION,
      }).success,
    ).toBe(false);
    const { checkpoint_sha256: omitted, ...missingCheckpoint } = handoff();
    void omitted;
    expect(enrichmentRevisionHandoffSchema.safeParse(missingCheckpoint).success).toBe(false);
    expect(
      enrichmentRevisionHandoffSchema.safeParse({
        ...handoff(),
        accepted_predecessor_revisions: [PLAN_REVISION],
      }).success,
    ).toBe(false);
  });
});
