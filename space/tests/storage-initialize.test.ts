/* eslint-disable @typescript-eslint/require-await -- The in-memory Bucket implements an async interface. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const files = new Map<string, Uint8Array>();
vi.mock("@huggingface/hub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@huggingface/hub")>();
  return {
    ...actual,
    listFiles: () => ({
      async *[Symbol.asyncIterator]() {
        for (const [path, content] of files) {
          yield { type: "file", path, size: content.byteLength, xetHash: "listed" };
        }
      },
    }),
    downloadFile: ({ path }: { path: string }) => {
      const content = files.get(path);
      return Promise.resolve(content === undefined ? null : new Blob([content]));
    },
    uploadFile: ({ file }: { file: { path: string; content: Blob } }) =>
      file.content.arrayBuffer().then((content) => {
        files.set(file.path, new Uint8Array(content));
      }),
  };
});

import { BucketLog, createRawBucketClient } from "../src/bucket-log.js";
import { initializeRawStorage } from "../src/storage-initialize.js";

describe("raw storage initialization", () => {
  it("persists every canonical configuration before index bootstrap", async () => {
    files.clear();
    const workDir = mkdtempSync(join(tmpdir(), "xtap-storage-init-"));
    const now = () => new Date("2026-08-12T12:00:00.000Z");
    await initializeRawStorage({
      rawBucket: "alice/xtap-pool-data",
      token: "token",
      members: ["alice"],
      admins: ["alice"],
      workDir,
      now,
    });
    const log = new BucketLog(
      "alice/xtap-pool-data",
      createRawBucketClient("alice/xtap-pool-data", "token"),
      workDir,
      now,
    );

    await expect(log.readText("config/pool.json")).resolves.toContain('"members":["alice"]');
    await expect(log.readText("config/service-accounts.json")).resolves.toContain('"accounts":[]');
    await expect(log.readText("config/labels.json")).resolves.toContain('"name":"ai"');
    await expect(log.readText("enrichment/vocabulary.json")).resolves.toContain('"labels":[]');
  });

  it("uses the current time when no clock override is supplied", async () => {
    files.clear();
    const workDir = mkdtempSync(join(tmpdir(), "xtap-storage-defaults-"));
    await initializeRawStorage({
      rawBucket: "alice/xtap-pool-data",
      token: "token",
      members: ["alice"],
      admins: [],
      workDir,
    });
    expect(files.size).toBe(1);
  });
});
