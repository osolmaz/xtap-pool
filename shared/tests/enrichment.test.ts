import { describe, expect, it } from "vitest";

import {
  enrichmentPathFor,
  enrichmentRowSchema,
  labelConfigSchema,
  mergeConceptEntry,
  parseVocabularyJson,
  receiptPathFor,
  slugifyConcept,
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
  it("accepts a full row and defaults concept aliases", () => {
    const parsed = enrichmentRowSchema.parse({
      unit_id: "100:someone",
      tweet_ids: ["100"],
      labels: ["ai"],
      free_labels: ["dgx-spark"],
      concepts: [{ name: "DGX Spark" }],
      model: "zai-org/GLM-5.2",
      taxonomy_version: 1,
      enriched_at: "2026-07-06T00:00:00.000Z",
    });
    expect(parsed.concepts[0]?.aliases).toEqual([]);
  });

  it("rejects rows without tweets or with a bad taxonomy version", () => {
    const base = {
      unit_id: "u",
      tweet_ids: ["1"],
      labels: [],
      free_labels: [],
      concepts: [],
      model: "m",
      taxonomy_version: 1,
      enriched_at: "t",
    };
    expect(enrichmentRowSchema.safeParse({ ...base, tweet_ids: [] }).success).toBe(false);
    expect(enrichmentRowSchema.safeParse({ ...base, taxonomy_version: 0 }).success).toBe(false);
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

describe("slugifyConcept", () => {
  it("slugifies names case-insensitively with diacritics stripped", () => {
    expect(slugifyConcept("DGX Spark")).toBe("dgx-spark");
    expect(slugifyConcept("  Mixture-of-Experts (MoE)! ")).toBe("mixture-of-experts-moe");
    expect(slugifyConcept("Café Étude")).toBe("cafe-etude");
    expect(slugifyConcept("???")).toBe("");
  });
});

describe("mergeConceptEntry", () => {
  it("keeps the existing canonical name and unions aliases case-insensitively", () => {
    const merged = mergeConceptEntry(
      { name: "DGX Spark", aliases: ["Spark"] },
      { name: "dgx spark", aliases: ["SPARK", "GB10 box"] },
    );
    expect(merged.name).toBe("DGX Spark");
    expect(merged.aliases).toEqual(["Spark", "GB10 box"]);
  });

  it("keeps a differently-written incoming name as an alias", () => {
    const merged = mergeConceptEntry(
      { name: "KV Cache", aliases: [] },
      { name: "KV-cache", aliases: [] },
    );
    expect(merged).toEqual({ name: "KV Cache", aliases: ["KV-cache"] });
  });

  it("never lists the canonical name among its own aliases", () => {
    const merged = mergeConceptEntry(undefined, {
      name: "vLLM",
      aliases: ["VLLM", "vllm", " vLLM "],
    });
    expect(merged.name).toBe("vLLM");
    expect(merged.aliases).toEqual([]);
  });
});

describe("dataset paths", () => {
  it("derives enrichment shard and receipt paths from timestamps", () => {
    expect(enrichmentPathFor("2026-07-06T12:34:56.000Z")).toBe(
      "enrichment/2026/07/enrichment-2026-07-06.jsonl",
    );
    expect(receiptPathFor("2026-07-06T12:34:56.000Z")).toBe("enrichment/receipts/2026-07-06.jsonl");
  });
});

describe("parseVocabularyJson", () => {
  it("parses valid vocabulary files and tolerates garbage", () => {
    const valid = JSON.stringify({
      version: 1,
      updated_at: "2026-07-06T00:00:00.000Z",
      concepts: [{ slug: "vllm", name: "vLLM", aliases: ["VLLM"] }],
    });
    expect(parseVocabularyJson(valid)).toEqual([{ slug: "vllm", name: "vLLM", aliases: ["VLLM"] }]);
    expect(parseVocabularyJson("not json")).toEqual([]);
    expect(parseVocabularyJson('{"version": 2}')).toEqual([]);
  });
});
