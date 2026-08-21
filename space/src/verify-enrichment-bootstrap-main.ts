import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { createDurableIndexBucketReader } from "./durable-index.js";
import { prepareEnrichmentBootstrap } from "./prepare-enrichment-bootstrap.js";

const CURRENT_MANIFEST_KEY = "index/current.json";
const RUN_PREFIX = "operations/enrichment/runs";

async function main(): Promise<void> {
  if (process.env["INFERENCE_TOKEN"] !== undefined) {
    throw new Error("read-only bootstrap shadow must not receive INFERENCE_TOKEN");
  }
  const config = loadConfig({
    ...process.env,
    ENRICH_ENABLED: "false",
    INFERENCE_TOKEN: undefined,
  });
  const workerRevision = requireEnvironment(process.env, "XTAP_SOURCE_REVISION");
  const dataDir = join(config.dataDir, "bootstrap-shadow");
  await mkdir(dataDir, { recursive: true });
  const reader = createDurableIndexBucketReader(config.indexBucket, config.hfToken);
  const beforePointer = await reader.readText(CURRENT_MANIFEST_KEY);
  if (beforePointer === undefined) throw new Error("durable index manifest is missing");
  const beforeRuns = await reader.list(RUN_PREFIX);

  let lastStage = "";
  let lastCompleted = -1;
  const prepared = await prepareEnrichmentBootstrap({
    rawBucket: config.rawBucket,
    indexBucket: config.indexBucket,
    accessToken: config.hfToken,
    dataDir,
    taxonomyVersion: config.taxonomyVersion,
    llmModel: config.llmModel,
    workerRevision,
    sourceReplayConcurrency: numberEnvironment(process.env, "BOOTSTRAP_TAIL_CONCURRENCY", 4),
    progress: (progress) => {
      const interval = progress.unit === "bytes" ? 16 * 1024 * 1024 : 100;
      if (
        progress.stage !== lastStage ||
        progress.completed === progress.total ||
        progress.completed - lastCompleted >= interval
      ) {
        console.log(JSON.stringify({ type: "bootstrap-progress", ...progress }));
        lastStage = progress.stage;
        lastCompleted = progress.completed;
      }
      return Promise.resolve();
    },
  });

  assertExpected(
    process.env,
    "EXPECTED_BASE_DATABASE_SHA256",
    prepared.candidate.base_database.sha256,
  );
  assertExpectedNumber(process.env, "EXPECTED_QUEUE_TOTAL", prepared.candidate.queue.base_total);
  assertExpectedNumber(
    process.env,
    "EXPECTED_QUEUE_BASELINE_DONE",
    prepared.candidate.queue.baseline_done,
  );
  assertExpectedNumber(
    process.env,
    "EXPECTED_REGISTRY_BASELINE_SCANNED",
    prepared.candidate.registry.base_scanned,
  );
  assertExpectedNumber(
    process.env,
    "EXPECTED_REGISTRY_TOTAL",
    prepared.candidate.registry.base_total,
  );
  assertExpectedNumber(
    process.env,
    "EXPECTED_REGISTRY_REVISION",
    prepared.candidate.registry.revision,
  );

  const afterPointer = await reader.readText(CURRENT_MANIFEST_KEY);
  const afterRuns = await reader.list(RUN_PREFIX);
  if (afterPointer !== beforePointer) throw new Error("public pointer changed during shadow run");
  if (JSON.stringify(afterRuns) !== JSON.stringify(beforeRuns)) {
    throw new Error("active-run object listing changed during shadow run");
  }
  await writeFile(
    join(dataDir, "candidate.json"),
    `${JSON.stringify(prepared.candidate, null, 2)}\n`,
    { encoding: "utf8" },
  );
  console.log(
    JSON.stringify({
      type: "bootstrap-shadow-complete",
      candidate_sha256: prepared.candidate.candidate_sha256,
      run_object_count: afterRuns.length,
      provider_calls: 0,
    }),
  );
}

function requireEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function numberEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new Error(`${name} must be an integer from 1 through 16`);
  }
  return value;
}

function assertExpected(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  actual: string,
): void {
  const expected = env[name];
  if (expected !== undefined && expected !== actual) throw new Error(`${name} does not match`);
}

function assertExpectedNumber(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  actual: number,
): void {
  const expected = env[name];
  if (expected !== undefined && Number(expected) !== actual) {
    throw new Error(`${name} does not match`);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `[xtap-pool bootstrap shadow] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
