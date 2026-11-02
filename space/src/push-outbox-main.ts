import { runPushOutbox, summarizePush } from "./push-outbox.js";

try {
  const result = await runPushOutbox(process.env);
  console.log(`[xtap-pool push-outbox] ${summarizePush(result)}`);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`[xtap-pool push-outbox] fatal: ${message}`);
  process.exitCode = 1;
}
