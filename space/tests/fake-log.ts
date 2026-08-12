/* eslint-disable @typescript-eslint/require-await -- The fake implements an asynchronous storage interface. */
import type { EnrichReceipt, PooledTweet } from "@xtap-pool/shared";

import { tweetPathFor } from "../src/bucket-log.js";
import type { StorageLog } from "../src/bucket-log.js";

/** Small in-memory raw-log fake for domain tests. */
export class FakeLog implements StorageLog {
  readonly files = new Map<string, string>();
  readonly commits: { paths: string[]; title: string }[] = [];
  failNextCommit = false;
  failReadAttempts = 0;
  receipt: EnrichReceipt | undefined;

  async appendTweets(tweets: readonly PooledTweet[], title = "append tweets"): Promise<string> {
    const byPath = new Map<string, string[]>();
    for (const tweet of tweets) {
      const path = tweetPathFor(tweet.contributed_by, tweet.captured_at);
      const lines = byPath.get(path);
      if (lines === undefined) byPath.set(path, [JSON.stringify(tweet)]);
      else lines.push(JSON.stringify(tweet));
    }
    await this.commitBatch(
      [...byPath].map(([path, lines]) => ({ path, lines })),
      [],
      title,
    );
    return "segment";
  }

  async commitBatch(
    appends: readonly { path: string; lines: readonly string[] }[],
    writes: readonly { path: string; content: string }[],
    title = "commit",
  ): Promise<string> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("Bucket unavailable");
    }
    for (const append of appends) {
      const old = this.files.get(append.path) ?? "";
      const prefix = old === "" || old.endsWith("\n") ? old : `${old}\n`;
      this.files.set(append.path, `${prefix}${append.lines.map((line) => `${line}\n`).join("")}`);
    }
    for (const write of writes) this.files.set(write.path, write.content);
    this.commits.push({
      paths: [...appends.map((item) => item.path), ...writes.map((item) => item.path)],
      title,
    });
    return "segment";
  }

  async readText(path: string): Promise<string | undefined> {
    if (this.failReadAttempts > 0) {
      this.failReadAttempts -= 1;
      throw new Error("Bucket unavailable");
    }
    return this.files.get(path);
  }

  async writeText(path: string, content: string, title = "write"): Promise<void> {
    await this.commitBatch([], [{ path, content }], title);
  }

  latestReceipt(): EnrichReceipt | undefined {
    return this.receipt;
  }
}
