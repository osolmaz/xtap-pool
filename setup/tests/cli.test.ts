import { describe, expect, it } from "vitest";

import { parseSetupCommand } from "../src/cli.js";

describe("setup CLI command parsing", () => {
  it("defaults to the interactive setup wizard", () => {
    expect(parseSetupCommand([])).toEqual({ kind: "setup" });
  });

  it("parses update mode with an optional Space repo and cutover report", () => {
    expect(parseSetupCommand(["update"])).toEqual({ kind: "update" });
    expect(parseSetupCommand(["update", "alice/xtap-pool"])).toEqual({
      kind: "update",
      spaceRepo: "alice/xtap-pool",
    });
    expect(
      parseSetupCommand([
        "update",
        "alice/xtap-pool",
        "--verified-bucket-cutover=/safe/report.json",
      ]),
    ).toEqual({
      kind: "update",
      spaceRepo: "alice/xtap-pool",
      cutoverReport: "/safe/report.json",
    });
  });

  it("parses doctor repair, canary, and activation flags", () => {
    expect(parseSetupCommand(["doctor"])).toEqual({
      kind: "doctor",
      json: false,
      fix: false,
      canary: false,
      enableSchedule: false,
    });
    expect(
      parseSetupCommand([
        "doctor",
        "alice/xtap-pool",
        "--json",
        "--fix",
        "--canary",
        "--resume-canary-job=job-1",
        "--approved-cost-ceiling-usd=500",
        "--enable-schedule",
      ]),
    ).toEqual({
      kind: "doctor",
      spaceRepo: "alice/xtap-pool",
      json: true,
      fix: true,
      canary: true,
      resumeCanaryJobId: "job-1",
      approvedCostCeilingUsd: 500,
      enableSchedule: true,
    });
  });

  it("rejects unknown commands and invalid arguments", () => {
    expect(() => parseSetupCommand(["deploy"])).toThrow("Unknown command");
    expect(() => parseSetupCommand(["update", "not-a-repo"])).toThrow("owner/name");
    expect(() => parseSetupCommand(["update", "alice/xtap-pool", "extra"])).toThrow("Usage");
    expect(() => parseSetupCommand(["update", "--verified-bucket-cutover="])).toThrow(
      "requires an import report path",
    );
    expect(() => parseSetupCommand(["doctor", "alice/xtap-pool", "extra"])).toThrow("Usage");
    expect(() => parseSetupCommand(["doctor", "--enable-schedule"])).toThrow("require --canary");
    expect(() => parseSetupCommand(["doctor", "--resume-canary-job=job-1"])).toThrow(
      "require --canary",
    );
    expect(() => parseSetupCommand(["doctor", "--approved-cost-ceiling-usd=500"])).toThrow(
      "require --canary",
    );
    expect(() =>
      parseSetupCommand(["doctor", "--canary", "--approved-cost-ceiling-usd=zero"]),
    ).toThrow("positive number");
    expect(() => parseSetupCommand(["doctor", "--canary", "--resume-canary-job="])).toThrow(
      "Invalid canary Job ID",
    );
  });
});
