import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => ({
  deleteFiles: vi.fn(),
  downloadFile: vi.fn(),
  fileDownloadInfo: vi.fn(),
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("@huggingface/hub", () => hub);

import { createDurableIndexBucketClient } from "../src/durable-index.js";

const directories: string[] = [];
const bytes = new TextEncoder().encode("0123456789");

beforeEach(() => {
  vi.clearAllMocks();
  hub.fileDownloadInfo.mockResolvedValue({
    size: bytes.byteLength,
    etag: '"fixture-etag"',
    url: "https://hub.test/buckets/owner/index/resolve/database.sqlite",
  });
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class BrokenBlob extends Blob {
  readonly #bytes: Uint8Array;

  constructor(value: Uint8Array) {
    super([value]);
    this.#bytes = value;
  }

  override stream(): ReadableStream<Uint8Array> {
    const first = this.#bytes.slice(0, 4);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        setTimeout(() => {
          controller.error(new Error("fixture transfer interrupted"));
        }, 5);
      },
    });
  }
}

class RecordedBlob extends Blob {
  readonly #bytes: Uint8Array;
  readonly #offsets: number[];
  readonly #breakSlice: boolean;

  constructor(value: Uint8Array, offsets: number[], breakSlice: boolean) {
    super([value]);
    this.#bytes = value;
    this.#offsets = offsets;
    this.#breakSlice = breakSlice;
  }

  override slice(start = 0, end = this.size): Blob {
    this.#offsets.push(start);
    const value = this.#bytes.slice(start, end);
    return this.#breakSlice ? new BrokenBlob(value) : new Blob([value]);
  }
}

it("resumes one partial download after verifying the same remote identity", async () => {
  const directory = await temporaryDirectory();
  const destination = join(directory, "database.sqlite");
  const offsets: number[] = [];
  hub.downloadFile
    .mockResolvedValueOnce(new RecordedBlob(bytes, offsets, true))
    .mockResolvedValueOnce(new RecordedBlob(bytes, offsets, false));
  const client = createDurableIndexBucketClient("owner/index", "hf_fixture", undefined, {
    waitBeforeRetry: () => Promise.resolve(),
  });

  await expect(client.download("index/database.sqlite", destination)).resolves.toBe(true);

  expect(offsets).toEqual([0, 4]);
  expect(hub.fileDownloadInfo).toHaveBeenCalledTimes(2);
  expect(hub.downloadFile).toHaveBeenCalledTimes(2);
  expect(await readFile(destination)).toEqual(Buffer.from(bytes));
});

it("stops a download after three failed attempts", async () => {
  const directory = await temporaryDirectory();
  const destination = join(directory, "database.sqlite");
  const offsets: number[] = [];
  hub.downloadFile.mockResolvedValue(new RecordedBlob(bytes, offsets, true));
  const waits: number[] = [];
  const client = createDurableIndexBucketClient("owner/index", "hf_fixture", undefined, {
    waitBeforeRetry: (attempt) => {
      waits.push(attempt);
      return Promise.resolve();
    },
  });

  await expect(client.download("index/database.sqlite", destination)).rejects.toThrow(
    "fixture transfer interrupted",
  );

  expect(offsets).toEqual([0, 4, 8]);
  expect(hub.fileDownloadInfo).toHaveBeenCalledTimes(3);
  expect(hub.downloadFile).toHaveBeenCalledTimes(3);
  expect(waits).toEqual([1, 2]);
  expect(await readFile(destination)).toEqual(Buffer.from(bytes));
});

it("does not append a partial download after the remote identity changes", async () => {
  const directory = await temporaryDirectory();
  const destination = join(directory, "database.sqlite");
  const offsets: number[] = [];
  hub.downloadFile.mockResolvedValue(new RecordedBlob(bytes, offsets, true));
  hub.fileDownloadInfo
    .mockResolvedValueOnce({
      size: bytes.byteLength,
      etag: '"first-etag"',
      url: "https://hub.test/first",
    })
    .mockResolvedValueOnce({
      size: bytes.byteLength,
      etag: '"second-etag"',
      url: "https://hub.test/second",
    });
  const client = createDurableIndexBucketClient("owner/index", "hf_fixture", undefined, {
    waitBeforeRetry: () => Promise.resolve(),
  });

  await expect(client.download("index/database.sqlite", destination)).rejects.toThrow(
    "identity changed",
  );

  expect(offsets).toEqual([0]);
  expect(hub.fileDownloadInfo).toHaveBeenCalledTimes(2);
  expect(hub.downloadFile).toHaveBeenCalledTimes(1);
  expect(await readFile(destination)).toEqual(Buffer.from(bytes.slice(0, 4)));
});

it("retries an upload and succeeds on the third attempt", async () => {
  const directory = await temporaryDirectory();
  const source = join(directory, "database.sqlite");
  await writeFile(source, bytes);
  hub.uploadFile
    .mockRejectedValueOnce(new Error("first upload failed"))
    .mockRejectedValueOnce(new Error("second upload failed"))
    .mockResolvedValueOnce(undefined);
  const client = createDurableIndexBucketClient("owner/index", "hf_fixture", undefined, {
    waitBeforeRetry: () => Promise.resolve(),
  });

  await expect(client.uploadFile("index/database.sqlite", source)).resolves.toBeUndefined();

  expect(hub.uploadFile).toHaveBeenCalledTimes(3);
});

it("stops an upload after three failed attempts", async () => {
  const directory = await temporaryDirectory();
  const source = join(directory, "database.sqlite");
  await writeFile(source, bytes);
  hub.uploadFile.mockRejectedValue(new Error("fixture upload failed"));
  const waits: number[] = [];
  const client = createDurableIndexBucketClient("owner/index", "hf_fixture", undefined, {
    waitBeforeRetry: (attempt) => {
      waits.push(attempt);
      return Promise.resolve();
    },
  });

  await expect(client.uploadFile("index/database.sqlite", source)).rejects.toThrow(
    "fixture upload failed",
  );

  expect(hub.uploadFile).toHaveBeenCalledTimes(3);
  expect(waits).toEqual([1, 2]);
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xtap-transfer-"));
  directories.push(directory);
  return directory;
}
