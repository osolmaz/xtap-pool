import { Buffer } from "node:buffer";

import { ObjectProgressStore } from "@osolmaz/hf-job-control";
import type { ProgressObjectStore } from "@osolmaz/hf-job-control";
import { describe, expect, it } from "vitest";

import { XTapJobProgress } from "../src/job-progress.js";

class MemoryObjects implements ProgressObjectStore {
  readonly bucketId = "owner/index";
  readonly files = new Map<string, Uint8Array>();

  read(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(key) ?? null);
  }

  list(prefix: string): Promise<readonly string[]> {
    return Promise.resolve([...this.files.keys()].filter((key) => key.startsWith(prefix)).sort());
  }

  write(key: string, content: Uint8Array): Promise<void> {
    this.files.set(key, Buffer.from(content));
    return Promise.resolve();
  }
}

describe("XTapJobProgress", () => {
  it("publishes exact terminal state for every worker phase", async () => {
    const objects = new MemoryObjects();
    const progress = await XTapJobProgress.create({
      bucket: objects.bucketId,
      accessToken: "test",
      sourceRevision: "a".repeat(40),
      contractHash: "b".repeat(64),
      env: { JOB_ID: "job-1" },
      objectStore: objects,
    });

    await progress.restoreDatabase(100, 100);
    await progress.sourceReplay({ revision: "c".repeat(64), completed: 12, total: 12 });
    await progress.workingCopy(true);
    await progress.queue({ pending: 0, running: 0, retrying: 0, blocked: 2, done: 8 });
    await progress.registryScan(20, 20);
    await progress.receiptPublished();
    await progress.databaseBuild(true);
    await progress.databaseUpload(200, 200);
    await progress.databaseVerify(200, 200);
    await progress.manifestPublished();
    await progress.complete();

    const stored = await new ObjectProgressStore(objects).loadLatest("xtap-enrichment-job-1");
    expect(stored?.snapshot.state).toBe("completed");
    expect(stored?.snapshot.tracks).toHaveLength(13);
    expect(stored?.snapshot.tracks.every((track) => track.status === "completed")).toBe(true);
    expect(stored?.snapshot.tracks.find((track) => track.key === "enrichment-queue")).toMatchObject(
      { completed: 10, total: 10, unit: "records" },
    );
  });

  it("publishes active, waiting, blocked, and resumed phase transitions", async () => {
    const objects = new MemoryObjects();
    const progress = await XTapJobProgress.create({
      bucket: objects.bucketId,
      accessToken: "test",
      sourceRevision: "a".repeat(40),
      contractHash: "b".repeat(64),
      env: { XTAP_PROGRESS_RUN_ID: "shared-run" },
      objectStore: objects,
    });

    await progress.restoreDatabase(0, 100);
    await progress.restoreDatabase(100, 100);
    await progress.sourceReplay({ revision: "c".repeat(64), completed: 0, total: 2 });
    await progress.sourceReplay({ revision: "c".repeat(64), completed: 2, total: 2 });
    await progress.queue({ pending: 1, running: 0, retrying: 0, blocked: 0, done: 0 });
    await progress.databaseUpload(50, 100);
    await progress.databaseVerify(50, 100);
    await progress.blocked();
    await progress.manifestPublished();
    await progress.sourceReplay({ revision: "c".repeat(64), completed: 2, total: 2 });

    const stored = await new ObjectProgressStore(objects).loadLatest("shared-run");
    expect(stored?.snapshot.state).toBe("blocked");
    expect(stored?.snapshot.tracks.find((track) => track.key === "source-replay")).toMatchObject({
      status: "completed",
      completed: 2,
      total: 2,
    });
    expect(stored?.snapshot.tracks.find((track) => track.key === "enrichment-queue")).toMatchObject(
      { status: "running", completed: 0, total: 1 },
    );
  });
});
