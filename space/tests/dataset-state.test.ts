import { describe, expect, it } from "vitest";

import { datasetStateFromRebuildError } from "../src/dataset-state.js";

describe("dataset rebuild state", () => {
  it("classifies malformed dataset content as invalid rather than a credential failure", () => {
    expect(datasetStateFromRebuildError(new Error("invalid enrichment/vocabulary.json"))).toEqual({
      state: "invalid",
      error: "invalid enrichment/vocabulary.json",
    });
  });

  it("classifies timeouts, rate limits and Hub server errors as retryable unknown state", () => {
    for (const statusCode of [408, 425, 429]) {
      expect(
        datasetStateFromRebuildError(
          Object.assign(new Error(`transient ${String(statusCode)}`), { statusCode }),
        ),
      ).toEqual({ state: "unknown", error: `transient ${String(statusCode)}` });
    }
    expect(
      datasetStateFromRebuildError(
        Object.assign(new Error("Hub unavailable"), { statusCode: 503 }),
      ),
    ).toEqual({ state: "unknown", error: "Hub unavailable" });
    expect(datasetStateFromRebuildError(new TypeError("fetch failed"))).toEqual({
      state: "unknown",
      error: "fetch failed",
    });
  });
});
