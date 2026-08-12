import { describe, expect, it } from "vitest";

import { storageStateFromRebuildError } from "../src/storage-state.js";

describe("storage rebuild state", () => {
  it("classifies malformed storage content as invalid rather than a credential failure", () => {
    expect(storageStateFromRebuildError(new Error("invalid enrichment/vocabulary.json"))).toEqual({
      state: "invalid",
      error: "invalid enrichment/vocabulary.json",
    });
  });

  it("classifies timeouts, rate limits and Hub server errors as retryable unknown state", () => {
    for (const statusCode of [408, 425, 429]) {
      expect(
        storageStateFromRebuildError(
          Object.assign(new Error(`transient ${String(statusCode)}`), { statusCode }),
        ),
      ).toEqual({ state: "unknown", error: `transient ${String(statusCode)}` });
    }
    expect(
      storageStateFromRebuildError(
        Object.assign(new Error("Hub unavailable"), { statusCode: 503 }),
      ),
    ).toEqual({ state: "unknown", error: "Hub unavailable" });
    expect(storageStateFromRebuildError(new TypeError("fetch failed"))).toEqual({
      state: "unknown",
      error: "fetch failed",
    });
    expect(storageStateFromRebuildError("non-error rejection")).toEqual({
      state: "invalid",
      error: "unknown error",
    });
  });
});
