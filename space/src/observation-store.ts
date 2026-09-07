import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  canonicalJson,
  datasetPathFor,
  normalizeObservation,
  observationSchema,
  tweetContent,
} from "@xtap-pool/shared";
import type { Observation, PooledTweet } from "@xtap-pool/shared";

export type ObservationSource = {
  segmentKey: string;
  operation: number;
  path: string;
  position: number;
};
const rowSchema = z.object({ payload_json: z.string() });
const sourceRowSchema = z.object({ observation_id: z.string(), received_at: z.string() });
const sourceSchema = z
  .object({
    segmentKey: z.string().min(1),
    operation: z.number().int().nonnegative(),
    path: z.string().min(1),
    position: z.number().int().nonnegative(),
  })
  .strict();
export const OBSERVATION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS post_content_versions (
  content_hash TEXT PRIMARY KEY, post_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_content_post ON post_content_versions(post_id, content_hash);
CREATE TABLE IF NOT EXISTS post_observations (
  observation_id TEXT PRIMARY KEY, post_id TEXT NOT NULL, contributor TEXT NOT NULL,
  observed_at TEXT NOT NULL, received_at TEXT NOT NULL, content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  FOREIGN KEY(content_hash) REFERENCES post_content_versions(content_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_observation_post_time ON post_observations(post_id, observed_at, observation_id);
CREATE TABLE IF NOT EXISTS observation_sources (
  source_ref TEXT PRIMARY KEY, observation_id TEXT NOT NULL,
  segment_key TEXT NOT NULL, operation INTEGER NOT NULL CHECK(operation >= 0),
  logical_path TEXT NOT NULL, position INTEGER NOT NULL CHECK(position >= 0),
  received_at TEXT NOT NULL,
  FOREIGN KEY(observation_id) REFERENCES post_observations(observation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_observation_source_segment ON observation_sources(segment_key, observation_id);
CREATE INDEX IF NOT EXISTS idx_observation_source_id ON observation_sources(observation_id, received_at, source_ref);
`;

/** Rebuildable normalized history. Raw source segments remain authoritative. */
export class ObservationStore {
  constructor(private readonly database: Database.Database) {
    database.exec(OBSERVATION_TABLES_SQL);
  }
  has(id: string): boolean {
    return (
      this.database.prepare("SELECT 1 FROM post_observations WHERE observation_id = ?").get(id) !==
      undefined
    );
  }
  get(id: string): Observation | null {
    const row = this.database
      .prepare("SELECT payload_json FROM post_observations WHERE observation_id = ?")
      .get(id);
    return row === undefined
      ? null
      : observationSchema.parse(JSON.parse(rowSchema.parse(row).payload_json));
  }
  record(tweet: PooledTweet, source: ObservationSource): Observation {
    const observation = normalizeObservation(tweet);
    const reference = sourceReference(source);
    const existing = this.database
      .prepare("SELECT observation_id, received_at FROM observation_sources WHERE source_ref = ?")
      .get(reference);
    if (existing !== undefined) {
      const previous = sourceRowSchema.parse(existing);
      if (
        previous.observation_id !== observation.id ||
        previous.received_at !== observation.received_at
      )
        throw new Error("observation source reference changed its contents");
    }
    this.database.transaction(() => {
      this.insertContent(tweet, observation);
      this.insertObservation(tweet.contributed_by, observation);
      this.database
        .prepare(
          `INSERT OR IGNORE INTO observation_sources
        (source_ref, observation_id, segment_key, operation, logical_path, position, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reference,
          observation.id,
          source.segmentKey,
          source.operation,
          source.path,
          source.position,
          observation.received_at,
        );
    })();
    return observation;
  }
  private insertContent(tweet: PooledTweet, observation: Observation): void {
    const payload = canonicalJson(tweetContent(tweet));
    const previous = this.database
      .prepare("SELECT payload_json FROM post_content_versions WHERE content_hash = ?")
      .get(observation.content_hash);
    if (previous !== undefined && rowSchema.parse(previous).payload_json !== payload)
      throw new Error("content version hash collision");
    this.database
      .prepare("INSERT OR IGNORE INTO post_content_versions VALUES (?, ?, ?)")
      .run(observation.content_hash, observation.post_id, payload);
  }
  private insertObservation(contributor: string, observation: Observation): void {
    // Retry receipt time is excluded from identity; retain the earliest raw receipt.
    this.database
      .prepare(
        `INSERT INTO post_observations VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observation_id) DO UPDATE SET received_at = excluded.received_at, payload_json = excluded.payload_json
      WHERE excluded.received_at < post_observations.received_at`,
      )
      .run(
        observation.id,
        observation.post_id,
        contributor,
        observation.observed_at,
        observation.received_at,
        observation.content_hash,
        JSON.stringify(observation),
      );
  }
  recordBatch(tweets: readonly PooledTweet[], segmentKey: string): void {
    const positions = new Map<string, { operation: number; position: number }>();
    this.database.transaction(() => {
      for (const tweet of tweets) {
        const path = datasetPathFor(tweet.contributed_by, tweet.captured_at);
        const group = positions.get(path) ?? { operation: positions.size, position: 0 };
        this.record(tweet, { segmentKey, path, ...group });
        positions.set(path, { ...group, position: group.position + 1 });
      }
    })();
  }
  clearForRebuild(): void {
    this.database.transaction(() => {
      this.database.exec(
        "DELETE FROM observation_sources; DELETE FROM post_observations; DELETE FROM post_content_versions;",
      );
    })();
  }
}
export function sourceReference(source: ObservationSource): string {
  return createHash("sha256")
    .update(canonicalJson(sourceSchema.parse(source)))
    .digest("hex");
}
