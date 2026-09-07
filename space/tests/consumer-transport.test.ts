import { afterEach, expect, it, vi } from "vitest";
import { createDurableIndexBucketClient } from "../src/durable-index.js";
import { createRawBucketClient } from "../src/bucket-log.js";
import { withConsumerDeadline, consumerFetch } from "../src/consumer-deadline.js";
import { serializedConsumerResponse } from "../src/consumer-runtime.js";
import { HARD_PAGE_BYTES } from "../src/consumer-page.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(["context", "snapshot"])(
  "passes cancellation through the real %s Bucket read adapter",
  async (kind) => {
    const calls: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null)
            throw new Error("adapter omitted its signal");
          calls.push(signal);
          signal.addEventListener("abort", () => {
            reject(new Error("fixture aborted"));
          });
        }),
    );
    const index = createDurableIndexBucketClient("owner/index", "hf_fixture", consumerFetch);
    const raw = createRawBucketClient("owner/raw", "hf_fixture", consumerFetch);
    await expect(
      withConsumerDeadline<unknown>(
        () =>
          kind === "context"
            ? index.readText("index/consumer-contexts/fixture.json")
            : raw.download("v1/snapshots/fixture.json"),
        new AbortController().signal,
        20,
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.aborted).toBe(true);
  },
);

it("checks actual UTF-8 bytes, including envelope overhead, before returning a page", async () => {
  const boundary = { value: "é".repeat((HARD_PAGE_BYTES - 12) / 2) };
  const response = serializedConsumerResponse(boundary);
  expect(Buffer.byteLength(await response.text())).toBe(HARD_PAGE_BYTES);
  expect(() => serializedConsumerResponse({ value: boundary.value + "x" })).toThrow(/byte bound/);
});
