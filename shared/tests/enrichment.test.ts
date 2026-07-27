import { describe, expect, it } from "vitest";

import {
  attemptEventPathFor,
  attemptEventSchema,
  enrichmentPathFor,
  enrichmentRowSchema,
  isCurrentEnrichmentRow,
  labelConfigSchema,
  parseEnrichmentRow,
  receiptPathFor,
  registryEventPathFor,
  slugifyFreeLabel,
  unitIdFor,
} from "../src/index.js";

function tweet(overrides: Record<string, unknown> = {}): {
  id: string;
  url: string;
  text: string;
  captured_at: string;
  author: { username: string };
} & Record<string, unknown> {
  return {
    id: "100",
    url: "https://x.com/someone/status/100",
    text: "hello",
    captured_at: "2026-07-06T00:00:00.000Z",
    author: { username: "Someone" },
    ...overrides,
  };
}

describe("enrichmentRowSchema", () => {
  it("accepts a full evidence-bearing row", () => {
    const parsed = enrichmentRowSchema.parse({
      unit_id: "100:someone",
      tweet_ids: ["100"],
      input_hash: "a".repeat(64),
      contract_hash: "b".repeat(64),
      preset_labels: [{ name: "ai", evidence: [{ tweet_id: "100", quote: "frontier AI" }] }],
      free_labels: [
        { name: "open-weight-model", evidence: [{ tweet_id: "100", quote: "open-weight" }] },
      ],
      model: "zai-org/GLM-5.2",
      taxonomy_version: 1,
      enriched_at: "2026-07-06T00:00:00.000Z",
    });
    expect(parsed.preset_labels[0]?.evidence[0]?.quote).toBe("frontier AI");
    expect(isCurrentEnrichmentRow(parsed)).toBe(true);
  });

  it("ignores legacy rows with a previous output contract", () => {
    const parsed = parseEnrichmentRow({
      unit_id: "100:someone",
      tweet_ids: ["100"],
      labels: ["ai"],
      free_labels: ["dgx-spark"],
      concepts: [{ name: "vLLM", aliases: ["VLLM"] }],
      model: "m",
      taxonomy_version: 1,
      enriched_at: "2026-07-06T00:00:00.000Z",
    });
    expect(parsed).toBeUndefined();
  });

  it("rejects incomplete, legacy-shaped, and extra-key rows", () => {
    const base = {
      unit_id: "u",
      tweet_ids: ["1"],
      input_hash: "input",
      contract_hash: "contract",
      preset_labels: [],
      free_labels: [],
      model: "m",
      taxonomy_version: 1,
      enriched_at: "t",
    };
    expect(enrichmentRowSchema.safeParse({ ...base, tweet_ids: [] }).success).toBe(false);
    expect(enrichmentRowSchema.safeParse({ ...base, taxonomy_version: 0 }).success).toBe(false);
    expect(enrichmentRowSchema.safeParse({ ...base, tweet_ids: ["1", "1"] }).success).toBe(false);
    expect(enrichmentRowSchema.safeParse({ ...base, concepts: [] }).success).toBe(false);
    expect(enrichmentRowSchema.safeParse({ ...base, free_labels: undefined }).success).toBe(false);
    expect(labelConfigSchema.safeParse({ name: "", description: "x" }).success).toBe(false);
  });
});

describe("unitIdFor", () => {
  it("keys by conversation and lowercased author, falling back to the tweet id", () => {
    expect(unitIdFor(tweet())).toBe("100:someone");
    expect(unitIdFor(tweet({ conversation_id: "42" }))).toBe("42:someone");
    expect(unitIdFor(tweet({ conversation_id: 42 }))).toBe("42:someone");
    expect(unitIdFor(tweet({ conversation_id: "" }))).toBe("100:someone");
    expect(unitIdFor(tweet({ conversation_id: null }))).toBe("100:someone");
  });
});

describe("slugifyFreeLabel", () => {
  it("slugifies names case-insensitively with diacritics stripped", () => {
    expect(slugifyFreeLabel("DGX Spark")).toBe("dgx-spark");
    expect(slugifyFreeLabel("  Mixture-of-Experts (MoE)! ")).toBe("mixture-of-experts-moe");
    expect(slugifyFreeLabel("Café Étude")).toBe("cafe-etude");
    expect(slugifyFreeLabel("???")).toBe("");
  });
});

describe("dataset paths", () => {
  it("derives enrichment, attempt, registry and receipt paths from timestamps", () => {
    expect(enrichmentPathFor("2026-07-06T12:34:56.000Z")).toBe(
      "enrichment/2026/07/enrichment-2026-07-06.jsonl",
    );
    expect(receiptPathFor("2026-07-06T12:34:56.000Z")).toBe("enrichment/receipts/2026-07-06.jsonl");
    expect(attemptEventPathFor("2026-07-06T12:34:56.000Z")).toBe(
      "enrichment/attempts/2026/07/attempts-2026-07-06.jsonl",
    );
    expect(registryEventPathFor("2026-07-06T12:34:56.000Z")).toBe(
      "enrichment/registry/2026/07/registry-2026-07-06.jsonl",
    );
  });
});

describe("attemptEventSchema", () => {
  it("accepts a valid attempt event", () => {
    const parsed = attemptEventSchema.parse({
      unit_id: "100:someone",
      input_hash: "a".repeat(64),
      contract_hash: "b".repeat(64),
      attempt: 3,
      outcome: "transient_failure",
      error_class: "timeout",
      error_message: "router timed out",
      at: "2026-07-06T00:00:00.000Z",
      next_retry_at: "2026-07-06T00:05:00.000Z",
    });
    expect(parsed.outcome).toBe("transient_failure");
  });

  it("rejects invalid outcomes and error classes", () => {
    expect(
      attemptEventSchema.safeParse({
        unit_id: "u",
        input_hash: "h",
        contract_hash: "c",
        attempt: 1,
        outcome: "not-real",
        at: "2026-07-06T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
