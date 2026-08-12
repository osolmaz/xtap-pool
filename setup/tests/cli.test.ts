import { describe, expect, it } from "vitest";

import { parseSetupCommand } from "../src/cli.js";

describe("setup CLI command parsing", () => {
  it("defaults to the interactive setup wizard", () => {
    expect(parseSetupCommand([])).toEqual({ kind: "setup" });
  });

  it("parses update mode with an optional Space repo", () => {
    expect(parseSetupCommand(["update"])).toEqual({ kind: "update", cutover: false });
    expect(parseSetupCommand(["update", "alice/xtap-pool"])).toEqual({
      kind: "update",
      spaceRepo: "alice/xtap-pool",
      cutover: false,
    });
    expect(parseSetupCommand(["update", "alice/xtap-pool", "--verified-bucket-cutover"])).toEqual({
      kind: "update",
      spaceRepo: "alice/xtap-pool",
      cutover: true,
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
        "--enable-schedule",
      ]),
    ).toEqual({
      kind: "doctor",
      spaceRepo: "alice/xtap-pool",
      json: true,
      fix: true,
      canary: true,
      resumeCanaryJobId: "job-1",
      enableSchedule: true,
    });
  });

  it("rejects unknown commands and invalid arguments", () => {
    expect(() => parseSetupCommand(["deploy"])).toThrow("Unknown command");
    expect(() => parseSetupCommand(["update", "not-a-repo"])).toThrow("owner/name");
    expect(() => parseSetupCommand(["update", "alice/xtap-pool", "extra"])).toThrow("Usage");
    expect(() => parseSetupCommand(["doctor", "alice/xtap-pool", "extra"])).toThrow("Usage");
    expect(() => parseSetupCommand(["doctor", "--enable-schedule"])).toThrow("require --canary");
    expect(() => parseSetupCommand(["doctor", "--resume-canary-job=job-1"])).toThrow(
      "require --canary",
    );
    expect(() => parseSetupCommand(["doctor", "--canary", "--resume-canary-job="])).toThrow(
      "Invalid canary Job ID",
    );
  });
});
