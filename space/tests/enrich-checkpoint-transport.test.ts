import { beforeEach, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => {
  class HubApiError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }

  class InvalidApiResponseFormatError extends Error {}

  return {
    downloadFile: vi.fn(),
    listFiles: vi.fn(),
    uploadFile: vi.fn(),
    HubApiError,
    InvalidApiResponseFormatError,
  };
});

vi.mock("@huggingface/hub", () => hub);

import { createReadOnlyEnrichmentCheckpointStore } from "../src/enrich-checkpoint.js";

beforeEach(() => {
  vi.resetAllMocks();
});

it("retries a transient checkpoint download and returns the bytes", async () => {
  const waits: number[] = [];
  hub.downloadFile
    .mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }))
    .mockResolvedValueOnce(new Blob(["checkpoint"]));
  const store = createReadOnlyEnrichmentCheckpointStore({
    bucket: "owner/index",
    accessToken: "hf_fixture",
    waitBeforeReadRetry: (attempt) => {
      waits.push(attempt);
      return Promise.resolve();
    },
  });

  await expect(store.read("operations/run/plan.json")).resolves.toEqual(
    new TextEncoder().encode("checkpoint"),
  );
  expect(hub.downloadFile).toHaveBeenCalledTimes(2);
  expect(waits).toEqual([1]);
});

it("restarts a partially failed listing without returning duplicate paths", async () => {
  const waits: number[] = [];
  hub.listFiles
    .mockImplementationOnce(() =>
      listing([{ type: "file", path: "operations/first.json" }], new TypeError("fetch failed")),
    )
    .mockImplementationOnce(() =>
      listing([
        { type: "file", path: "operations/first.json" },
        { type: "file", path: "operations/second.json" },
      ]),
    );
  const store = createReadOnlyEnrichmentCheckpointStore({
    bucket: "owner/index",
    accessToken: "hf_fixture",
    waitBeforeReadRetry: (attempt) => {
      waits.push(attempt);
      return Promise.resolve();
    },
  });

  await expect(store.list("operations")).resolves.toEqual([
    "operations/first.json",
    "operations/second.json",
  ]);
  expect(hub.listFiles).toHaveBeenCalledTimes(2);
  expect(waits).toEqual([1]);
});

it("does not retry a fetch failure caused by a consumer deadline", async () => {
  const deadline = Object.assign(new Error("consumer deadline expired"), {
    code: "deadline_exceeded",
  });
  hub.downloadFile.mockRejectedValue(new TypeError("fetch failed", { cause: deadline }));
  const waits: number[] = [];
  const store = createReadOnlyEnrichmentCheckpointStore({
    bucket: "owner/index",
    accessToken: "hf_fixture",
    waitBeforeReadRetry: (attempt) => {
      waits.push(attempt);
      return Promise.resolve();
    },
  });

  await expect(store.read("operations/run/plan.json")).rejects.toThrow("fetch failed");
  expect(hub.downloadFile).toHaveBeenCalledTimes(1);
  expect(waits).toEqual([]);
});

it("retries a malformed Hub response", async () => {
  hub.downloadFile
    .mockRejectedValueOnce(new hub.InvalidApiResponseFormatError("truncated response"))
    .mockResolvedValueOnce(new Blob(["checkpoint"]));
  const store = createReadOnlyEnrichmentCheckpointStore({
    bucket: "owner/index",
    accessToken: "hf_fixture",
    waitBeforeReadRetry: () => Promise.resolve(),
  });

  await expect(store.read("operations/run/plan.json")).resolves.toEqual(
    new TextEncoder().encode("checkpoint"),
  );
  expect(hub.downloadFile).toHaveBeenCalledTimes(2);
});

it("stops after three transient checkpoint read failures", async () => {
  hub.downloadFile.mockRejectedValue(new TypeError("fetch failed"));
  const store = createReadOnlyEnrichmentCheckpointStore({
    bucket: "owner/index",
    accessToken: "hf_fixture",
    waitBeforeReadRetry: () => Promise.resolve(),
  });

  await expect(store.read("operations/run/plan.json")).rejects.toThrow("fetch failed");
  expect(hub.downloadFile).toHaveBeenCalledTimes(3);
});

it("retries a Hub 499 response", async () => {
  hub.downloadFile
    .mockRejectedValueOnce(new hub.HubApiError("client closed request", 499))
    .mockResolvedValueOnce(new Blob(["checkpoint"]));
  const store = createReadOnlyEnrichmentCheckpointStore({
    bucket: "owner/index",
    accessToken: "hf_fixture",
    waitBeforeReadRetry: () => Promise.resolve(),
  });

  await expect(store.read("operations/run/plan.json")).resolves.toEqual(
    new TextEncoder().encode("checkpoint"),
  );
  expect(hub.downloadFile).toHaveBeenCalledTimes(2);
});

it("does not retry a non-transient Hub API response", async () => {
  hub.downloadFile.mockRejectedValue(new hub.HubApiError("unauthorized", 401));
  const store = createReadOnlyEnrichmentCheckpointStore({
    bucket: "owner/index",
    accessToken: "hf_fixture",
    waitBeforeReadRetry: () => Promise.resolve(),
  });

  await expect(store.read("operations/run/plan.json")).rejects.toThrow("unauthorized");
  expect(hub.downloadFile).toHaveBeenCalledTimes(1);
});

function listing(
  entries: readonly { type: "file"; path: string }[],
  failure?: Error,
): AsyncIterable<{ type: "file"; path: string }> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* entries;
      if (failure !== undefined) throw failure;
    },
  };
}
