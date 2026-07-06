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

  it("rejects unknown commands and invalid update arguments", () => {
    expect(() => parseSetupCommand(["deploy"])).toThrow("Unknown command");
    expect(() => parseSetupCommand(["update", "not-a-repo"])).toThrow("owner/name");
    expect(() => parseSetupCommand(["update", "alice/xtap-pool", "extra"])).toThrow("Usage");
  });
});
