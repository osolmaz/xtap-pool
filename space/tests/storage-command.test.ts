import { describe, expect, it } from "vitest";

import { parseStorageArguments } from "../src/storage-command.js";

describe("storage command arguments", () => {
  it("parses the complete migration contract", () => {
    expect(
      parseStorageArguments([
        "--dataset",
        "osolmaz/xtap-pool-data",
        "--revision",
        "a".repeat(40),
        "--raw-bucket",
        "osolmaz/xtap-pool-data",
        "--report",
        "/tmp/report.json",
        "--work-dir",
        "/tmp/work",
      ]),
    ).toEqual({
      dataset: "osolmaz/xtap-pool-data",
      revision: "a".repeat(40),
      rawBucket: "osolmaz/xtap-pool-data",
      report: "/tmp/report.json",
      workDir: "/tmp/work",
    });
  });

  it("rejects incomplete, missing, and malformed arguments", () => {
    expect(() => parseStorageArguments(["dataset", "value"])).toThrow("expected --dataset");
    expect(() => parseStorageArguments(["--dataset"])).toThrow("expected --dataset");
    expect(() => parseStorageArguments(["--dataset", "value"])).toThrow("--revision is required");
    expect(() =>
      parseStorageArguments([
        "--dataset",
        "value",
        "--revision",
        "value",
        "--raw-bucket",
        "value",
        "--report",
        "",
        "--work-dir",
        "value",
      ]),
    ).toThrow("--report is required");
  });
});
