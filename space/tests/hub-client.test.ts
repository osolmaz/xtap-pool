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
  const client = createHubClient("osolmaz/xtap-pool-data", "hf_token");

  it("lists only jsonl files under the requested prefix", async () => {
    hubMocks.listFiles.mockReturnValue(
      asyncIterableOf([
        { type: "file", path: "data/osolmaz/2026/05/tweets-2026-05-21.jsonl" },
        { type: "directory", path: "data/osolmaz" },
        { type: "file", path: "data/osolmaz/notes.txt" },
      ]),
    );
    await expect(client.listJsonlFiles("data")).resolves.toEqual([
      "data/osolmaz/2026/05/tweets-2026-05-21.jsonl",
    ]);
    expect(hubMocks.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: { type: "dataset", name: "osolmaz/xtap-pool-data" },
        path: "data",
        recursive: true,
      }),
    );

    hubMocks.listFiles.mockReturnValue(
      asyncIterableOf([{ type: "file", path: "enrichment/2026/07/enrichment-2026-07-06.jsonl" }]),
    );
    await expect(client.listJsonlFiles("enrichment")).resolves.toEqual([
      "enrichment/2026/07/enrichment-2026-07-06.jsonl",
    ]);
    expect(hubMocks.listFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "enrichment" }),
    );
  });

  it("treats a missing tree as an empty listing when the repo is readable", async () => {
    hubMocks.listFiles
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      })
      .mockReturnValueOnce(asyncIterableOf([{ type: "file", path: ".gitattributes" }]));
    await expect(client.listJsonlFiles("data")).resolves.toEqual([]);
  });

  it("does not hide private dataset access failures as an empty listing", async () => {
    hubMocks.listFiles.mockImplementation(() => {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    });
    await expect(client.listJsonlFiles("data")).rejects.toThrow("cannot read dataset repo");
  });

  it("propagates non-404 listing failures", async () => {
    hubMocks.listFiles.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { statusCode: 403 });
    });
    await expect(client.listJsonlFiles("data")).rejects.toThrow("denied");
  });

  it("downloads file content and fails on missing files", async () => {
    hubMocks.downloadFile.mockResolvedValue(new Blob(["line\n"]));
    await expect(client.downloadFile("data/x.jsonl")).resolves.toBe("line\n");
    hubMocks.downloadFile.mockResolvedValue(null);
    hubMocks.listFiles.mockReturnValue(asyncIterableOf([{ type: "file", path: ".gitattributes" }]));
    await expect(client.downloadFile("data/gone.jsonl")).rejects.toThrow("dataset file not found");
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
