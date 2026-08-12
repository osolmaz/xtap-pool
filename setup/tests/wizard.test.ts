import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertCutoverReport, indexContractFromVariables } from "../src/wizard.js";

describe("index bootstrap contract", () => {
  it("uses the existing Space model and taxonomy during update migration", () => {
    expect(
      indexContractFromVariables(
        new Map([
          ["LLM_MODEL", "custom/model"],
          ["TAXONOMY_VERSION", "7"],
        ]),
      ),
    ).toEqual({ llmModel: "custom/model", taxonomyVersion: "7" });
  });

  it("accepts only exact passing cutover reports for the target Bucket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtap-cutover-report-"));
    const path = join(directory, "report.json");
    await writeFile(
      path,
      JSON.stringify({
        target: { bucket: "alice/xtap-pool-data", snapshot_revision: "a".repeat(64), objects: 4 },
        reconciliation: { passed: true },
      }),
    );
    await expect(assertCutoverReport(path, "alice/xtap-pool-data")).resolves.toBeUndefined();
    await expect(assertCutoverReport(path, "alice/other")).rejects.toThrow("does not prove");
    await expect(
      assertCutoverReport(join(directory, "missing"), "alice/xtap-pool-data"),
    ).rejects.toThrow("unreadable");
  });

  it("uses setup defaults when an old Space has no explicit contract variables", () => {
    expect(indexContractFromVariables(new Map())).toEqual({
      llmModel: "zai-org/GLM-5.2:fireworks-ai",
      taxonomyVersion: "1",
    });
  });
});
