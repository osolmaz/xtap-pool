#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { cancel } from "@clack/prompts";

import { parseSetupCommand } from "./cli.js";
import { findProjectRoot } from "./root.js";
import { runSetupWizard, runUpdateCommand } from "./wizard.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = findProjectRoot(here);

try {
  const command = parseSetupCommand(process.argv.slice(2));
  if (command.kind === "setup") await runSetupWizard(root);
  else await runUpdateCommand(root, command.spaceRepo);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  cancel(message);
  process.exit(1);
}
