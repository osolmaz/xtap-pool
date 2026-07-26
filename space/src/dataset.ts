import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

import { commit, downloadFile, listFiles } from "@huggingface/hub";

import {
  datasetPathFor,
  enrichmentRowSchema,
  parseVocabularyJson,
  validateTweet,
  VOCABULARY_PATH,
} from "@xtap-pool/shared";
import type { PooledTweet } from "@xtap-pool/shared";

import type { EnrichStore } from "./enrich-store.js";
import type { TweetStore } from "./store.js";

/** Thin abstraction over the HF Hub so tests can run against a fake. */
export type HubClient = {
  listJsonlFiles(prefix: string): Promise<string[]>;
  downloadFile(path: string): Promise<string>;
  commitFiles(files: readonly { path: string; content: string }[], title: string): Promise<void>;
};

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

function isMissingDatasetFile(error: unknown, path: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    isNotFound(error) ||
    message.includes(`missing: ${path}`) ||
    message.includes(`dataset file not found: ${path}`)
  );
}

async function assertDatasetRepoReadable(
  repo: { type: "dataset"; name: string },
  accessToken: string,
): Promise<void> {
  try {
    for await (const _entry of listFiles({ repo, accessToken })) {
      return;
    }
  } catch (error) {
    throw new Error(
      `cannot read dataset repo ${repo.name}; check that HF_TOKEN has read access to it`,
      { cause: error },
    );
  }
}

export function createHubClient(datasetRepo: string, accessToken: string): HubClient {
  const repo = { type: "dataset", name: datasetRepo } as const;
  return {
    async listJsonlFiles(prefix: string): Promise<string[]> {
      const paths: string[] = [];
      try {
        for await (const entry of listFiles({ repo, accessToken, recursive: true, path: prefix })) {
          if (entry.type === "file" && entry.path.endsWith(".jsonl")) paths.push(entry.path);
        }
      } catch (error) {
        if (isNotFound(error)) {
          // A fresh pool can lack the requested tree. Verify the repo itself is
          // readable so auth failures do not look like an empty dataset.
          await assertDatasetRepoReadable(repo, accessToken);
          return [];
        }
        throw error;
      }
      return paths;
    },
    async downloadFile(path: string): Promise<string> {
      try {
        const blob = await downloadFile({ repo, accessToken, path });
        if (blob !== null) return await blob.text();
        await assertDatasetRepoReadable(repo, accessToken);
        throw new Error(`dataset file not found: ${path}`);
      } catch (error) {
        if (isNotFound(error)) await assertDatasetRepoReadable(repo, accessToken);
        throw error;
      }
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
    // Separator-aware containment: a raw prefix check would accept escapes
    // into siblings sharing the root's name prefix (mirror → mirror-evil).
    const rel = relative(normalize(this.rootDir), resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`dataset path escapes mirror root: ${datasetPath}`);
    }
    return resolved;
  }

  /** Download the full dataset snapshot, populate the mirror and the store. */
  async rebuild(
    store: TweetStore,
    enrich?: EnrichStore,
  ): Promise<{ files: number; tweets: number }> {
    const paths = await this.hub.listJsonlFiles("data");
    let tweets = 0;
    for (const path of paths) {
      const content = await this.hub.downloadFile(path);
      const local = this.localPath(path);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, content);
      const parsed = parseJsonlTweets(content, path);
      store.insert(parsed);
      enrich?.registerTweets(parsed);
      tweets += parsed.length;
    }
    return { files: paths.length, tweets };
  }

  /**
   * Rebuild the enrichment tables from the dataset: seed the vocabulary from
   * `enrichment/vocabulary.json`, then replay all enrichment JSONL shards in
   * chronological order. Run after `rebuild` so unit membership exists.
   */
  async rebuildEnrichment(enrich: EnrichStore): Promise<{ files: number; rows: number }> {
    const vocabularyRaw = await this.readText(VOCABULARY_PATH);
    if (vocabularyRaw !== undefined) enrich.seedVocabulary(parseVocabularyJson(vocabularyRaw));
    const paths = (await this.hub.listJsonlFiles("enrichment"))
      .filter((path) => !path.startsWith("enrichment/receipts/"))
      .sort();
    let rows = 0;
    for (const path of paths) {
      const content = await this.hub.downloadFile(path);
      const local = this.localPath(path);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, content);
      rows += applyEnrichmentLines(enrich, content);
    }
    return { files: paths.length, rows };
  }

  /** Read a dataset file through the Hub, returning undefined when it is absent. */
  async readText(path: string): Promise<string | undefined> {
    try {
      return await this.hub.downloadFile(path);
    } catch (error) {
      if (isMissingDatasetFile(error, path)) return undefined;
      throw error;
    }
  }

  /** Commit one metadata file and update the local mirror after the commit succeeds. */
  async writeTextAndCommit(path: string, content: string, title: string): Promise<void> {
    await this.hub.commitFiles([{ path, content }], title);
    const local = this.localPath(path);
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, content);
  }

  /**
   * Append JSONL lines and overwrite whole metadata files in one dataset
   * commit. The local mirror is only updated after the commit succeeds.
   */
  async commitBatch(
    appends: readonly { path: string; lines: readonly string[] }[],
    writes: readonly { path: string; content: string }[],
    title: string,
  ): Promise<void> {
    const files = [
      ...appends.map(({ path, lines }) => ({ path, content: this.appendedContent(path, lines) })),
      ...writes,
    ];
    await this.hub.commitFiles(files, title);
    for (const file of files) {
      const local = this.localPath(file.path);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, file.content);
    }
  }

  private appendedContent(path: string, lines: readonly string[]): string {
    const local = this.localPath(path);
    const existing = existsSync(local) ? readFileSync(local, "utf8") : "";
    const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
    return `${prefix}${lines.map((line) => `${line}\n`).join("")}`;
  }

  /**
   * Append accepted tweets to their contributors' daily files and commit the
   * result to the Hub. The mirror is only updated after the commit succeeds.
   */
  async appendAndCommit(accepted: readonly PooledTweet[], title: string): Promise<void> {
    const byPath = new Map<string, string[]>();
    for (const tweet of accepted) {
      const path = datasetPathFor(tweet.contributed_by, tweet.captured_at);
      const bucket = byPath.get(path);
      if (bucket === undefined) byPath.set(path, [JSON.stringify(tweet)]);
      else bucket.push(JSON.stringify(tweet));
    }
    await this.commitBatch(
      [...byPath.entries()].map(([path, lines]) => ({ path, lines })),
      [],
      title,
    );
  }
}

function applyEnrichmentLines(enrich: EnrichStore, content: string): number {
  let rows = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = enrichmentRowSchema.safeParse(candidate);
    if (!parsed.success) continue;
    enrich.applyEnrichment(parsed.data);
    rows += 1;
  }
  return rows;
}

/**
 * Parse one JSONL dataset file into stamped tweets. Tolerates legacy lines
 * (e.g. imported from local xTap output) that lack attribution stamps by
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
