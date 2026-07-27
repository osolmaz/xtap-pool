import { describe, expect, it } from "vitest";

import { unitHasSubstantiveText, validateFreeLabelName } from "../src/free-label-rules.js";

describe("free-label rules boundaries", () => {
  it("rejects empty, short, long, and ungrounded labels before lifecycle processing", () => {
    const evidence = [{ tweet_id: "1", quote: "model release" }];
    expect(validateFreeLabelName("", evidence)).toMatchObject({ reason: "empty-slug" });
    expect(validateFreeLabelName("a", evidence)).toMatchObject({ reason: "too-short" });
    expect(validateFreeLabelName("a".repeat(61), evidence)).toMatchObject({ reason: "too-long" });
    expect(validateFreeLabelName("model", [])).toMatchObject({ reason: "no-evidence" });
    expect(validateFreeLabelName("model", [{ tweet_id: "1", quote: "  " }])).toMatchObject({
      reason: "unsubstantive-evidence",
    });
    expect(validateFreeLabelName("model", [{ tweet_id: "1", quote: "!!!" }])).toMatchObject({
      reason: "unsubstantive-evidence",
    });
  });

  it("does not treat emoji or punctuation as a substantive subject", () => {
    expect(unitHasSubstantiveText("🎉!!!")).toBe(false);
    expect(unitHasSubstantiveText("new model")).toBe(true);
  });

  it("permits an abstract name only when every grounded quote contains its literal stem", () => {
    expect(
      validateFreeLabelName("manufacturing", [{ tweet_id: "1", quote: "manufacturing update" }]),
    ).toEqual({ ok: true });
    expect(
      validateFreeLabelName("manufacturing", [{ tweet_id: "1", quote: "hardware update" }]),
    ).toMatchObject({ reason: "abstract-name-without-literal:manufacturing" });
  });
});
