import { runStorageCommand } from "./storage-command.js";

try {
  await runStorageCommand("import", process.argv.slice(2));
} catch (error) {
  console.error(
    `[xtap-pool storage import] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
