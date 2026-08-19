import { verifyEnrichmentJobRevision } from "./enrich-job.js";
import { runPlannedEnrichmentCommand } from "./enrich-planned-command.js";

try {
  await verifyEnrichmentJobRevision(process.env);
  await runPlannedEnrichmentCommand(process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`[xtap-pool job] fatal: ${message}`);
  process.exitCode = 1;
}
