import { runIndexCommand } from "./index-command.js";

try {
  await runIndexCommand(process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`[xtap-pool index] fatal: ${message}`);
  process.exitCode = 1;
}
