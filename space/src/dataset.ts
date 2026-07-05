import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { commit, downloadFile, listFiles } from "@huggingface/hub";

import { datasetPathFor, validateTweet } from "@xtap-pool/shared";
import type { PooledTweet } from "@xtap-pool/shared";

import type { TweetStore } from "./store.js";

/** Thin abstraction over the HF Hub so tests can run against a fake. */
export type HubClient = {
  listDataFiles(): Promise<string[]>;
  downloadFile(path: string): Promise<string>;
  commitFiles(files: readonly { path: string; content: string }[], title: string): Promise<void>;
};

export function createHubClient(datasetRepo: string, accessToken: string): HubClient {
  const repo = { type: "dataset", name: datasetRepo } as const;
  return {
    async listDataFiles(): Promise<string[]> {
      const paths: string[] = [];
      for await (const entry of listFiles({ repo, accessToken, recursive: true, path: "data" })) {
        if (entry.type === "file" && entry.path.endsWith(".jsonl")) paths.push(entry.path);
      }
      return paths;
    },
    async downloadFile(path: string): Promise<string> {
      const blob = await downloadFile({ repo, accessToken, path });
      if (blob === null) throw new Error(`dataset file not found: ${path}`);
      return blob.text();
    },
    async commitFiles(
      files: readonly { path: string; content: string }[],
      title: string,
    ): Promise<void> {
      await commit({
        repo,
        accessToken,
        title,
        operations: files.map((file) => ({
          operation: "addOrUpdate" as const,
          path: file.path,
          content: new Blob([file.content]),
        })),
      });
    },
  };
}

/**
 * Local mirror of the dataset repo's `data/` tree. The mirror plus the tweet
 * store are caches; the dataset repo stays the system of record, so every
 * ingest commits to the Hub before anything is persisted locally.
 */
export class DatasetMirror {
  constructor(
    private readonly hub: HubClient,
    private readonly rootDir: string,
  ) {}

  private localPath(datasetPath: string): string {
    const resolved = normalize(join(this.rootDir, datasetPath));
    if (!resolved.startsWith(normalize(this.rootDir))) {
      throw new Error(`dataset path escapes mirror root: ${datasetPath}`);
    }
    return resolved;
  }

  /** Download the full dataset snapshot, populate the mirror and the store. */
  async rebuild(store: TweetStore): Promise<{ files: number; tweets: number }> {
    const paths = await this.hub.listDataFiles();
    let tweets = 0;
    for (const path of paths) {
      const content = await this.hub.downloadFile(path);
      const local = this.localPath(path);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, content);
      const parsed = parseJsonlTweets(content, path);
      store.insert(parsed);
      tweets += parsed.length;
    }
    return { files: paths.length, tweets };
  }

  /**
   * Append accepted tweets to their contributors' daily files and commit the
   * result to the Hub. The mirror is only updated after the commit succeeds.
   */
  async appendAndCommit(accepted: readonly PooledTweet[], title: string): Promise<void> {
    const byPath = new Map<string, PooledTweet[]>();
    for (const tweet of accepted) {
      const path = datasetPathFor(tweet.contributed_by, tweet.captured_at);
      const bucket = byPath.get(path);
      if (bucket === undefined) byPath.set(path, [tweet]);
      else bucket.push(tweet);
    }
    const files = [...byPath.entries()].map(([path, tweetsForPath]) => {
      const local = this.localPath(path);
      const existing = existsSync(local) ? readFileSync(local, "utf8") : "";
      const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
      const lines = tweetsForPath.map((tweet) => `${JSON.stringify(tweet)}\n`).join("");
      return { path, content: `${prefix}${lines}` };
    });
    await this.hub.commitFiles(files, title);
    for (const file of files) {
      const local = this.localPath(file.path);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, file.content);
    }
  }
}

/**
 * Parse one JSONL dataset file into stamped tweets. Tolerates legacy lines
 * (e.g. seeded from a personal xtap-store) that lack attribution stamps by
 * inferring the contributor from the file path (`data/<user>/...`) and
 * defaulting `pooled_at` to the capture time. Invalid lines are skipped.
 */
export function parseJsonlTweets(content: string, path: string): PooledTweet[] {
  const pathUser = path.split("/")[1] ?? "unknown";
  const tweets: PooledTweet[] = [];
  for (const line of content.split("\n")) {
    const tweet = parseJsonlLine(line, pathUser);
    if (tweet !== undefined) tweets.push(tweet);
  }
  return tweets;
}

function parseJsonlLine(line: string, pathUser: string): PooledTweet | undefined {
  if (line.trim() === "") return undefined;
  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch {
    return undefined;
  }
  const result = validateTweet(candidate);
  if (!result.ok) return undefined;
  const tweet = result.tweet;
  const rawContributor = tweet["contributed_by"];
  const rawPooledAt = tweet["pooled_at"];
  const contributedBy =
    typeof rawContributor === "string" && rawContributor.length > 0 ? rawContributor : pathUser;
  const pooledAt = typeof rawPooledAt === "string" ? rawPooledAt : tweet.captured_at;
  return { ...tweet, contributed_by: contributedBy, pooled_at: pooledAt };
}
