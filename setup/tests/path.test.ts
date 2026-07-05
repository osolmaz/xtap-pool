import { describe, expect, it } from "vitest";

import { expandHomePath } from "../src/path.js";

describe("setup path helpers", () => {
  it("expands leading home paths", () => {
    expect(expandHomePath("~", "/home/alice")).toBe("/home/alice");
    expect(expandHomePath("~/xtap-store/data/tweets", "/home/alice")).toBe(
      "/home/alice/xtap-store/data/tweets",
    );
    expect(expandHomePath("/tmp/tweets", "/home/alice")).toBe("/tmp/tweets");
  });
});
