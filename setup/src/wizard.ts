import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { datasetInfo, downloadFile, whoAmI } from "@huggingface/hub";

import type { SetupConfig } from "./config.js";
import {
  defaultSetupConfig,
  existingSpaceConfig,
  normalizeUsers,
  repoInNamespace,
  spacePublicUrl,
  tokenSettingsUrl,
  usersValue,
  validateNamespace,
  validateRepoId,
  validateUserList,
} from "./config.js";
import { deployPool, ensureIndexBucket, updateExistingPool } from "./deploy.js";
import {
  createEnrichmentDeploymentManifestPreparer,
  productionEnrichmentHandoffPreparation,
} from "./enrichment-handoff.js";
import {
  desiredEnrichmentJob,
  ENRICHMENT_JOB_DEFAULT_VARIABLES,
  finalizeEnrichmentScheduleUpdate,
  quiesceCanonicalEnrichmentSchedule,
  quiesceEnrichmentWriters,
  reconcileEnrichmentJob,
} from "./enrichment-job.js";
import {
  getSpaceVariables,
  pauseSpaceRuntime,
  restartSpaceRuntime,
  setSpaceSecret,
  waitForSpaceStage,
} from "./hub-api.js";
import { captureCommand, inheritCommand } from "./process.js";
import { verifyInferenceToken } from "./inference-token.js";
import { verifyStorageWriteToken } from "./token.js";

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
  const storageToken = await promptStorageToken(config.rawBucket, config.indexBucket);
  await setSpaceSecret({ accessToken }, config.spaceRepo, "HF_TOKEN", storageToken);
  await initializeStorage(root, config, storageToken);
  await bootstrapIndex(root, config, storageToken);
  await inheritCommand("hf", ["spaces", "restart", config.spaceRepo, "--format", "json"]);
  await inheritCommand("hf", [
    "spaces",
    "wait",
    config.spaceRepo,
    "--timeout",
    "10m",
    "--format",
    "json",
  ]);
  const inferenceToken = await promptInferenceToken();
  const variables = await getSpaceVariables({ accessToken }, config.spaceRepo);
  const desired = await desiredEnrichmentJob(
    { accessToken },
    config.spaceRepo,
    config.rawBucket,
    variables,
  );
  await reconcileEnrichmentJob({ accessToken }, desired, { storageToken, inferenceToken });
  outro(
    `Done. Explorer: ${spacePublicUrl(config.spaceRepo)}\nEnrichment Job: created and suspended pending its recovery canary.`,
  );
}

export async function runUpdateCommand(
  root: string,
  requestedSpaceRepo?: string,
  options: { cutoverReport?: string } = {},
): Promise<void> {
  intro("xtap-pool update");
  const accessToken = await activeHfToken();
  const account = await whoAmI({ accessToken });
  const spaceRepo = requestedSpaceRepo ?? repoInNamespace(account.name, "xtap-pool");
  const variables = await getSpaceVariables({ accessToken }, spaceRepo);
  const config = existingSpaceConfig(account.name, spaceRepo, variables);
  const legacyDataset = variables.get("DATASET_REPO");
  const legacy = legacyDataset !== undefined;
  if (legacyDataset !== undefined) {
    await beginLegacyCutover(
      root,
      { accessToken },
      config,
      variables,
      legacyDataset,
      options.cutoverReport,
    );
  }
  await finishUpdate(root, { accessToken }, config, variables, legacy);
}

async function finishUpdate(
  root: string,
  client: { accessToken: string },
  config: SetupConfig,
  variables: ReadonlyMap<string, string>,
  legacy: boolean,
): Promise<void> {
  const indexBucketCreated = await ensureIndexBucket(client, config.indexBucket);
  let storageToken: string | undefined;
  if (
    indexBucketCreated ||
    !(await durableIndexManifestExists(client.accessToken, config.indexBucket))
  ) {
    storageToken = await promptStorageToken(config.rawBucket, config.indexBucket);
    await bootstrapIndex(root, config, storageToken, indexContractFromVariables(variables));
    await setSpaceSecret(client, config.spaceRepo, "HF_TOKEN", storageToken);
  }
  storageToken ??= await promptExistingStorageToken();
  const scheduleWasActive = await quiesceCanonicalEnrichmentSchedule({
    client,
    spaceRepo: config.spaceRepo,
    rawBucket: config.rawBucket,
    variables,
  });
  const scheduleSecrets = scheduleWasActive
    ? { storageToken, inferenceToken: await promptInferenceToken() }
    : undefined;
  await inheritCommand("npm", ["run", "build", "--workspace", "space"], { cwd: root });
  const prepareDeploymentManifest = createEnrichmentDeploymentManifestPreparer(
    productionEnrichmentHandoffPreparation({
      root,
      client,
      config,
      variables,
      storageToken,
    }),
  );
  const task = spinner();
  task.start(`Updating ${config.spaceRepo}`);
  await updateExistingPool(root, client, config, {
    allowLegacyDatasetRemoval: legacy,
    prepareDeploymentManifest,
  });
  if (legacy) {
    await restartSpaceRuntime(client, config.spaceRepo);
    await waitForSpaceStage(client, config.spaceRepo, "RUNNING");
  }
  const refreshedVariables = await getSpaceVariables(client, config.spaceRepo);
  const desired = await desiredEnrichmentJob(
    client,
    config.spaceRepo,
    config.rawBucket,
    refreshedVariables,
  );
  const scheduleResult = await finalizeEnrichmentScheduleUpdate(client, desired, {
    resumeAfterMaintenance: scheduleWasActive,
    ...(scheduleSecrets === undefined ? {} : { secrets: scheduleSecrets }),
  });
  task.stop("Space updated");
  outro(updateCompletionMessage(config.spaceRepo, scheduleResult));
}

function updateCompletionMessage(
  spaceRepo: string,
  scheduleResult: { resumed: boolean; suspendedStale: number },
): string {
  const done = `Done. Explorer: ${spacePublicUrl(spaceRepo)}`;
  if (scheduleResult.resumed) {
    return `${done}\nRestored the validated canonical enrichment schedule.`;
  }
  if (scheduleResult.suspendedStale === 0) return done;
  return `${done}\nSuspended ${String(scheduleResult.suspendedStale)} stale enrichment schedule(s). Run doctor --fix to replace them.`;
}

async function beginLegacyCutover(
  root: string,
  client: { accessToken: string },
  config: SetupConfig,
  variables: ReadonlyMap<string, string>,
  legacyDataset: string,
  reportPath: string | undefined,
): Promise<void> {
  if (reportPath === undefined) {
    throw new Error(
      "legacy DATASET_REPO is still configured; use --verified-bucket-cutover=<import-report>",
    );
  }
  const initialProof = await readCutoverReport(reportPath, config.rawBucket, legacyDataset);
  const legacyJob = await desiredEnrichmentJob(
    client,
    config.spaceRepo,
    config.rawBucket,
    variables,
  );
  await quiesceEnrichmentWriters(client, legacyJob);
  await pauseSpaceRuntime(client, config.spaceRepo);
  await waitForSpaceStage(client, config.spaceRepo, "PAUSED");
  await verifyCurrentBucketProof(
    root,
    client.accessToken,
    config.rawBucket,
    legacyDataset,
    initialProof.source.revision,
  );
}

type CutoverProof = {
  source: { dataset: string; revision: string; objects: number };
  target: { bucket: string; snapshot_revision: string; objects: number };
};

// eslint-disable-next-line complexity -- Cutover proof checks every independent no-loss report boundary.
export async function readCutoverReport(
  path: string,
  rawBucket: string,
  legacyDataset: string,
): Promise<CutoverProof> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`verified Bucket cutover report is unreadable: ${path}`);
  }
  const report = candidate as {
    schema_version?: unknown;
    source?: { dataset?: unknown; revision?: unknown; objects?: unknown };
    target?: { bucket?: unknown; snapshot_revision?: unknown; objects?: unknown };
    reconciliation?: { passed?: unknown };
  };
  if (
    report.schema_version !== 1 ||
    report.reconciliation?.passed !== true ||
    report.source?.dataset !== legacyDataset ||
    typeof report.source.revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(report.source.revision) ||
    typeof report.source.objects !== "number" ||
    report.source.objects < 1 ||
    report.target?.bucket !== rawBucket ||
    typeof report.target.snapshot_revision !== "string" ||
    !/^[a-f0-9]{64}$/u.test(report.target.snapshot_revision) ||
    typeof report.target.objects !== "number" ||
    report.target.objects < 1
  ) {
    throw new Error("verified Bucket cutover report does not prove the source and target import");
  }
  return report as CutoverProof;
}

export async function assertCutoverReport(
  path: string,
  rawBucket: string,
  legacyDataset: string,
  readDatasetHead: () => Promise<string>,
): Promise<void> {
  const report = await readCutoverReport(path, rawBucket, legacyDataset);
  const currentRevision = await readDatasetHead();
  if (currentRevision !== report.source.revision) {
    throw new Error("verified Bucket cutover report does not match the current dataset revision");
  }
}

async function verifyCurrentBucketProof(
  root: string,
  accessToken: string,
  rawBucket: string,
  dataset: string,
  revision: string,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "xtap-pool-cutover-verify-"));
  const report = join(directory, "report.json");
  try {
    await inheritCommand(
      "npm",
      [
        "run",
        "storage:verify",
        "--",
        "--dataset",
        dataset,
        "--revision",
        revision,
        "--raw-bucket",
        rawBucket,
        "--report",
        report,
        "--work-dir",
        join(directory, "work"),
      ],
      { cwd: root, env: { ...process.env, HF_TOKEN: accessToken } },
    );
    await assertCutoverReport(report, rawBucket, dataset, async () => {
      const source = await datasetInfo({
        name: dataset,
        accessToken,
        additionalFields: ["sha"],
      });
      return source.sha;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function activeHfToken(): Promise<string> {
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
  const rawBucket = await promptText(
    "Private raw Bucket",
    repoInNamespace(namespace, "xtap-pool-data"),
    validateRepoId,
  );
  const indexBucket = await promptText(
    "Private index Bucket",
    repoInNamespace(namespace, "xtap-pool-bucket"),
    validateRepoId,
  );
  const allowed = await promptText(
    "Allowed HF users",
    usersValue(defaults.allowedUsers),
    validateUserList,
  );
  const admins = await promptText("Pool admins", usersValue(defaults.poolAdmins), validateUserList);
  return {
    namespace,
    spaceRepo,
    rawBucket,
    indexBucket,
    allowedUsers: normalizeUsers(allowed),
    poolAdmins: normalizeUsers(admins),
  };
}

async function confirmPlan(config: SetupConfig): Promise<void> {
  note(
    [
      `Space: ${config.spaceRepo}`,
      `Raw Bucket: ${config.rawBucket}`,
      `Index Bucket: ${config.indexBucket}`,
      `Allowed users: ${usersValue(config.allowedUsers)}`,
      `Pool admins: ${usersValue(config.poolAdmins)}`,
    ].join("\n"),
    "Plan",
  );
  const ok = await confirm({ message: "Create/update these resources?", initialValue: true });
  if (isCancel(ok) || !ok) {
    cancel("Setup cancelled.");
    process.exit(130);
  }
}

export async function promptStorageToken(rawBucket: string, indexBucket: string): Promise<string> {
  note(
    [
      "Create one fine-grained storage token scoped exactly to:",
      `- read/write ${rawBucket}`,
      `- read/write ${indexBucket}`,
      "Setup will store it as HF_TOKEN on both the Space and its suspended enrichment Job.",
      tokenSettingsUrl(),
    ].join("\n"),
    "Storage token",
  );
  for (;;) {
    const token = await promptPassword("Paste the storage-only HF_TOKEN");
    const report = await verifyStorageWriteToken({ token, rawBucket, indexBucket });
    if (report.ok) {
      note(`${report.tokenName || "token"} on ${report.username || "unknown account"}`, "Verified");
      return token;
    }
    note(report.errors.join("\n"), "Token refused");
  }
}

async function promptExistingStorageToken(): Promise<string> {
  note(
    [
      "Use the existing storage token for read-only enrichment handoff verification.",
      "The updater passes it only to the local verifier and does not store or rotate it.",
    ].join("\n"),
    "Existing storage token",
  );
  return promptPassword("Paste the existing storage-only HF_TOKEN");
}

async function promptInferenceToken(): Promise<string> {
  note(
    [
      "Create a separate fine-grained token with `Make calls to Inference Providers`.",
      tokenSettingsUrl(),
    ].join("\n"),
    "Inference token",
  );
  for (;;) {
    const token = await promptPassword("Paste the inference-only INFERENCE_TOKEN");
    const report = await verifyInferenceToken({ token });
    if (report.ok) return token;
    note(report.errors.join("\n"), "Token refused");
  }
}

export function indexContractFromVariables(variables: ReadonlyMap<string, string>): {
  llmModel: string;
  taxonomyVersion: string;
} {
  return {
    llmModel: variables.get("LLM_MODEL") ?? ENRICHMENT_JOB_DEFAULT_VARIABLES["LLM_MODEL"] ?? "",
    taxonomyVersion:
      variables.get("TAXONOMY_VERSION") ??
      ENRICHMENT_JOB_DEFAULT_VARIABLES["TAXONOMY_VERSION"] ??
      "",
  };
}

export async function initializeStorage(
  root: string,
  config: SetupConfig,
  storageToken: string,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "xtap-pool-storage-initialize-"));
  try {
    await inheritCommand("npm", ["run", "build", "--workspace", "space"], { cwd: root });
    await inheritCommand("npm", ["run", "storage:initialize", "--workspace", "space"], {
      cwd: root,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        RAW_BUCKET: config.rawBucket,
        HF_TOKEN: storageToken,
        ALLOWED_USERS: usersValue(config.allowedUsers),
        POOL_ADMINS: usersValue(config.poolAdmins),
      },
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function bootstrapIndex(
  root: string,
  config: SetupConfig,
  storageToken: string,
  contract: { llmModel: string; taxonomyVersion: string } = {
    llmModel: ENRICHMENT_JOB_DEFAULT_VARIABLES["LLM_MODEL"] ?? "",
    taxonomyVersion: ENRICHMENT_JOB_DEFAULT_VARIABLES["TAXONOMY_VERSION"] ?? "",
  },
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "xtap-pool-index-bootstrap-"));
  try {
    await inheritCommand("npm", ["run", "build", "--workspace", "space"], { cwd: root });
    await inheritCommand("npm", ["run", "index:bootstrap", "--workspace", "space"], {
      cwd: root,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        RAW_BUCKET: config.rawBucket,
        INDEX_BUCKET: config.indexBucket,
        HF_TOKEN: storageToken,
        LLM_MODEL: contract.llmModel,
        TAXONOMY_VERSION: contract.taxonomyVersion,
      },
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function durableIndexManifestExists(
  accessToken: string,
  indexBucket: string,
): Promise<boolean> {
  const blob = await downloadFile({
    repo: { type: "bucket", name: indexBucket },
    path: "index/current.json",
    accessToken,
  });
  return blob !== null;
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
