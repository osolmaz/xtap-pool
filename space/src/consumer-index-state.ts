import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonicalJson } from "@xtap-pool/shared";
import type { SourceCounts } from "./bucket-log.js";
import type { EnrichStore } from "./enrich-store.js";
import { consumerRegistry, consumerRegistrySchema } from "./consumer-registry.js";

/** Separate from the LLM contract: rebuilding this projection must not invalidate AI results. */
export const CONSUMER_PROJECTION_HASH = createHash("sha256")
  .update(
    canonicalJson({
      schema_version: 1,
      observations: "exact-v1, unmarked zero is unknown, physical provenance",
      content: "exclude observation fields and followers; current content-run clock",
      posts: "observed time, private first, content hash, contributor",
      results:
        "newest applicable result by UTC time and hash; reuse exact input; account for unsupported rows",
      registry: "frozen actual approved state, not raw revision inference",
      changes: "exact source membership, historical author-ID and reverse dependencies",
    }),
  )
  .digest("hex");

const stateSchema = z
  .object({
    source: z.string().regex(/^[a-f0-9]{64}$/u),
    projection: z.literal(CONSUMER_PROJECTION_HASH),
    contract: z.string().min(1),
    registry: consumerRegistrySchema,
  })
  .strict();
const jsonRowSchema = z.object({ payload_json: z.string() });
const countsSchema = z.object({
  observations: z.number().int(),
  memberships: z.number().int(),
  results: z.number().int(),
});
export type ConsumerIndexBoundary = z.infer<typeof stateSchema>;
export class ConsumerBootstrapRequired extends Error {
  constructor() {
    super("consumer history projection is unavailable; explicit index bootstrap is required");
  }
}

/** This row commits with source_segments. Empty tables on an old DB are not complete history. */
export class ConsumerIndexState {
  constructor(
    private readonly database: Database.Database,
    private readonly contract: string,
    mode: "read" | "write" = "write",
  ) {
    if (mode === "write")
      database.exec(`CREATE TABLE IF NOT EXISTS consumer_index_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
    ) STRICT`);
  }

  require(source: string): ConsumerIndexBoundary {
    const raw = this.database
      .prepare("SELECT payload_json FROM consumer_index_state WHERE singleton = 1")
      .get();
    if (raw === undefined) throw new ConsumerBootstrapRequired();
    const parsed = stateSchema.safeParse(JSON.parse(jsonRowSchema.parse(raw).payload_json));
    if (!parsed.success || parsed.data.source !== source || parsed.data.contract !== this.contract)
      throw new ConsumerBootstrapRequired();
    return parsed.data;
  }

  canAdvance(previousSource: string | undefined): boolean {
    if (previousSource === undefined)
      return this.database.prepare("SELECT 1 FROM source_segments LIMIT 1").get() === undefined;
    try {
      this.require(previousSource);
      return true;
    } catch (error) {
      if (error instanceof ConsumerBootstrapRequired) return false;
      throw error;
    }
  }

  commit(source: string, enrich: EnrichStore, complete: boolean): void {
    if (!this.database.inTransaction)
      throw new Error("consumer boundary must commit with its source transaction");
    if (!complete) {
      this.database.prepare("DELETE FROM consumer_index_state").run();
      return;
    }
    const state = stateSchema.parse({
      source,
      projection: CONSUMER_PROJECTION_HASH,
      contract: this.contract,
      registry: consumerRegistry(enrich),
    });
    this.database
      .prepare(
        `INSERT INTO consumer_index_state VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET payload_json = excluded.payload_json`,
      )
      .run(canonicalJson(state));
  }

  /** Check only the new segment's indexed metadata, never a full historical payload scan. */
  verifySegment(key: string, expected: SourceCounts): void {
    const actual = countsSchema.parse(
      this.database
        .prepare(
          `SELECT
      (SELECT COUNT(*) FROM observation_sources WHERE segment_key = @key) AS observations,
      (SELECT COUNT(*) FROM consumer_post_units u JOIN observation_sources s ON s.source_ref = u.source_ref WHERE s.segment_key = @key) AS memberships,
      (SELECT COUNT(*) FROM consumer_result_sources WHERE segment_key = @key) AS results`,
        )
        .get({ key }),
    );
    if (
      actual.observations !== expected.tweet ||
      actual.memberships !== expected.tweet ||
      actual.results !== expected.enrichment
    )
      throw new Error("consumer segment projection is incomplete");
  }
}
