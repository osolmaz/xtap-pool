import { describe, expect, it } from "vitest";

import { indexContractFromVariables } from "../src/wizard.js";

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

  it("uses setup defaults when an old Space has no explicit contract variables", () => {
    expect(indexContractFromVariables(new Map())).toEqual({
      llmModel: "zai-org/GLM-5.2:fireworks-ai",
      taxonomyVersion: "1",
    });
  });
});
