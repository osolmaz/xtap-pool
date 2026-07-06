import { describe, expect, it } from "vitest";

import { captureCommand, inheritCommand } from "../src/process.js";

describe("process helpers", () => {
  it("captures stdout and stderr from a successful command", async () => {
    const result = await captureCommand(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err');",
    ]);

    expect(result).toEqual({ stdout: "out", stderr: "err" });
  });

  it("inherits stdio for a successful command", async () => {
    await expect(inheritCommand(process.execPath, ["-e", ""])).resolves.toBeUndefined();
  });

  it("rejects failed commands", async () => {
    await expect(captureCommand(process.execPath, ["-e", "process.exit(7);"])).rejects.toThrow(
      `${process.execPath} -e process.exit(7); exited with 7`,
    );
  });
});
