import { describe, expect, it } from "vitest";

import { defaultTweetsDirectory, expandHomePath } from "../src/path.js";

describe("setup path helpers", () => {
  it("expands leading home paths", () => {
    expect(expandHomePath("~", "/home/alice")).toBe("/home/alice");
    expect(expandHomePath("~/Downloads/xtap", "/home/alice")).toBe("/home/alice/Downloads/xtap");
    expect(expandHomePath("/tmp/tweets", "/home/alice")).toBe("/tmp/tweets");
  });

  it("defaults to the vendored xTap output directory", () => {
    expect(defaultTweetsDirectory("/home/alice")).toBe("/home/alice/Downloads/xtap");
  });
});
