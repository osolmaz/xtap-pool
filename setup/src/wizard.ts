import {
  note,
  outro,
  password,
  spinner,
  text,
  confirm,
  intro,
  cancel,
  isCancel,
} from "@clack/prompts";
import { whoAmI } from "@huggingface/hub";

import type { SetupConfig } from "./config.js";
import {
  defaultSetupConfig,
  normalizeUsers,
  repoInNamespace,
  spacePublicUrl,
  tokenSettingsUrl,
  usersValue,
  validateNamespace,
  validateRepoId,
  validateUserList,
} from "./config.js";
import { deployPool } from "./deploy.js";
import { setSpaceSecret } from "./hub-api.js";
import { defaultTweetsDirectory, expandHomePath } from "./path.js";
import { captureCommand, inheritCommand } from "./process.js";
import { verifyDatasetWriteToken } from "./token.js";

export async function runSetupWizard(root: string): Promise<void> {
  intro("xtap-pool setup");
  const accessToken = await activeHfToken();
  const account = await whoAmI({ accessToken });
  const config = await promptConfig(account.name);
  await confirmPlan(config);
  const task = spinner();
  task.start("Creating repos, deploying Space, and setting generated secrets");
  await deployPool(root, { accessToken }, config);
  task.stop("Space deployed");
  const datasetToken = await promptDatasetToken(config.datasetRepo);
  await maybeSeed(root, config);
  await setSpaceSecret({ accessToken }, config.spaceRepo, "HF_TOKEN", datasetToken);
  outro(`Done. Explorer: ${spacePublicUrl(config.spaceRepo)}`);
}

async function activeHfToken(): Promise<string> {
  const result = await captureCommand("hf", ["auth", "token", "--quiet"]);
  const token = result.stdout.trim();
  if (token.length === 0) throw new Error("No active hf token. Run `hf auth login` first.");
  return token;
}

async function promptConfig(username: string): Promise<SetupConfig> {
  const defaults = defaultSetupConfig(username);
  const namespace = await promptText(
    "Hugging Face namespace",
    defaults.namespace,
    validateNamespace,
  );
  const spaceRepo = await promptText(
    "Space repo",
    repoInNamespace(namespace, "xtap-pool"),
    validateRepoId,
  );
  const datasetRepo = await promptText(
    "Private dataset repo",
    repoInNamespace(namespace, "xtap-pool-data"),
    validateRepoId,
  );
  const allowed = await promptText(
    "Allowed HF users",
    usersValue(defaults.allowedUsers),
    validateUserList,
  );
  return {
    namespace,
    spaceRepo,
    datasetRepo,
    allowedUsers: normalizeUsers(allowed),
  };
}

async function confirmPlan(config: SetupConfig): Promise<void> {
  note(
    [
      `Space: ${config.spaceRepo}`,
      `Dataset: ${config.datasetRepo}`,
      `Allowed users: ${usersValue(config.allowedUsers)}`,
    ].join("\n"),
    "Plan",
  );
  const ok = await confirm({ message: "Create/update these resources?", initialValue: true });
  if (isCancel(ok) || !ok) {
    cancel("Setup cancelled.");
    process.exit(130);
  }
}

async function promptDatasetToken(datasetRepo: string): Promise<string> {
  note(
    [
      `Create a fine-grained token scoped only to ${datasetRepo}.`,
      `Choose write access to contents/settings for that dataset.`,
      tokenSettingsUrl(),
    ].join("\n"),
    "Dataset token",
  );
  for (;;) {
    const token = await promptPassword("Paste the dataset-only HF_TOKEN");
    const report = await verifyDatasetWriteToken({ token, datasetRepo });
    if (report.ok) {
      note(`${report.tokenName || "token"} on ${report.username || "unknown account"}`, "Verified");
      return token;
    }
    note(report.errors.join("\n"), "Token refused");
  }
}

async function maybeSeed(root: string, config: SetupConfig): Promise<void> {
  const seed = await confirm({
    message: "Import existing xTap JSONL files now?",
    initialValue: false,
  });
  if (isCancel(seed) || !seed) return;
  const username = await promptText(
    "Imported tweets belong to which HF user?",
    config.allowedUsers[0] ?? config.namespace,
  );
  const source = await promptText("Existing xTap output directory", defaultTweetsDirectory());
  await inheritCommand(
    "scripts/seed-dataset.sh",
    [config.datasetRepo, username, expandHomePath(source)],
    { cwd: root },
  );
}

async function promptText(
  message: string,
  initialValue: string,
  validate?: (value: string) => string | undefined,
): Promise<string> {
  const value = await text(
    validate === undefined ? { message, initialValue } : { message, initialValue, validate },
  );
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(130);
  }
  return value;
}

async function promptPassword(message: string): Promise<string> {
  const value = await password({
    message,
    validate: (input) => (input ? undefined : "Token is required."),
  });
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(130);
  }
  return value;
}
