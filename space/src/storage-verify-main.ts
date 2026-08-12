import { runStorageCommand } from "./storage-command.js";

try {
  await runStorageCommand("verify", process.argv.slice(2));
} catch (error) {
  console.error(
    `[xtap-pool storage verify] fatal: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
