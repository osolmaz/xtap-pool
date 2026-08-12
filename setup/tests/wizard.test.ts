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

  it("accepts only exact passing cutover reports for the current source and target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xtap-cutover-report-"));
    const path = join(directory, "report.json");
    const revision = "b".repeat(40);
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        source: { dataset: "alice/xtap-pool-data", revision, objects: 3 },
        target: { bucket: "alice/xtap-pool-data", snapshot_revision: "a".repeat(64), objects: 4 },
        reconciliation: { passed: true },
      }),
    );
    await expect(
      assertCutoverReport(path, "alice/xtap-pool-data", "alice/xtap-pool-data", () =>
        Promise.resolve(revision),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertCutoverReport(path, "alice/other", "alice/xtap-pool-data", () =>
        Promise.resolve(revision),
      ),
    ).rejects.toThrow("does not prove");
    await expect(
      assertCutoverReport(path, "alice/xtap-pool-data", "alice/other", () =>
        Promise.resolve(revision),
      ),
    ).rejects.toThrow("does not prove");
    for (const invalid of [
      { schema_version: 2 },
      { reconciliation: { passed: false } },
      { source: { revision: "short" } },
      { source: { objects: 0 } },
      { target: { snapshot_revision: "short" } },
      { target: { objects: 0 } },
    ]) {
      await writeFile(
        path,
        JSON.stringify({
          schema_version: 1,
          source: { dataset: "alice/xtap-pool-data", revision, objects: 3 },
          target: {
            bucket: "alice/xtap-pool-data",
            snapshot_revision: "a".repeat(64),
            objects: 4,
          },
          reconciliation: { passed: true },
          ...invalid,
        }),
      );
      await expect(
        assertCutoverReport(path, "alice/xtap-pool-data", "alice/xtap-pool-data", () =>
          Promise.resolve(revision),
        ),
      ).rejects.toThrow("does not prove");
    }
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        source: { dataset: "alice/xtap-pool-data", revision, objects: 3 },
        target: { bucket: "alice/xtap-pool-data", snapshot_revision: "a".repeat(64), objects: 4 },
        reconciliation: { passed: true },
      }),
    );
    await expect(
      assertCutoverReport(path, "alice/xtap-pool-data", "alice/xtap-pool-data", () =>
        Promise.resolve("c".repeat(40)),
      ),
    ).rejects.toThrow("current dataset revision");
    await expect(
      assertCutoverReport(
        join(directory, "missing"),
        "alice/xtap-pool-data",
        "alice/xtap-pool-data",
        () => Promise.resolve(revision),
      ),
    ).rejects.toThrow("unreadable");
  });

  it("uses setup defaults when an old Space has no explicit contract variables", () => {
    expect(indexContractFromVariables(new Map())).toEqual({
      llmModel: "zai-org/GLM-5.2:fireworks-ai",
      taxonomyVersion: "1",
    });
  });
});
