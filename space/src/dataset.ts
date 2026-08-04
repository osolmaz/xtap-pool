import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

import { commit, downloadFile, listFiles } from "@huggingface/hub";

import {
  attemptEventSchema,
  freeLabelEventSchema,
  parseEnrichReceipt,
  parseEnrichmentRow,
  datasetPathFor,
  validateTweet,
} from "@xtap-pool/shared";
import type { AttemptEvent, EnrichReceipt, FreeLabelEvent, PooledTweet } from "@xtap-pool/shared";

import type { EnrichStore } from "./enrich-store.js";
import type { TweetStore } from "./store.js";

/** Thin abstraction over the HF Hub so tests can run against a fake. */
export type HubClient = {
  listJsonlFiles(prefix: string): Promise<string[]>;
  downloadFile(path: string): Promise<string>;
  commitFiles(files: readonly { path: string; content: string }[], title: string): Promise<void>;
};

export type EnrichmentRefresh = {
  files: number;
  rows: number;
  attempts: number;
  registryEvents: number;
  receipt?: EnrichReceipt;
};

export type DatasetSourceKind = "tweet" | "enrichment" | "attempt" | "registry" | "receipt";

export type AppliedDatasetSource = {
  kind: DatasetSourceKind;
  rows: number;
};

type EnrichmentShardUpdate = {
  path: string;
  content: string;
  kind: EnrichmentShardKind;
};

type EnrichmentReplayCounts = Pick<EnrichmentRefresh, "rows" | "attempts" | "registryEvents">;

const REFRESH_SHARDS_PER_KIND = 4;
const REFRESH_ATTEMPTS = 2;

export function isHubNotFound(error: unknown): boolean {
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
    isHubNotFound(error) ||
    message.includes(`missing: ${path}`) ||
    message.includes(`dataset file not found: ${path}`)
  );
}

export async function assertDatasetRepoReadable(
  repo: { type: "dataset"; name: string },
  accessToken: string,
  revision?: string,
): Promise<void> {
  try {
    for await (const _entry of listFiles({
      repo,
      accessToken,
      ...(revision === undefined ? {} : { revision }),
    })) {
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
        if (isHubNotFound(error)) {
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
        if (isHubNotFound(error)) await assertDatasetRepoReadable(repo, accessToken);
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
  private lastReceipt: EnrichReceipt | undefined;

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

  /** Remove local files before replaying a complete Hub snapshot. */
  clearForRebuild(): void {
    rmSync(this.rootDir, { recursive: true, force: true });
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
   * `enrichment/vocabulary.json`, restore receipt files to the local mirror,
   * then replay enrichment JSONL shards in chronological order, followed by
   * the attempt-event log which reconstructs retry/blocked state. Run after
   * `rebuild` so unit membership exists.
   */
  async rebuildEnrichment(
    enrich: EnrichStore,
  ): Promise<{ files: number; rows: number; attempts: number; registryEvents: number }> {
    this.lastReceipt = undefined;
    const allPaths = (await this.hub.listJsonlFiles("enrichment")).sort();
    const attemptPaths: string[] = [];
    const registryPaths: string[] = [];
    let files = 0;
    let rows = 0;
    for (const path of allPaths) {
      const content = await this.downloadAndMirror(path);
      const kind = classifyEnrichmentPath(path);
      if (kind === "receipt") {
        this.recordLatestReceipt(content);
        continue;
      }
      if (kind === "attempt") {
        attemptPaths.push(path);
        continue;
      }
      if (kind === "registry") {
        registryPaths.push(path);
        continue;
      }
      rows += applyEnrichmentLines(enrich, content);
      files += 1;
    }
    const registryEvents = await this.replayShards(registryPaths, (content) =>
      replayRegistryLines(enrich, content),
    );
    const attempts = await this.replayShards(attemptPaths, (content) =>
      replayAttemptLines(enrich, content),
    );
    return { files, rows, attempts, registryEvents };
  }

  /** The newest valid durable worker receipt observed while reading the Hub. */
  latestReceipt(): EnrichReceipt | undefined {
    return this.lastReceipt;
  }

  /**
   * Reload only a bounded set of recent durable enrichment shards. The Hub
   * reads are staged before changing the mirror or SQLite projection, so a
   * transient failure leaves the last known-good reader state intact.
   */
  async refreshEnrichment(
    enrich: EnrichStore,
    beforeApply?: () => void,
  ): Promise<EnrichmentRefresh> {
    let lastError: unknown;
    for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt += 1) {
      try {
        return await this.refreshEnrichmentOnce(enrich, beforeApply);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  // eslint-disable-next-line complexity -- Staging all shard kinds before replay keeps Hub failures from mutating reader state.
  private async refreshEnrichmentOnce(
    enrich: EnrichStore,
    beforeApply?: () => void,
  ): Promise<EnrichmentRefresh> {
    const selected = selectEnrichmentRefreshShards(
      await this.hub.listJsonlFiles("enrichment"),
      (path) => existsSync(this.localPath(path)),
    );
    const updates: EnrichmentShardUpdate[] = [];
    for (const path of selected) {
      const content = await this.hub.downloadFile(path);
      const local = this.localPath(path);
      if (!existsSync(local) || readFileSync(local, "utf8") !== content) {
        updates.push({ path, content, kind: classifyEnrichmentPath(path) });
      }
    }

    beforeApply?.();
    const counts: EnrichmentReplayCounts = { rows: 0, attempts: 0, registryEvents: 0 };
    let latestReceipt = this.lastReceipt;
    for (const update of updates) {
      if (update.kind === "receipt") {
        latestReceipt = this.latestReceiptIn(update.content, latestReceipt);
      } else {
        this.applyRefreshUpdate(enrich, update, counts);
      }
    }
    for (const update of updates) {
      const local = this.localPath(update.path);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, update.content);
    }
    this.lastReceipt = latestReceipt;
    return {
      files: updates.length,
      ...counts,
      ...(this.lastReceipt === undefined ? {} : { receipt: this.lastReceipt }),
    };
  }

  private applyRefreshUpdate(
    enrich: EnrichStore,
    update: EnrichmentShardUpdate,
    counts: EnrichmentReplayCounts,
  ): void {
    switch (update.kind) {
      case "row":
        counts.rows += applyEnrichmentLines(enrich, update.content);
        return;
      case "registry":
        counts.registryEvents += replayRegistryLines(enrich, update.content);
        return;
      case "attempt":
        counts.attempts += replayAttemptLines(enrich, update.content);
        return;
      case "receipt":
        return;
    }
  }

  private async downloadAndMirror(path: string): Promise<string> {
    const content = await this.hub.downloadFile(path);
    const local = this.localPath(path);
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, content);
    return content;
  }

  private recordLatestReceipt(content: string): void {
    this.lastReceipt = this.latestReceiptIn(content, this.lastReceipt);
  }

  private latestReceiptIn(
    content: string,
    current: EnrichReceipt | undefined,
  ): EnrichReceipt | undefined {
    let latest = current;
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      let candidate: unknown;
      try {
        candidate = JSON.parse(line);
      } catch {
        continue;
      }
      const receipt = parseEnrichReceipt(candidate);
      if (
        receipt !== undefined &&
        (latest === undefined || receipt.finished_at > latest.finished_at)
      ) {
        latest = receipt;
      }
    }
    return latest;
  }

  private async replayShards(
    paths: readonly string[],
    apply: (content: string) => number,
  ): Promise<number> {
    let count = 0;
    for (const path of paths) {
      const local = this.localPath(path);
      const content = existsSync(local)
        ? readFileSync(local, "utf8")
        : await this.hub.downloadFile(path);
      count += apply(content);
    }
    return count;
  }

  /** Apply one complete file or verified append suffix to the SQLite projection. */
  applySourceContent(
    path: string,
    content: string,
    store: TweetStore,
    enrich: EnrichStore,
  ): AppliedDatasetSource {
    const kind = datasetSourceKind(path);
    switch (kind) {
      case "tweet": {
        const tweets = parseJsonlTweets(content, path);
        store.insert(tweets);
        enrich.registerTweets(tweets);
        return { kind, rows: tweets.length };
      }
      case "enrichment":
        return { kind, rows: applyEnrichmentLines(enrich, content) };
      case "attempt":
        return { kind, rows: replayAttemptLines(enrich, content) };
      case "registry":
        return { kind, rows: replayRegistryLines(enrich, content) };
      case "receipt":
        this.recordLatestReceipt(content);
        return { kind, rows: countValidReceipts(content) };
    }
  }

  /** Keep a current source file locally so a later append preserves its prefix. */
  rememberSourceFile(path: string, content: string): void {
    const local = this.localPath(path);
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, content);
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
    const appended = await Promise.all(
      appends.map(async ({ path, lines }) => ({
        path,
        content: await this.appendedContent(path, lines),
      })),
    );
    const files = [...appended, ...writes];
    await this.hub.commitFiles(files, title);
    for (const file of files) {
      const local = this.localPath(file.path);
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, file.content);
    }
  }

  private async appendedContent(path: string, lines: readonly string[]): Promise<string> {
    const local = this.localPath(path);
    const existing = existsSync(local)
      ? readFileSync(local, "utf8")
      : ((await this.readText(path)) ?? "");
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

/**
 * Replay one enrichment JSONL file. Rows in the current evidence-bearing
 * schema flow through `applyEnrichment` as normal. Previous output-contract
 * rows are ignored, so the queue stays pending until durable reprocessing.
 */
type EnrichmentShardKind = "receipt" | "attempt" | "registry" | "row";

export function datasetSourceKind(path: string): DatasetSourceKind {
  if (/^data\/[^/]+\/\d{4}\/\d{2}\/tweets-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)) {
    return "tweet";
  }
  if (/^enrichment\/\d{4}\/\d{2}\/enrichment-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)) {
    return "enrichment";
  }
  if (/^enrichment\/attempts\/\d{4}\/\d{2}\/attempts-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)) {
    return "attempt";
  }
  if (/^enrichment\/registry\/\d{4}\/\d{2}\/registry-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)) {
    return "registry";
  }
  if (/^enrichment\/receipts\/\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)) return "receipt";
  throw new Error(`unsupported dataset index source: ${path}`);
}

function classifyEnrichmentPath(path: string): EnrichmentShardKind {
  if (path.startsWith("enrichment/receipts/")) return "receipt";
  if (path.startsWith("enrichment/attempts/")) return "attempt";
  if (path.startsWith("enrichment/registry/")) return "registry";
  return "row";
}

function selectEnrichmentRefreshShards(
  paths: readonly string[],
  isMirrored: (path: string) => boolean,
): string[] {
  const selected = new Set<string>();
  for (const kind of ["row", "attempt", "registry", "receipt"] as const) {
    const matching = paths.filter((path) => classifyEnrichmentPath(path) === kind).sort();
    const oldestMissing = matching
      .filter((path) => !isMirrored(path))
      .slice(0, Math.floor(REFRESH_SHARDS_PER_KIND / 2));
    const recent = matching.slice(-Math.ceil(REFRESH_SHARDS_PER_KIND / 2));
    for (const path of [...oldestMissing, ...recent]) selected.add(path);
  }
  return [...selected].sort();
}

function countValidReceipts(content: string): number {
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      if (parseEnrichReceipt(JSON.parse(line)) !== undefined) count += 1;
    } catch {
      continue;
    }
  }
  return count;
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
    const row = parseEnrichmentRow(candidate);
    if (row === undefined) continue;
    enrich.applyEnrichment(row);
    rows += 1;
  }
  return rows;
}

function replayRegistryLines(enrich: EnrichStore, content: string): number {
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = freeLabelEventSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const event: FreeLabelEvent = parsed.data;
    enrich.applyRegistryEvent(event);
    count += 1;
  }
  return count;
}

function replayAttemptLines(enrich: EnrichStore, content: string): number {
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = attemptEventSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const event: AttemptEvent = parsed.data;
    enrich.replayAttemptEvent(event);
    count += 1;
  }
  return count;
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
