import { createHash } from "node:crypto";

/**
 * Semantic hashes that decide whether a stored enrichment result is current.
 *
 * `input_hash` covers the ordered semantic input we feed the model. Metrics
 * (captured_at, like counts, contributor stamp) do not participate.
 *
 * `contract_hash` covers the classifier's behavior: taxonomy, prompt template,
 * output schema, normalization rules, model and processor version. Any change
 * to any of these must alter the hash so existing results stop counting as
 * current until they are re-inferred.
 */

import type { PooledTweet } from "./tweet.js";
import type { LabelConfig } from "./enrichment.js";

/**
 * Bump when prompt/schema/normalization change in a way that requires
 * re-inference of previously classified units.
 */
export const PROCESSOR_VERSION = 1;

/**
 * Freezes the fields of a tweet that affect classification. Metrics or
 * per-capture attribution are excluded so a re-capture with the same text
 * does not invalidate the current result.
 */
export type SemanticTweetFields = {
  id: string;
  text: string;
  conversation_id: string | undefined;
  author_id: string | undefined;
  author_username: string;
  reply_to: string | undefined;
  quoted_status_id: string | undefined;
  expanded_urls: readonly string[];
  is_subscriber_only: boolean;
  is_retweet: boolean;
};

function firstStringField(tweet: PooledTweet, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = tweet[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function firstBooleanField(tweet: PooledTweet, keys: readonly string[]): boolean {
  for (const key of keys) {
    const value = tweet[key];
    if (value === true) return true;
  }
  return false;
}

function collectStringArray(value: unknown, into: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) into.add(entry);
  }
}

function collectEntityUrls(entities: unknown, into: Set<string>): void {
  if (typeof entities !== "object" || entities === null) return;
  const urls = (entities as Record<string, unknown>)["urls"];
  if (!Array.isArray(urls)) return;
  for (const entry of urls) addEntityUrl(entry, into);
}

function addEntityUrl(entry: unknown, into: Set<string>): void {
  if (typeof entry !== "object" || entry === null) return;
  const value = (entry as Record<string, unknown>)["expanded_url"];
  if (typeof value === "string" && value.length > 0) into.add(value);
}

function expandedUrls(tweet: PooledTweet): string[] {
  const collected = new Set<string>();
  collectStringArray(tweet["expanded_urls"], collected);
  collectEntityUrls(tweet["entities"], collected);
  return [...collected].sort();
}

/** Extract the classification-relevant fields of one tweet. */
export function semanticTweetFields(tweet: PooledTweet): SemanticTweetFields {
  return {
    id: tweet.id,
    text: tweet.text,
    conversation_id: firstStringField(tweet, ["conversation_id"]),
    author_id: typeof tweet.author.id === "string" ? tweet.author.id : undefined,
    author_username: tweet.author.username.toLowerCase(),
    reply_to: firstStringField(tweet, [
      "in_reply_to_status_id",
      "in_reply_to_tweet_id",
      "reply_to_status_id",
    ]),
    quoted_status_id: firstStringField(tweet, [
      "quoted_status_id",
      "quoted_tweet_id",
      "quote_status_id",
    ]),
    expanded_urls: expandedUrls(tweet),
    is_subscriber_only: firstBooleanField(tweet, ["is_subscriber_only"]),
    is_retweet: firstBooleanField(tweet, ["is_retweet"]),
  };
}

/**
 * Deterministic canonical JSON: object keys are sorted, arrays retain order.
 * `undefined` values are dropped so the presence of an optional field does
 * not depend on whether the caller passed the key.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Semantic hash of a unit's classification input. Members are sorted by
 * tweet id so shard replay order cannot change the hash.
 */
export function computeInputHash(unitId: string, members: readonly SemanticTweetFields[]): string {
  const sorted = [...members].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return sha256Hex(canonicalJson({ unit_id: unitId, members: sorted }));
}

/** Same, but built from raw tweets — a convenience for the hot path. */
export function computeInputHashFromTweets(unitId: string, tweets: readonly PooledTweet[]): string {
  return computeInputHash(
    unitId,
    tweets.map((tweet) => semanticTweetFields(tweet)),
  );
}

/** Fields that together identify the classifier contract. */
export type ContractInput = {
  taxonomy_version: number;
  labels: readonly LabelConfig[];
  model: string;
  processor_version: number;
  prompt_template_id: string;
  output_schema_id: string;
  normalization_id: string;
};

/**
 * Deterministic hash of the classifier contract. Labels are sorted by name so
 * cosmetic reordering does not invalidate the whole backlog.
 */
export function computeContractHash(contract: ContractInput): string {
  const canonical = {
    taxonomy_version: contract.taxonomy_version,
    model: contract.model,
    processor_version: contract.processor_version,
    prompt_template_id: contract.prompt_template_id,
    output_schema_id: contract.output_schema_id,
    normalization_id: contract.normalization_id,
    labels: [...contract.labels]
      .map((label) => ({ name: label.name, description: label.description }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  };
  return sha256Hex(canonicalJson(canonical));
}
