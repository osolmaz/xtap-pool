import { describe, expect, it } from "vitest";

import { parseSetupCommand } from "../src/cli.js";

describe("setup CLI command parsing", () => {
  it("defaults to the interactive setup wizard", () => {
    expect(parseSetupCommand([])).toEqual({ kind: "setup" });
  });

  it("parses update mode with an optional Space repo", () => {
    expect(parseSetupCommand(["update"])).toEqual({ kind: "update" });
    expect(parseSetupCommand(["update", "alice/xtap-pool"])).toEqual({
      kind: "update",
      spaceRepo: "alice/xtap-pool",
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
        "--enable-schedule",
      ]),
    ).toEqual({
      kind: "doctor",
      spaceRepo: "alice/xtap-pool",
      json: true,
      fix: true,
      canary: true,
      enableSchedule: true,
    });
  });

  it("rejects unknown commands and invalid arguments", () => {
    expect(() => parseSetupCommand(["deploy"])).toThrow("Unknown command");
    expect(() => parseSetupCommand(["update", "not-a-repo"])).toThrow("owner/name");
    expect(() => parseSetupCommand(["update", "alice/xtap-pool", "extra"])).toThrow("Usage");
    expect(() => parseSetupCommand(["doctor", "alice/xtap-pool", "extra"])).toThrow("Usage");
    expect(() => parseSetupCommand(["doctor", "--enable-schedule"])).toThrow("requires --canary");
  });
});
