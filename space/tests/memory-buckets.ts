/* eslint-disable @typescript-eslint/require-await -- In-memory storage implements asynchronous Bucket interfaces. */
import { readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "../src/bucket-log.js";
import type { BucketObject, RawBucketClient } from "../src/bucket-log.js";
import type { BucketFile, DurableIndexBucketClient } from "../src/durable-index.js";

export class MemoryRawBucket implements RawBucketClient {
  files = new Map<string, Uint8Array>();
  downloads: string[] = [];

  async list(prefix: string): Promise<readonly BucketObject[]> {
    return [...this.files]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, content]) => ({ key, oid: sha256(content), size: content.byteLength }));
  }

  async download(key: string): Promise<Uint8Array | undefined> {
    this.downloads.push(key);
    const content = this.files.get(key);
    return content === undefined ? undefined : new Uint8Array(content);
  }

  async upload(key: string, content: Uint8Array): Promise<void> {
    this.files.set(key, new Uint8Array(content));
  }
}

export class MemoryIndexBucket implements DurableIndexBucketClient {
  files = new Map<string, Buffer>();
  removed: string[] = [];

  async download(
    path: string,
    destination: string,
    progress?: (completed: number, total: number) => Promise<void>,
  ): Promise<boolean> {
    const content = this.files.get(path);
    if (content === undefined) return false;
    await progress?.(0, content.byteLength);
    writeFileSync(destination, content);
    await progress?.(content.byteLength, content.byteLength);
    return true;
  }

  async uploadFile(
    path: string,
    source: string,
    progress?: (completed: number, total: number) => Promise<void>,
  ): Promise<void> {
    const content = readFileSync(source);
    await progress?.(0, content.byteLength);
    this.files.set(path, content);
    await progress?.(content.byteLength, content.byteLength);
  }

  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path)?.toString("utf8");
  }

  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, Buffer.from(content));
  }

  async list(prefix: string): Promise<readonly BucketFile[]> {
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => ({ path, uploadedAt: "2000-01-01T00:00:00.000Z" }));
  }

  async remove(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      this.files.delete(path);
      this.removed.push(path);
    }
  }
}
