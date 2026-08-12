import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_TAXONOMY, LABELS_CONFIG_PATH, loadEnrichTaxonomy } from "../src/enrich-config.js";
import { FakeLog } from "./fake-log.js";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures/labels.json"), "utf8");

let dir: string;
let log: FakeLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xtap-pool-enrich-config-"));
  log = new FakeLog();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadEnrichTaxonomy", () => {
  it("loads config/labels.json from the raw Bucket", async () => {
    log.files.set(LABELS_CONFIG_PATH, FIXTURE);
    const taxonomy = await loadEnrichTaxonomy(log, 2);
    expect(taxonomy.source).toBe("bucket");
    expect(taxonomy.version).toBe(2);
    expect(taxonomy.labels.map((label) => label.name)).toEqual(["ai", "local-models", "robotics"]);
  });

  it("falls back to the built-in taxonomy when the file is absent", async () => {
    const taxonomy = await loadEnrichTaxonomy(log, 1);
    expect(taxonomy.source).toBe("default");
    expect(taxonomy.labels).toBe(DEFAULT_TAXONOMY);
    expect(taxonomy.labels.map((label) => label.name)).toEqual([
      "ai",
      "local-models",
      "inference-performance",
      "quantization",
      "ai-hardware",
      "agents",
      "ai-research",
      "ai-tooling",
    ]);
  });

  it("falls back with a retryable error when the config cannot be read", async () => {
    log.failReadAttempts = 1;
    await expect(loadEnrichTaxonomy(log, 1)).resolves.toMatchObject({
      source: "default",
      error: "Bucket unavailable",
    });
  });

  it("falls back on invalid content", async () => {
    log.files.set(LABELS_CONFIG_PATH, "not json");
    await expect(loadEnrichTaxonomy(log, 1)).resolves.toMatchObject({ source: "default" });
    log.files.set(LABELS_CONFIG_PATH, JSON.stringify([{ name: "" }]));
    await expect(loadEnrichTaxonomy(log, 1)).resolves.toMatchObject({ source: "default" });
    log.files.set(LABELS_CONFIG_PATH, "[]");
    await expect(loadEnrichTaxonomy(log, 1)).resolves.toMatchObject({ source: "default" });
  });
});
