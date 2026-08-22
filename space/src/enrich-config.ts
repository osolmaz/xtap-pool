import { z } from "zod";

import { labelConfigSchema } from "@xtap-pool/shared";
import type { LabelConfig } from "@xtap-pool/shared";

import type { ReadTextOptions, StorageLog } from "./bucket-log.js";

/** Bucket logical path of the preset taxonomy: an array of `{name, description}`. */
export const LABELS_CONFIG_PATH = "config/labels.json";

export type EnrichTaxonomy = {
  labels: readonly LabelConfig[];
  version: number;
  source: "bucket" | "default";
  error?: string;
};

/** Built-in taxonomy used until `config/labels.json` exists in the raw Bucket log. */
export const DEFAULT_TAXONOMY: readonly LabelConfig[] = [
  {
    name: "ai",
    description:
      "Anything about artificial intelligence or machine learning: models, products, research, opinions, industry news.",
  },
  {
    name: "local-models",
    description:
      "Running open-weight models locally or on self-hosted hardware: llama.cpp, vLLM, Ollama, GGUF releases, on-device inference.",
  },
  {
    name: "inference-performance",
    description:
      "LLM inference speed and efficiency: latency, throughput, tokens per second, benchmarks, serving optimizations, KV cache.",
  },
  {
    name: "quantization",
    description:
      "Model quantization and compression: GGUF, AWQ, GPTQ, FP8/INT4 formats, quality-versus-size tradeoffs.",
  },
  {
    name: "ai-hardware",
    description:
      "Hardware for AI workloads: GPUs, accelerators, memory bandwidth, DGX-class machines, Apple Silicon, edge devices.",
  },
  {
    name: "agents",
    description:
      "AI agents and agentic workflows: coding agents, tool use, multi-agent systems, agent frameworks and harnesses.",
  },
  {
    name: "ai-research",
    description:
      "Research results and methods: papers, architectures, training techniques, evaluations, scaling studies.",
  },
  {
    name: "ai-tooling",
    description:
      "Developer tooling around AI: SDKs, APIs, orchestration, evaluation harnesses, MCP, IDE integrations.",
  },
];

const labelsFileSchema = z.array(labelConfigSchema).min(1);

/**
 * Load the preset taxonomy from `config/labels.json` in the pool Bucket log,
 * falling back to the built-in default when the file is absent or invalid.
 * The taxonomy version comes from the environment (`TAXONOMY_VERSION`).
 */
export async function loadEnrichTaxonomy(
  log: Pick<StorageLog, "readText">,
  version: number,
  readOptions?: ReadTextOptions,
): Promise<EnrichTaxonomy> {
  let raw: string | undefined;
  try {
    raw = await log.readText(LABELS_CONFIG_PATH, readOptions);
  } catch (error) {
    return { labels: DEFAULT_TAXONOMY, version, source: "default", error: errorMessage(error) };
  }
  if (raw === undefined) return { labels: DEFAULT_TAXONOMY, version, source: "default" };
  return parseEnrichTaxonomyText(raw, version);
}

export function parseEnrichTaxonomyText(raw: string, version: number): EnrichTaxonomy {
  try {
    const labels = labelsFileSchema.parse(JSON.parse(raw));
    return { labels, version, source: "bucket" };
  } catch {
    return { labels: DEFAULT_TAXONOMY, version, source: "default" };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
