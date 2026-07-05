import { beforeEach, describe, expect, it, vi } from "vitest";

const hubMocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  downloadFile: vi.fn(),
  commit: vi.fn(),
}));

vi.mock("@huggingface/hub", () => hubMocks);

import { createHubClient } from "../src/dataset.js";

function asyncIterableOf(entries: { type: string; path: string }[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () =>
          Promise.resolve(
            index < entries.length
              ? { value: entries[index++], done: false }
              : { value: undefined, done: true },
          ),
      };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createHubClient", () => {
  const client = createHubClient("dutifuldev/xtap-pool-data", "hf_token");

  it("lists only jsonl files under data/", async () => {
    hubMocks.listFiles.mockReturnValue(
      asyncIterableOf([
        { type: "file", path: "data/osolmaz/2026/05/tweets-2026-05-21.jsonl" },
        { type: "directory", path: "data/osolmaz" },
        { type: "file", path: "data/osolmaz/notes.txt" },
      ]),
    );
    await expect(client.listDataFiles()).resolves.toEqual([
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
    ]);
    expect(hubMocks.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: { type: "dataset", name: "dutifuldev/xtap-pool-data" },
        path: "data",
        recursive: true,
      }),
    );
  });

  it("treats a missing data/ tree as an empty pool", async () => {
    hubMocks.listFiles.mockImplementation(() => {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    });
    await expect(client.listDataFiles()).resolves.toEqual([]);
  });

  it("propagates non-404 listing failures", async () => {
    hubMocks.listFiles.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { statusCode: 403 });
    });
    await expect(client.listDataFiles()).rejects.toThrow("denied");
  });

  it("downloads file content and fails on missing files", async () => {
    hubMocks.downloadFile.mockResolvedValue(new Blob(["line\n"]));
    await expect(client.downloadFile("data/x.jsonl")).resolves.toBe("line\n");
    hubMocks.downloadFile.mockResolvedValue(null);
    await expect(client.downloadFile("data/gone.jsonl")).rejects.toThrow("not found");
  });

  it("commits files as addOrUpdate operations", async () => {
    hubMocks.commit.mockResolvedValue({});
    await client.commitFiles([{ path: "data/a.jsonl", content: "x\n" }], "pool: test");
    const params = hubMocks.commit.mock.calls[0]?.[0] as {
      title: string;
      operations: { operation: string; path: string }[];
    };
    expect(params.title).toBe("pool: test");
    expect(params.operations).toHaveLength(1);
    expect(params.operations[0]?.operation).toBe("addOrUpdate");
    expect(params.operations[0]?.path).toBe("data/a.jsonl");
  });
});
