import { join } from "node:path";

import { commitEnrichmentBootstrap } from "./commit-enrichment-bootstrap.js";
import { loadConfig } from "./config.js";
import { createDurableIndexBucketClient } from "./durable-index.js";
import { createEnrichmentCheckpointStore } from "./enrich-checkpoint.js";
import { prepareEnrichmentBootstrap } from "./prepare-enrichment-bootstrap.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const workerRevision = requireEnvironment(process.env, "XTAP_SOURCE_REVISION");
  const attemptId = process.env["JOB_ID"] ?? `bootstrap-${process.pid.toString()}`;
  let lastStage = "";
  let lastCompleted = -1;
  const prepared = await prepareEnrichmentBootstrap({
    rawBucket: config.rawBucket,
    indexBucket: config.indexBucket,
    accessToken: config.hfToken,
    dataDir: join(config.dataDir, "bootstrap-run"),
    taxonomyVersion: config.taxonomyVersion,
    llmModel: config.llmModel,
    workerRevision,
    sourceReplayConcurrency: 4,
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
  const bucket = createDurableIndexBucketClient(config.indexBucket, config.hfToken);
  const store = createEnrichmentCheckpointStore({
    bucket: config.indexBucket,
    accessToken: config.hfToken,
  });
  const result = await commitEnrichmentBootstrap({
    prepared,
    bucket,
    store,
    attemptId,
    ...(process.env["JOB_ID"] === undefined ? {} : { jobId: process.env["JOB_ID"] }),
  });
  console.log(JSON.stringify(result));
}

function requireEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

try {
  await main();
} catch (error) {
  console.error(
    `[xtap-pool bootstrap] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
