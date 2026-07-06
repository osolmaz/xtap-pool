#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { cancel } from "@clack/prompts";

import { findProjectRoot } from "./root.js";
import { runSetupWizard } from "./wizard.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = findProjectRoot(here);

try {
  await runSetupWizard(root);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  cancel(message);
  process.exit(1);
}
