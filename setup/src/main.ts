#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { cancel } from "@clack/prompts";

import { parseSetupCommand } from "./cli.js";
import { runDoctor } from "./doctor.js";
import { repoInNamespace } from "./config.js";
import { findProjectRoot } from "./root.js";
import { activeHfToken, runSetupWizard, runUpdateCommand } from "./wizard.js";
import { whoAmI } from "@huggingface/hub";

const here = dirname(fileURLToPath(import.meta.url));
const root = findProjectRoot(here);

try {
  const command = parseSetupCommand(process.argv.slice(2));
  if (command.kind === "setup") await runSetupWizard(root);
  else if (command.kind === "update")
    await runUpdateCommand(root, command.spaceRepo, { verifiedBucketCutover: command.cutover });
  else {
    const accessToken = await activeHfToken();
    const account = await whoAmI({ accessToken });
    const report = await runDoctor({ accessToken }, account.name, {
      spaceRepo: command.spaceRepo ?? repoInNamespace(account.name, "xtap-pool"),
      json: command.json,
      fix: command.fix,
      canary: command.canary,
      ...(command.resumeCanaryJobId === undefined
        ? {}
        : { resumeCanaryJobId: command.resumeCanaryJobId }),
      enableSchedule: command.enableSchedule,
    });
    if (report.summary.fail > 0) process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  cancel(message);
  process.exit(1);
}
