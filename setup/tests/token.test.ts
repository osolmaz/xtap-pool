import { describe, expect, it } from "vitest";

import { evaluateDatasetWriteToken } from "../src/token.js";

function whoami(scoped: readonly unknown[], role = "fineGrained"): unknown {
  return {
    name: "owner",
    auth: {
      accessToken: {
        displayName: "dataset-writer",
        role,
        fineGrained: { global: [], scoped },
      },
    },
  };
}

function scope(name: string, permissions: readonly string[], type = "dataset"): unknown {
  return { entity: { type, name }, permissions };
}

describe("dataset token verification", () => {
  it("accepts a fine-grained token scoped only to the dataset repo", () => {
    const report = evaluateDatasetWriteToken(
      whoami([scope("alice/xtap-pool-data", ["repo.content.read", "repo.content.write"])]),
      "alice/xtap-pool-data",
    );
    expect(report).toEqual({
      ok: true,
      username: "owner",
      tokenName: "dataset-writer",
      permissions: ["repo.content.read", "repo.content.write"],
    });
  });

  it("accepts the current HF selected-repo write permission shape", () => {
    const report = evaluateDatasetWriteToken(
      whoami([
        scope("alice/xtap-pool-data", ["repo.access.read", "repo.content.read", "repo.write"]),
      ]),
      "alice/xtap-pool-data",
    );
    expect(report).toEqual({
      ok: true,
      username: "owner",
      tokenName: "dataset-writer",
      permissions: ["repo.access.read", "repo.content.read", "repo.write"],
    });
  });

  it("accepts dataset entity names with a datasets prefix", () => {
    const report = evaluateDatasetWriteToken(
      whoami([scope("datasets/alice/xtap-pool-data", ["repo.content.read", "repo.content.write"])]),
      "alice/xtap-pool-data",
    );
    expect(report.ok).toBe(true);
  });

  it("rejects classic or broad tokens", () => {
    const report = evaluateDatasetWriteToken(
      whoami([scope("alice/xtap-pool-data", ["repo.content.write"])], "write"),
      "alice/xtap-pool-data",
    );
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.errors[0]).toContain("fine-grained");
  });

  it("rejects permissions outside the target dataset", () => {
    const report = evaluateDatasetWriteToken(
      whoami([
        scope("alice/xtap-pool-data", ["repo.content.write"]),
        scope("alice/other-dataset", ["repo.content.read"]),
      ]),
      "alice/xtap-pool-data",
    );
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.errors.join("\n")).toContain("outside alice/xtap-pool-data");
  });

  it("rejects same-name scopes on non-dataset entities", () => {
    const report = evaluateDatasetWriteToken(
      whoami([scope("alice/xtap-pool-data", ["repo.content.read", "repo.content.write"], "model")]),
      "alice/xtap-pool-data",
    );
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.errors.join("\n")).toContain("model:alice/xtap-pool-data");
  });

  it("rejects missing read, missing write, or unexpected target permissions", () => {
    const missingWrite = evaluateDatasetWriteToken(
      whoami([scope("alice/xtap-pool-data", ["repo.content.read"])]),
      "alice/xtap-pool-data",
    );
    const missingRead = evaluateDatasetWriteToken(
      whoami([scope("alice/xtap-pool-data", ["repo.content.write"])]),
      "alice/xtap-pool-data",
    );
    const unexpected = evaluateDatasetWriteToken(
      whoami([scope("alice/xtap-pool-data", ["repo.settings.write"])]),
      "alice/xtap-pool-data",
    );
    expect(missingRead.ok).toBe(false);
    expect(missingWrite.ok).toBe(false);
    expect(unexpected.ok).toBe(false);
  });
});
