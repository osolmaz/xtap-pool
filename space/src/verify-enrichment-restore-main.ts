import { createDurableIndexBucketReader } from "./durable-index.js";
import { verifyEnrichmentJobRevision } from "./enrich-job.js";
import { runPlannedEnrichmentCommand } from "./enrich-planned-command.js";

const CURRENT_MANIFEST_KEY = "index/current.json";
const RUN_PREFIX = "operations/enrichment/runs";

async function main(): Promise<void> {
  if (process.env["INFERENCE_TOKEN"] !== undefined) {
    throw new Error("restore-only validation must not receive INFERENCE_TOKEN");
  }
  const indexBucket = requireEnvironment(process.env, "INDEX_BUCKET");
  const hfToken = requireEnvironment(process.env, "HF_TOKEN");
  const reader = createDurableIndexBucketReader(indexBucket, hfToken);
  const beforePointer = await reader.readText(CURRENT_MANIFEST_KEY);
  if (beforePointer === undefined) throw new Error("durable index manifest is missing");
  const beforeRuns = await reader.list(RUN_PREFIX);

  const deploymentManifest = await verifyEnrichmentJobRevision(process.env);
  await runPlannedEnrichmentCommand(
    { ...process.env, XTAP_RESTORE_ONLY: "true" },
    { deploymentManifest },
  );

  const afterPointer = await reader.readText(CURRENT_MANIFEST_KEY);
  const afterRuns = await reader.list(RUN_PREFIX);
  if (afterPointer !== beforePointer) throw new Error("public pointer changed during restore");
  if (JSON.stringify(afterRuns) !== JSON.stringify(beforeRuns)) {
    throw new Error("active-run object listing changed during restore");
  }
  console.log(
    JSON.stringify({
      type: "restore-no-write-proof",
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

try {
  await main();
} catch (error) {
  console.error(
    `[xtap-pool restore validation] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
