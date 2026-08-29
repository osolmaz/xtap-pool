import { createReadOnlyEnrichmentCheckpointStore } from "./enrich-checkpoint.js";
import { validatePreparedEnrichmentWorkerOutputs } from "./enrich-planned-command.js";
import { prepareOptionalEnrichmentRevision } from "./enrich-revision-handoff.js";

async function main(): Promise<void> {
  if (process.env["INFERENCE_TOKEN"] !== undefined) {
    throw new Error("revision handoff preparation must not receive INFERENCE_TOKEN");
  }
  const indexBucket = requireEnvironment("INDEX_BUCKET");
  const rawBucket = requireEnvironment("RAW_BUCKET");
  const accessToken = requireEnvironment("HF_TOKEN");
  const targetWorkerRevision = requireEnvironment("XTAP_TARGET_SOURCE_REVISION");
  const store = createReadOnlyEnrichmentCheckpointStore({
    bucket: indexBucket,
    accessToken,
  });
  const preparedRevision = await prepareOptionalEnrichmentRevision({
    store,
    targetWorkerRevision,
  });
  if (preparedRevision !== null) {
    await validatePreparedEnrichmentWorkerOutputs({
      preparedRevision,
      checkpointStore: store,
      rawBucket,
      accessToken,
      dataDir: requireEnvironment("DATA_DIR"),
    });
  }
  console.log(JSON.stringify(preparedRevision?.handoff ?? null));
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

try {
  await main();
} catch (error) {
  console.error(
    `[xtap-pool handoff preparation] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
