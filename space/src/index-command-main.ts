import { runIndexCommand } from "./index-command.js";

const controller = new AbortController();
const stop = (): void => {
  controller.abort();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await runIndexCommand(process.env, controller.signal);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`[xtap-pool index] fatal: ${message}`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
