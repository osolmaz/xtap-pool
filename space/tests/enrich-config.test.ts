import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatasetMirror } from "../src/dataset.js";
import { DEFAULT_TAXONOMY, LABELS_CONFIG_PATH, loadEnrichTaxonomy } from "../src/enrich-config.js";
import { FakeHub } from "./helpers.js";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures/labels.json"), "utf8");

let dir: string;
let hub: FakeHub;
let mirror: DatasetMirror;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xtap-pool-enrich-config-"));
  hub = new FakeHub();
  mirror = new DatasetMirror(hub, dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadEnrichTaxonomy", () => {
  it("loads config/labels.json from the dataset", async () => {
    hub.files.set(LABELS_CONFIG_PATH, FIXTURE);
    const taxonomy = await loadEnrichTaxonomy(mirror, 2);
    expect(taxonomy.source).toBe("dataset");
    expect(taxonomy.version).toBe(2);
    expect(taxonomy.labels.map((label) => label.name)).toEqual(["ai", "local-models", "robotics"]);
  });

  it("falls back to the built-in taxonomy when the file is absent", async () => {
    const taxonomy = await loadEnrichTaxonomy(mirror, 1);
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

  it("falls back on invalid content", async () => {
    hub.files.set(LABELS_CONFIG_PATH, "not json");
    await expect(loadEnrichTaxonomy(mirror, 1)).resolves.toMatchObject({ source: "default" });
    hub.files.set(LABELS_CONFIG_PATH, JSON.stringify([{ name: "" }]));
    await expect(loadEnrichTaxonomy(mirror, 1)).resolves.toMatchObject({ source: "default" });
    hub.files.set(LABELS_CONFIG_PATH, "[]");
    await expect(loadEnrichTaxonomy(mirror, 1)).resolves.toMatchObject({ source: "default" });
  });
});
