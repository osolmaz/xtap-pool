import { beforeEach, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => {
  class HubApiError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }

  return {
    downloadFile: vi.fn(),
    listFiles: vi.fn(),
    uploadFile: vi.fn(),
    HubApiError,
  };
});

vi.mock("@huggingface/hub", () => hub);

import { createRawBucketReader } from "../src/bucket-log.js";

beforeEach(() => {
  vi.resetAllMocks();
});

it("retries a transient raw segment download", async () => {
  hub.downloadFile
    .mockRejectedValueOnce(new TypeError("fetch failed", { cause: new Error("read ECONNRESET") }))
    .mockResolvedValueOnce(new Blob(["segment"]));
  const reader = createRawBucketReader("owner/raw", "hf_fixture");

  await expect(reader.download("v1/segments/mixed/example.json.gz")).resolves.toEqual(
    new TextEncoder().encode("segment"),
  );
  expect(hub.downloadFile).toHaveBeenCalledTimes(2);
});

it("restarts a partially failed raw Bucket listing without duplicates", async () => {
  hub.listFiles
    .mockImplementationOnce(() =>
      listing([fileEntry("v1/segments/mixed/first.json.gz")], new TypeError("fetch failed")),
    )
    .mockImplementationOnce(() =>
      listing([
        fileEntry("v1/segments/mixed/first.json.gz"),
        fileEntry("v1/segments/mixed/second.json.gz"),
      ]),
    );
  const reader = createRawBucketReader("owner/raw", "hf_fixture");

  await expect(reader.list("v1/segments")).resolves.toEqual([
    {
      key: "v1/segments/mixed/first.json.gz",
      oid: "a".repeat(64),
      size: 7,
    },
    {
      key: "v1/segments/mixed/second.json.gz",
      oid: "a".repeat(64),
      size: 7,
    },
  ]);
  expect(hub.listFiles).toHaveBeenCalledTimes(2);
});

it("does not retry a cancelled raw Bucket read", async () => {
  const cancelled = new TypeError("fetch failed", {
    cause: new DOMException("request was cancelled", "AbortError"),
  });
  hub.downloadFile.mockRejectedValue(cancelled);
  const reader = createRawBucketReader("owner/raw", "hf_fixture");

  await expect(reader.download("v1/segments/mixed/example.json.gz")).rejects.toThrow(
    "fetch failed",
  );
  expect(hub.downloadFile).toHaveBeenCalledTimes(1);
});

it("does not retry an unknown non-network read failure", async () => {
  hub.downloadFile.mockRejectedValue(new Error("fixture aborted"));
  const reader = createRawBucketReader("owner/raw", "hf_fixture");

  await expect(reader.download("v1/segments/mixed/example.json.gz")).rejects.toThrow(
    "fixture aborted",
  );
  expect(hub.downloadFile).toHaveBeenCalledTimes(1);
});

it("does not retry invalid raw Bucket metadata", async () => {
  hub.listFiles.mockImplementationOnce(() =>
    listing([{ type: "file", path: "v1/segments/mixed/invalid.json.gz", size: 7 }]),
  );
  const reader = createRawBucketReader("owner/raw", "hf_fixture");

  await expect(reader.list("v1/segments")).rejects.toThrow(
    "Bucket listing has no immutable object identity",
  );
  expect(hub.listFiles).toHaveBeenCalledTimes(1);
});

function fileEntry(path: string): {
  type: "file";
  path: string;
  size: number;
  oid: string;
} {
  return { type: "file", path, size: 7, oid: "a".repeat(64) };
}

function listing<T>(entries: readonly T[], failure?: Error): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* entries;
      if (failure !== undefined) throw failure;
    },
  };
}
