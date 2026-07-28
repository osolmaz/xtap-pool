import { main } from "./enrich-command.js";
import { verifyEnrichmentJobRevision } from "./enrich-job.js";

try {
  await verifyEnrichmentJobRevision(process.env);
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`[xtap-pool job] fatal: ${message}`);
  process.exitCode = 1;
}
