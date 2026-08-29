import { createReadOnlyEnrichmentCheckpointStore } from "./enrich-checkpoint.js";
import { prepareOptionalEnrichmentRevisionHandoff } from "./enrich-revision-handoff.js";

async function main(): Promise<void> {
  if (process.env["INFERENCE_TOKEN"] !== undefined) {
    throw new Error("revision handoff preparation must not receive INFERENCE_TOKEN");
  }
  const handoff = await prepareOptionalEnrichmentRevisionHandoff({
    store: createReadOnlyEnrichmentCheckpointStore({
      bucket: requireEnvironment("INDEX_BUCKET"),
      accessToken: requireEnvironment("HF_TOKEN"),
    }),
    targetWorkerRevision: requireEnvironment("XTAP_TARGET_SOURCE_REVISION"),
  });
  console.log(JSON.stringify(handoff));
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
