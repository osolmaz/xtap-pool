import { randomBytes } from "node:crypto";

import { downloadFile, listFiles } from "@huggingface/hub";
import { cancel, confirm, intro, isCancel, note, outro, password, spinner } from "@clack/prompts";

import { validateTweet } from "@xtap-pool/shared";

import { spacePublicUrl, validateUserList } from "./config.js";
import {
  desiredEnrichmentJob,
  desiredEnrichmentJobHash,
  ENRICHMENT_JOB_DEFAULT_VARIABLES,
  enrichmentJobVariableError,
  inspectEnrichmentJob,
  reconcileEnrichmentJob,
  resumeEnrichmentSchedule,
  runEnrichmentCanary,
} from "./enrichment-job.js";
import type {
  DesiredEnrichmentJob,
  EnrichmentJobInspection,
  EnrichmentJobSecrets,
} from "./enrichment-job.js";
import {
  getRepoPrivateState,
  getSpaceSecrets,
  getSpaceVariables,
  setSpaceSecret,
  setSpaceVariable,
} from "./hub-api.js";
import type { HubClient } from "./hub-api.js";
import { verifyInferenceToken } from "./inference-token.js";
import { manifestFromSpace } from "./manifest.js";
import type { PoolManifest } from "./manifest.js";
import { captureCommand } from "./process.js";
import { verifyStorageWriteToken } from "./token.js";

export type DoctorOptions = {
  spaceRepo: string;
  json: boolean;
  fix: boolean;
  canary?: boolean;
  resumeCanaryJobId?: string;
  enableSchedule?: boolean;
};

export type DoctorStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  code: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, string | number | boolean>;
};

export type DoctorReport = {
  spaceRepo: string;
  datasetRepo?: string;
  indexBucket?: string;
  summary: Record<DoctorStatus, number>;
  checks: readonly DoctorCheck[];
};

export type DoctorDeps = {
  fetchFn?: typeof fetch;
  promptDatasetToken?: (datasetRepo: string) => Promise<string>;
  confirmDatasetTokenRepair?: (datasetRepo: string, report: DoctorReport) => Promise<boolean>;
  promptInferenceToken?: () => Promise<string>;
  confirmGeneratedSecretRepair?: (
    keys: readonly GeneratedSecretKey[],
    report: DoctorReport,
  ) => Promise<boolean>;
  validateDatasetToken?: (
    token: string,
    datasetRepo: string,
    indexBucket: string,
  ) => Promise<readonly string[]>;
  validateInferenceToken?: (token: string) => Promise<readonly string[]>;
  restartAndWait?: (spaceRepo: string) => Promise<void>;
  inspectJob?: (
    client: HubClient,
    desired: DesiredEnrichmentJob,
  ) => Promise<EnrichmentJobInspection>;
  reconcileJob?: (
    client: HubClient,
    desired: DesiredEnrichmentJob,
    secrets?: EnrichmentJobSecrets,
  ) => Promise<unknown>;
  promptJobDatasetToken?: (datasetRepo: string) => Promise<string>;
  promptJobInferenceToken?: () => Promise<string>;
  runJobCanary?: typeof runEnrichmentCanary;
  resumeJobSchedule?: typeof resumeEnrichmentSchedule;
  confirmScheduleEnable?: (
    desired: DesiredEnrichmentJob,
    hardCeilingUsd: number,
  ) => Promise<boolean>;
};

type GeneratedSecretKey = "POOL_SIGNING_SECRET" | "SESSION_SECRET";

const GENERATED_SECRET_KEYS = ["POOL_SIGNING_SECRET", "SESSION_SECRET"] as const;

type HealthPayload = {
  ok?: unknown;
  tweets?: unknown;
  readiness?: unknown;
};

export async function runDoctor(
  client: HubClient,
  username: string,
  options: DoctorOptions,
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  let current = await collectDoctorReport(client, username, options.spaceRepo, deps);
  if (options.fix && current.datasetRepo !== undefined) {
    await repairDoctorFindings(client, username, current, deps);
    current = await collectDoctorReport(client, username, options.spaceRepo, deps);
  }
  if (options.canary === true) {
    current = await runDoctorCanary(client, username, current, options, deps);
  }
  if (options.json) printJson(current);
  else printHuman(current);
  return current;
}

export async function collectDoctorReport(
  client: HubClient,
  username: string,
  spaceRepo: string,
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let variables: ReadonlyMap<string, string>;
  try {
    variables = await getSpaceVariables(client, spaceRepo);
    checks.push(pass("space.variables.read", `Read Space variables for ${spaceRepo}.`));
  } catch (error) {
    checks.push(fail("space.variables.read", errorMessage(error)));
    return report(spaceRepo, undefined, undefined, checks);
  }

  let manifest: PoolManifest;
  try {
    manifest = manifestFromSpace(username, spaceRepo, variables);
    checks.push(pass("pool.manifest", `Derived desired state for ${spaceRepo}.`));
  } catch (error) {
    checks.push(fail("pool.manifest", errorMessage(error)));
    return report(spaceRepo, undefined, undefined, checks);
  }

  for (const key of manifest.requiredVariables) {
    checks.push(variableCheck(key, variables.get(key)));
  }

  await checkSecrets(client, manifest, checks);
  await checkDataset(client, manifest, checks);
  await checkIndexBucket(client, manifest, checks);
  await checkEnrichmentJob(client, manifest, variables, checks, deps);
  await checkLiveHealth(manifest, checks, deps.fetchFn ?? fetch);

  return report(spaceRepo, manifest.datasetRepo, manifest.indexBucket, checks);
}

// eslint-disable-next-line complexity -- This boundary keeps canary evidence, paid approval, and activation in one fail-closed transaction.
async function runDoctorCanary(
  client: HubClient,
  username: string,
  current: DoctorReport,
  options: DoctorOptions,
  deps: DoctorDeps,
): Promise<DoctorReport> {
  if (current.datasetRepo === undefined) throw new Error("Cannot run a canary without a dataset.");
  if (current.summary.fail > 0) {
    throw new Error("Refusing the paid recovery canary while doctor checks are failing.");
  }
  const variables = await getSpaceVariables(client, current.spaceRepo);
  const manifest = manifestFromSpace(username, current.spaceRepo, variables);
  const desired = await desiredEnrichmentJob(
    client,
    manifest.spaceRepo,
    manifest.datasetRepo,
    variables,
  );
  const canary = await (deps.runJobCanary ?? runEnrichmentCanary)(
    client,
    desired,
    manifest.datasetRepo,
    options.resumeCanaryJobId === undefined
      ? undefined
      : { resumeJobId: options.resumeCanaryJobId },
  );
  const canaryCheck = pass(
    "job.canary",
    "Two bounded Hugging Face Jobs produced verified durable receipts.",
    {
      firstJobId: canary.runs[0].jobId,
      secondJobId: canary.runs[1].jobId,
      hardCeilingUsd: canary.hardCeilingUsd,
    },
  );
  const checks = [...current.checks, canaryCheck];
  if (options.enableSchedule !== true) {
    checks.push(
      warn(
        "job.schedule.approval",
        "The recovery canary passed, but the recurring schedule remains suspended.",
      ),
    );
    return report(current.spaceRepo, manifest.datasetRepo, manifest.indexBucket, checks);
  }
  const approved = await (deps.confirmScheduleEnable ?? confirmScheduleEnableDefault)(
    desired,
    canary.hardCeilingUsd,
  );
  if (!approved) {
    checks.push(
      warn(
        "job.schedule.approval",
        "Recurring paid enrichment was not approved; schedule remains suspended.",
      ),
    );
    return report(current.spaceRepo, manifest.datasetRepo, manifest.indexBucket, checks);
  }
  const inspection = await (deps.inspectJob ?? inspectEnrichmentJob)(client, desired);
  if (inspection.exactSchedules.length !== 1 || inspection.schedules.length !== 1) {
    throw new Error("The schedule changed after the canary; refusing activation.");
  }
  const schedule = inspection.exactSchedules[0];
  if (schedule === undefined) throw new Error("The exact schedule disappeared after the canary.");
  await (deps.resumeJobSchedule ?? resumeEnrichmentSchedule)(client, desired, schedule.id);
  const activated = await (deps.inspectJob ?? inspectEnrichmentJob)(client, desired);
  const activeSchedule = activated.exactSchedules[0];
  if (
    activated.exactSchedules.length !== 1 ||
    activated.schedules.length !== 1 ||
    activeSchedule?.suspend !== false
  ) {
    throw new Error("Hugging Face did not confirm the enrichment schedule as active.");
  }
  const refreshed = await collectDoctorReport(client, username, current.spaceRepo, deps);
  return report(current.spaceRepo, manifest.datasetRepo, manifest.indexBucket, [
    ...refreshed.checks,
    canaryCheck,
    pass("job.schedule.approval", "The approved Hugging Face schedule is active."),
  ]);
}

function variableCheck(key: string, value: string | undefined): DoctorCheck {
  if (value === undefined) return fail(`space.variable.${key}`, `${key} is missing.`);
  if (value.trim() === "") return fail(`space.variable.${key}`, `${key} is empty.`);
  const error = variableValueError(key, value);
  return error === undefined
    ? pass(`space.variable.${key}`, `${key} is set.`)
    : fail(`space.variable.${key}`, error);
}

function variableValueError(key: string, value: string): string | undefined {
  if (key === "ENRICH_ENABLED" && value !== "false") {
    return "ENRICH_ENABLED must be false because production enrichment runs in Hugging Face Jobs.";
  }
  if (key === "ALLOWED_USERS" || key === "POOL_ADMINS") {
    const error = validateUserList(value);
    return error === undefined ? undefined : `${key} is invalid: ${error}`;
  }
  const enrichmentError = enrichmentJobVariableError(key, value);
  return enrichmentError === undefined ? undefined : `${key} is invalid: ${enrichmentError}`;
}

async function checkSecrets(
  client: HubClient,
  manifest: PoolManifest,
  checks: DoctorCheck[],
): Promise<void> {
  let secrets: ReadonlySet<string>;
  try {
    secrets = await getSpaceSecrets(client, manifest.spaceRepo);
    checks.push(pass("space.secrets.read", `Read secret names for ${manifest.spaceRepo}.`));
  } catch (error) {
    checks.push(fail("space.secrets.read", errorMessage(error)));
    return;
  }
  for (const key of manifest.requiredSecrets) {
    checks.push(
      secrets.has(key)
        ? pass(`space.secret.${key}`, `${key} secret exists.`)
        : fail(`space.secret.${key}`, `${key} secret is missing.`),
    );
  }
  if (!manifest.enrichmentEnabled && secrets.has("INFERENCE_TOKEN")) {
    checks.push(
      warn("space.secret.INFERENCE_TOKEN.unused", "INFERENCE_TOKEN exists but enrichment is off."),
    );
  }
}

async function checkDataset(
  client: HubClient,
  manifest: PoolManifest,
  checks: DoctorCheck[],
): Promise<void> {
  try {
    const isPrivate = await getRepoPrivateState(client, {
      type: "dataset",
      name: manifest.datasetRepo,
    });
    checks.push(
      isPrivate
        ? pass("dataset.visibility", `${manifest.datasetRepo} is private.`)
        : fail("dataset.visibility", `${manifest.datasetRepo} is public.`),
    );
  } catch (error) {
    checks.push(fail("dataset.visibility", errorMessage(error)));
  }

  try {
    const stats = await datasetJsonlStats(client, manifest.datasetRepo);
    checks.push(
      stats.files > 0
        ? pass("dataset.files", `Dataset has ${String(stats.files)} data JSONL files.`, {
            count: stats.files,
          })
        : warn("dataset.files", "Dataset has no data JSONL files.", { count: stats.files }),
    );
    if (stats.files > 0) checks.push(datasetRecordsCheck(stats));
  } catch (error) {
    checks.push(fail("dataset.files", errorMessage(error)));
  }
}

async function checkIndexBucket(
  client: HubClient,
  manifest: PoolManifest,
  checks: DoctorCheck[],
): Promise<void> {
  try {
    const isPrivate = await getRepoPrivateState(client, {
      type: "bucket",
      name: manifest.indexBucket,
    });
    checks.push(
      isPrivate
        ? pass("index_bucket.visibility", `${manifest.indexBucket} is private.`)
        : fail("index_bucket.visibility", `${manifest.indexBucket} is public.`),
    );
  } catch (error) {
    checks.push(fail("index_bucket.visibility", errorMessage(error)));
    return;
  }
  try {
    const base = client.hubUrl ?? "https://huggingface.co";
    const response = await (client.fetchFn ?? fetch)(
      `${base}/datasets/${manifest.datasetRepo}/resolve/main/index/current.json`,
      { headers: { authorization: `Bearer ${client.accessToken}` } },
    );
    checks.push(
      response.ok
        ? pass("index.manifest", "The durable index manifest exists.")
        : fail(
            "index.manifest",
            response.status === 404
              ? "The durable index manifest is missing."
              : `Could not read the durable index manifest (${String(response.status)}).`,
          ),
    );
  } catch (error) {
    checks.push(fail("index.manifest", errorMessage(error)));
  }
}

async function checkEnrichmentJob(
  client: HubClient,
  manifest: PoolManifest,
  variables: ReadonlyMap<string, string>,
  checks: DoctorCheck[],
  deps: DoctorDeps,
): Promise<void> {
  try {
    const desired = await desiredEnrichmentJob(
      client,
      manifest.spaceRepo,
      manifest.datasetRepo,
      variables,
    );
    const inspection = await (deps.inspectJob ?? inspectEnrichmentJob)(client, desired);
    checks.push(pass("job.schedules.read", `Read Hugging Face Jobs for ${manifest.namespace}.`));
    recordEnrichmentJobChecks(inspection, checks);
  } catch (error) {
    checks.push(fail("job.schedules.read", errorMessage(error)));
  }
}

function recordEnrichmentJobChecks(
  inspection: EnrichmentJobInspection,
  checks: DoctorCheck[],
): void {
  const expected = desiredEnrichmentJobHash(inspection.desired).slice(0, 16);
  if (inspection.schedules.length === 0) {
    checks.push(
      fail("job.schedule", "The Hugging Face enrichment schedule is missing.", {
        expectedContract: expected,
      }),
    );
  } else if (inspection.exactSchedules.length !== 1 || inspection.mismatchedSchedules.length > 0) {
    checks.push(
      fail("job.schedule", "Hugging Face enrichment schedules do not match one exact contract.", {
        schedules: inspection.schedules.length,
        exact: inspection.exactSchedules.length,
        mismatched: inspection.mismatchedSchedules.length,
        expectedContract: expected,
      }),
    );
  } else {
    const schedule = inspection.exactSchedules[0];
    if (schedule === undefined) throw new Error("exact schedule disappeared");
    checks.push(
      pass("job.schedule", "The Hugging Face enrichment schedule matches the deployed contract.", {
        scheduleId: schedule.id,
        expectedContract: expected,
      }),
    );
    checks.push(
      schedule.suspend
        ? warn("job.schedule.state", "The Hugging Face enrichment schedule is suspended.")
        : pass("job.schedule.state", "The Hugging Face enrichment schedule is active."),
    );
  }
  checks.push(activeJobsCheck(inspection.activeJobs));
}

function activeJobsCheck(activeJobs: readonly { id: string }[]): DoctorCheck {
  if (activeJobs.length > 1) {
    return fail("job.concurrency", "Multiple xtap-pool enrichment Jobs are active.", {
      activeJobs: activeJobs.length,
    });
  }
  return pass(
    "job.concurrency",
    activeJobs.length === 0
      ? "No xtap-pool enrichment Job is currently active."
      : "One xtap-pool enrichment Job is active.",
    { activeJobs: activeJobs.length },
  );
}

async function checkLiveHealth(
  manifest: PoolManifest,
  checks: DoctorCheck[],
  fetchFn: typeof fetch,
): Promise<void> {
  const url = `${spacePublicUrl(manifest.spaceRepo)}/healthz`;
  try {
    const response = await fetchFn(url);
    if (!response.ok) {
      checks.push(fail("live.healthz", `/healthz returned ${String(response.status)}.`));
      return;
    }
    const health = (await response.json()) as HealthPayload;
    recordHealthChecks(checks, health);
  } catch (error) {
    checks.push(fail("live.healthz", errorMessage(error)));
  }
}

function recordHealthChecks(checks: DoctorCheck[], health: HealthPayload): void {
  const tweets = typeof health.tweets === "number" ? health.tweets : undefined;
  checks.push(healthCheck(tweets));
  pushOptionalCheck(checks, liveReadinessCheck(health));
  pushOptionalCheck(checks, liveDatasetCredentialCheck(health));
  pushOptionalCheck(checks, liveDatasetStateCheck(health));
  pushOptionalCheck(checks, liveEnrichmentCheck(health));
  pushOptionalCheck(checks, liveEnrichmentStateCheck(health));
  recordIndexedDatasetCheck(checks, tweets);
}

function pushOptionalCheck(checks: DoctorCheck[], check: DoctorCheck | undefined): void {
  if (check !== undefined) checks.push(check);
}

function recordIndexedDatasetCheck(checks: DoctorCheck[], tweets: number | undefined): void {
  const datasetFileCount = checkNumber(checks, "dataset.files", "count") ?? 0;
  const datasetRecordCount = checkNumber(checks, "dataset.records", "count");
  if (datasetFileCount === 0 || tweets === undefined || datasetRecordCount === 0) return;
  checks.push(indexedDatasetCheck(datasetFileCount, datasetRecordCount, tweets));
}

function liveReadinessCheck(health: HealthPayload): DoctorCheck | undefined {
  const readiness = asRecord(health.readiness);
  if (!("ok" in readiness)) return undefined;
  if (readiness["ok"] === true) return pass("live.readiness", "The live Space is ready.");
  const errors = readinessErrors(readiness);
  return fail(
    "live.readiness",
    errors.length === 0
      ? "The live Space reports that it is not ready."
      : `The live Space is not ready: ${errors.join(" ")}`,
  );
}

function liveDatasetCredentialCheck(health: HealthPayload): DoctorCheck | undefined {
  const dataset = asRecord(asRecord(health.readiness)["dataset"]);
  const credential = text(dataset["credential"]);
  if (credential === "ok") return pass("live.dataset", "The live Space accepts HF_TOKEN.");
  if (credential === "invalid") {
    const error = credentialError(dataset);
    return fail(
      "live.dataset",
      error.length > 0
        ? `The live Space reports an unusable HF_TOKEN: ${error}`
        : "The live Space reports an unusable HF_TOKEN.",
    );
  }
  if (credential === "unknown") {
    const error = credentialError(dataset);
    return warn(
      "live.dataset",
      error.length > 0
        ? `The live Space could not verify HF_TOKEN yet: ${error}`
        : "The live Space could not verify HF_TOKEN yet.",
    );
  }
  return undefined;
}

function liveDatasetStateCheck(health: HealthPayload): DoctorCheck | undefined {
  const dataset = asRecord(asRecord(health.readiness)["dataset"]);
  const state = text(dataset["state"]);
  const error = text(dataset["error"]);
  if (state === "ready") return pass("live.dataset_state", "The live dataset state is ready.");
  if (state === "invalid") {
    return fail(
      "live.dataset_state",
      error.length > 0
        ? `The live dataset state is invalid: ${error}`
        : "The live dataset state is invalid.",
    );
  }
  if (state === "unknown") {
    return warn(
      "live.dataset_state",
      error.length > 0
        ? `The live dataset state is still resolving: ${error}`
        : "The live dataset state is still resolving.",
    );
  }
  return undefined;
}

function liveEnrichmentCheck(health: HealthPayload): DoctorCheck | undefined {
  const enrichment = asRecord(asRecord(health.readiness)["enrichment"]);
  if (enrichment["enabled"] !== true) return undefined;
  const credential = text(enrichment["credential"]);
  if (credential === "ok")
    return pass("live.enrichment", "The live Space accepts INFERENCE_TOKEN.");
  if (credential === "missing" || credential === "invalid") {
    const error = credentialError(enrichment);
    return fail(
      "live.enrichment",
      error.length > 0
        ? `The live Space reports an unusable INFERENCE_TOKEN: ${error}`
        : "The live Space reports an unusable INFERENCE_TOKEN.",
    );
  }
  if (credential === "unknown") {
    const error = credentialError(enrichment);
    return warn(
      "live.enrichment",
      error.length > 0
        ? `The live Space could not verify INFERENCE_TOKEN yet: ${error}`
        : "The live Space could not verify INFERENCE_TOKEN yet.",
    );
  }
  return warn("live.enrichment", "The live Space did not report INFERENCE_TOKEN readiness.");
}

function liveEnrichmentStateCheck(health: HealthPayload): DoctorCheck | undefined {
  const enrichment = asRecord(asRecord(health.readiness)["enrichment"]);
  if (enrichment["enabled"] !== true) return undefined;
  const state = text(enrichment["state"]);
  const error = text(enrichment["error"]);
  if (state === "ready")
    return pass("live.enrichment_state", "The live enrichment state is ready.");
  if (state === "invalid") {
    return fail(
      "live.enrichment_state",
      error.length > 0
        ? `The live enrichment state is invalid: ${error}`
        : "The live enrichment state is invalid.",
    );
  }
  if (state === "unknown") {
    return warn(
      "live.enrichment_state",
      error.length > 0
        ? `The live enrichment state is still resolving: ${error}`
        : "The live enrichment state is still resolving.",
    );
  }
  return undefined;
}

function readinessErrors(readiness: Record<string, unknown>): string[] {
  return ["dataset", "enrichment"]
    .map((key) => text(asRecord(readiness[key])["error"]))
    .filter((error) => error.length > 0);
}

function credentialError(component: Record<string, unknown>): string {
  const explicit = text(component["credential_error"]);
  return explicit.length > 0 ? explicit : text(component["error"]);
}

function datasetRecordsCheck(stats: DatasetJsonlStats): DoctorCheck {
  if (stats.records === 0) {
    return fail(
      "dataset.records",
      "Dataset data JSONL files contain no valid tweet records. Repair empty or malformed dataset data before rotating credentials.",
      { count: stats.records },
    );
  }
  return pass("dataset.records", `Dataset has ${String(stats.records)} valid tweet records.`, {
    count: stats.records,
  });
}

function healthCheck(tweets: number | undefined): DoctorCheck {
  return tweets === undefined
    ? warn("live.healthz", "/healthz responded without a numeric tweets count.")
    : pass("live.healthz", `/healthz reports ${String(tweets)} indexed tweets.`, { tweets });
}

function indexedDatasetCheck(
  datasetFileCount: number,
  datasetRecordCount: number | undefined,
  tweets: number,
): DoctorCheck {
  if (tweets === 0) {
    return fail(
      "live.indexed_dataset",
      "The dataset has valid tweet records, but the live Space indexed zero tweets. Update or restart the Space, then check the Space HF_TOKEN dataset credential if it still cannot index them.",
      { datasetFiles: datasetFileCount, datasetRecords: datasetRecordCount ?? 0, tweets },
    );
  }
  return pass("live.indexed_dataset", "The live Space is indexing dataset-backed tweets.");
}

async function repairDoctorFindings(
  client: HubClient,
  username: string,
  report: DoctorReport,
  deps: DoctorDeps,
): Promise<void> {
  const datasetRepo = report.datasetRepo;
  if (datasetRepo === undefined) return;
  const repair = repairDependencies(deps);
  const jobVariablesChanged = await maybeRepairJobVariables(client, report);
  const webWorkerChanged = await maybeDisableSpaceEnrichment(client, report);
  const generatedChanged = await maybeRepairGeneratedSecrets(client, report, repair);
  const datasetRepairKind = storageTokenRepairKind(report);
  const datasetChanged =
    generatedChanged && datasetRepairKind === "indeterminate"
      ? false
      : await maybeRepairDatasetToken(client, report, datasetRepo, repair, datasetRepairKind);
  if ([webWorkerChanged, generatedChanged, datasetChanged].includes(true)) {
    await repair.restartAndWait(report.spaceRepo);
  }
  await maybeRepairEnrichmentJob(
    client,
    username,
    report,
    repair,
    jobVariablesChanged,
    datasetChanged,
  );
}

type RepairDependencies = DatasetRepairDeps &
  GeneratedSecretRepairDeps &
  JobRepairDeps & {
    restartAndWait: (spaceRepo: string) => Promise<void>;
  };

// eslint-disable-next-line complexity -- Dependency defaults are centralized so every repair branch is injectable in tests.
function repairDependencies(deps: DoctorDeps): RepairDependencies {
  return {
    promptDatasetToken: deps.promptDatasetToken ?? promptDatasetTokenDefault,
    confirmDatasetTokenRepair: deps.confirmDatasetTokenRepair ?? confirmDatasetTokenRepairDefault,
    validateDatasetToken: deps.validateDatasetToken ?? validateDatasetTokenDefault,
    confirmGeneratedSecretRepair:
      deps.confirmGeneratedSecretRepair ?? confirmGeneratedSecretRepairDefault,
    validateInferenceToken: deps.validateInferenceToken ?? validateInferenceTokenDefault,
    inspectJob: deps.inspectJob ?? inspectEnrichmentJob,
    reconcileJob: deps.reconcileJob ?? reconcileEnrichmentJob,
    promptJobDatasetToken: deps.promptJobDatasetToken ?? promptJobDatasetTokenDefault,
    promptJobInferenceToken: deps.promptJobInferenceToken ?? promptJobInferenceTokenDefault,
    restartAndWait: deps.restartAndWait ?? restartAndWaitDefault,
  };
}

async function maybeRepairJobVariables(client: HubClient, report: DoctorReport): Promise<boolean> {
  let repairedIndexBucket = false;
  if (
    report.indexBucket !== undefined &&
    report.checks.some(
      (check) => check.code === "space.variable.INDEX_BUCKET" && check.status === "fail",
    )
  ) {
    await setSpaceVariable(client, report.spaceRepo, "INDEX_BUCKET", report.indexBucket);
    repairedIndexBucket = true;
  }
  const missing = Object.entries(ENRICHMENT_JOB_DEFAULT_VARIABLES).filter(([key]) =>
    report.checks.some(
      (check) => check.code === `space.variable.${key}` && check.status === "fail",
    ),
  );
  for (const [key, value] of missing) {
    await setSpaceVariable(client, report.spaceRepo, key, value);
  }
  return repairedIndexBucket || missing.length > 0;
}

async function maybeDisableSpaceEnrichment(
  client: HubClient,
  report: DoctorReport,
): Promise<boolean> {
  const invalid = report.checks.some(
    (check) => check.code === "space.variable.ENRICH_ENABLED" && check.status === "fail",
  );
  if (!invalid) return false;
  await setSpaceVariable(client, report.spaceRepo, "ENRICH_ENABLED", "false");
  return true;
}

type GeneratedSecretRepairDeps = {
  confirmGeneratedSecretRepair: (
    keys: readonly GeneratedSecretKey[],
    report: DoctorReport,
  ) => Promise<boolean>;
};

async function maybeRepairGeneratedSecrets(
  client: HubClient,
  report: DoctorReport,
  deps: GeneratedSecretRepairDeps,
): Promise<boolean> {
  const keys = [
    ...new Set([
      ...missingGeneratedSecrets(report),
      ...generatedSecretsWithPossibleMalformedValues(report),
    ]),
  ];
  if (keys.length === 0) return false;
  if (!(await deps.confirmGeneratedSecretRepair(keys, report))) return false;
  await Promise.all(
    keys.map((key) => setSpaceSecret(client, report.spaceRepo, key, randomSecret())),
  );
  return true;
}

type DatasetRepairDeps = {
  promptDatasetToken: (datasetRepo: string) => Promise<string>;
  confirmDatasetTokenRepair: (datasetRepo: string, report: DoctorReport) => Promise<boolean>;
  validateDatasetToken: (
    token: string,
    datasetRepo: string,
    indexBucket: string,
  ) => Promise<readonly string[]>;
};

async function maybeRepairDatasetToken(
  client: HubClient,
  report: DoctorReport,
  datasetRepo: string,
  deps: DatasetRepairDeps,
  repairKind = storageTokenRepairKind(report),
): Promise<boolean> {
  if (repairKind === undefined) return false;
  if (
    repairKind === "indeterminate" &&
    !(await deps.confirmDatasetTokenRepair(datasetRepo, report))
  ) {
    return false;
  }
  const token = await promptForValidToken(
    "Storage credential rejected",
    () => deps.promptDatasetToken(datasetRepo),
    (candidate) => deps.validateDatasetToken(candidate, datasetRepo, requiredIndexBucket(report)),
  );
  await setSpaceSecret(client, report.spaceRepo, "HF_TOKEN", token);
  return true;
}

type JobRepairDeps = {
  inspectJob: (
    client: HubClient,
    desired: DesiredEnrichmentJob,
  ) => Promise<EnrichmentJobInspection>;
  reconcileJob: (
    client: HubClient,
    desired: DesiredEnrichmentJob,
    secrets?: EnrichmentJobSecrets,
  ) => Promise<unknown>;
  promptJobDatasetToken: (datasetRepo: string) => Promise<string>;
  promptJobInferenceToken: () => Promise<string>;
  validateDatasetToken: (
    token: string,
    datasetRepo: string,
    indexBucket: string,
  ) => Promise<readonly string[]>;
  validateInferenceToken: (token: string) => Promise<readonly string[]>;
};

async function maybeRepairEnrichmentJob(
  client: HubClient,
  username: string,
  report: DoctorReport,
  deps: JobRepairDeps,
  variablesChanged: boolean,
  datasetCredentialChanged: boolean,
): Promise<void> {
  if (
    !variablesChanged &&
    !datasetCredentialChanged &&
    !report.checks.some((check) => check.code === "job.schedule" && check.status === "fail")
  ) {
    return;
  }
  const variables = await getSpaceVariables(client, report.spaceRepo);
  const manifest = manifestFromSpace(username, report.spaceRepo, variables);
  const desired = await desiredEnrichmentJob(
    client,
    manifest.spaceRepo,
    manifest.datasetRepo,
    variables,
  );
  const inspection = await deps.inspectJob(client, desired);
  if (inspection.activeJobs.length > 0) {
    throw new Error("Refusing Hugging Face schedule repair while an enrichment Job is active.");
  }
  if (inspection.exactSchedules.length > 0 && !datasetCredentialChanged) {
    await deps.reconcileJob(client, desired);
    return;
  }
  const storageToken = await promptForValidToken(
    "Job storage credential rejected",
    () => deps.promptJobDatasetToken(manifest.datasetRepo),
    (candidate) => deps.validateDatasetToken(candidate, manifest.datasetRepo, manifest.indexBucket),
  );
  const inferenceToken = await promptForValidToken(
    "Job inference credential rejected",
    deps.promptJobInferenceToken,
    deps.validateInferenceToken,
  );
  await deps.reconcileJob(client, desired, { storageToken, inferenceToken });
}

async function promptForValidToken(
  title: string,
  promptToken: () => Promise<string>,
  validateToken: (token: string) => Promise<readonly string[]>,
): Promise<string> {
  for (;;) {
    const token = await promptToken();
    const errors = await validateToken(token);
    if (errors.length === 0) return token;
    note(errors.join("\n"), title);
  }
}

function storageTokenRepairKind(report: DoctorReport): "definite" | "indeterminate" | undefined {
  const failedCodes = new Set(
    report.checks.filter((check) => check.status === "fail").map((check) => check.code),
  );
  if (failedCodes.has("space.secret.HF_TOKEN") || failedCodes.has("live.dataset"))
    return "definite";
  if (failedCodes.has("live.indexed_dataset")) return "indeterminate";
  if (failedCodes.has("live.healthz") && failedCodes.size === 1) return "indeterminate";
  return undefined;
}

function missingGeneratedSecrets(report: DoctorReport): readonly GeneratedSecretKey[] {
  return GENERATED_SECRET_KEYS.filter((key) =>
    report.checks.some((check) => check.status === "fail" && check.code === `space.secret.${key}`),
  );
}

function generatedSecretsWithPossibleMalformedValues(
  report: DoctorReport,
): readonly GeneratedSecretKey[] {
  const healthFailed = report.checks.some(
    (check) => check.status === "fail" && check.code === "live.healthz",
  );
  if (!healthFailed) return [];
  const allSecretStatesKnown = GENERATED_SECRET_KEYS.every((key) =>
    report.checks.some(
      (check) =>
        (check.status === "pass" || check.status === "fail") &&
        check.code === `space.secret.${key}`,
    ),
  );
  return allSecretStatesKnown ? GENERATED_SECRET_KEYS : [];
}

async function validateDatasetTokenDefault(
  token: string,
  datasetRepo: string,
  indexBucket: string,
): Promise<readonly string[]> {
  const validation = await verifyStorageWriteToken({ token, datasetRepo, indexBucket });
  return validation.ok ? [] : validation.errors;
}

async function validateInferenceTokenDefault(token: string): Promise<readonly string[]> {
  const validation = await verifyInferenceToken({ token });
  return validation.ok ? [] : validation.errors;
}

async function promptDatasetTokenDefault(datasetRepo: string): Promise<string> {
  note(
    `Paste a fine-grained token scoped to read/write ${datasetRepo} and the configured index Bucket. It will be written to the Space as HF_TOKEN.`,
    "Storage credential",
  );
  return promptPassword("Storage-only HF_TOKEN");
}

async function confirmDatasetTokenRepairDefault(
  datasetRepo: string,
  report: DoctorReport,
): Promise<boolean> {
  note(
    [
      "The live Space health endpoint is unavailable, but doctor cannot prove the Space HF_TOKEN is the cause.",
      `Replace HF_TOKEN only if you want to rotate the dataset credential for ${datasetRepo}.`,
      `Failing checks: ${report.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.code)
        .join(", ")}`,
    ].join("\n"),
    "Indeterminate repair",
  );
  const ok = await confirm({
    message: `Replace the Space HF_TOKEN for ${datasetRepo}?`,
    initialValue: false,
  });
  if (isCancel(ok)) {
    cancel("Doctor cancelled.");
    process.exit(130);
  }
  return ok;
}

async function confirmGeneratedSecretRepairDefault(
  keys: readonly GeneratedSecretKey[],
  report: DoctorReport,
): Promise<boolean> {
  const effects = keys.map((key) => {
    if (key === "POOL_SIGNING_SECRET")
      return "Replacing POOL_SIGNING_SECRET invalidates extension pool tokens.";
    return "Replacing SESSION_SECRET signs out browser sessions.";
  });
  note(
    [
      `Doctor can generate replacement secrets for ${report.spaceRepo}: ${keys.join(", ")}.`,
      ...effects,
    ].join("\n"),
    "Generated secrets",
  );
  const ok = await confirm({
    message: "Generate and write replacement secrets?",
    initialValue: false,
  });
  if (isCancel(ok)) {
    cancel("Doctor cancelled.");
    process.exit(130);
  }
  return ok;
}

async function promptJobDatasetTokenDefault(datasetRepo: string): Promise<string> {
  note(
    [
      `Paste a fine-grained token scoped to read/write ${datasetRepo} and the configured index Bucket.`,
      "Hugging Face will encrypt it as HF_TOKEN on the scheduled Job.",
      "The value cannot be recovered from the existing Space secret.",
    ].join("\n"),
    "Job storage credential",
  );
  return promptPassword("Scheduled Job storage token");
}

async function promptJobInferenceTokenDefault(): Promise<string> {
  note(
    [
      "Paste a separate fine-grained token with the `Make calls to Inference Providers` permission.",
      "Hugging Face will encrypt it as INFERENCE_TOKEN on the scheduled Job.",
      "The value cannot be recovered from the existing Space secret.",
    ].join("\n"),
    "Job inference credential",
  );
  return promptPassword("Scheduled Job inference token");
}

async function confirmScheduleEnableDefault(
  desired: DesiredEnrichmentJob,
  canaryHardCeilingUsd: number,
): Promise<boolean> {
  const perRun = Number(desired.environment["ENRICH_MAX_COST_USD"]);
  note(
    [
      `Canary hard ceiling: $${canaryHardCeilingUsd.toFixed(2)} across two Jobs.`,
      `Recurring inference ceiling: $${perRun.toFixed(2)} per scheduled run, plus cpu-basic time.`,
      `Schedule: ${desired.schedule}.`,
      "Recurring cumulative spend can exceed $5 and requires explicit approval.",
    ].join("\n"),
    "Paid enrichment schedule",
  );
  const approved = await confirm({
    message: "Enable this recurring Hugging Face Job schedule?",
    initialValue: false,
  });
  if (isCancel(approved)) {
    cancel("Doctor cancelled.");
    process.exit(130);
  }
  return approved;
}

async function promptPassword(message: string): Promise<string> {
  const value = await password({ message });
  if (isCancel(value)) {
    cancel("Doctor cancelled.");
    process.exit(130);
  }
  return value;
}

function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

async function restartAndWaitDefault(spaceRepo: string): Promise<void> {
  const task = spinner();
  task.start(`Restarting ${spaceRepo}`);
  await captureCommand("hf", ["spaces", "restart", spaceRepo, "--format", "json"]);
  await captureCommand("hf", ["spaces", "wait", spaceRepo, "--timeout", "10m", "--format", "json"]);
  task.stop("Space restarted");
}

type DatasetJsonlStats = { files: number; records: number };

async function datasetJsonlStats(
  client: HubClient,
  datasetRepo: string,
): Promise<DatasetJsonlStats> {
  const repo = { type: "dataset", name: datasetRepo } as const;
  let paths: readonly string[];
  try {
    paths = await listDatasetJsonlPaths(client, datasetRepo);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await assertDatasetReadable(client, repo);
    return { files: 0, records: 0 };
  }
  let records = 0;
  for (const path of paths) {
    records += countValidTweets(await downloadDatasetText(client, datasetRepo, path));
  }
  return { files: paths.length, records };
}

async function listDatasetJsonlPaths(
  client: HubClient,
  datasetRepo: string,
): Promise<readonly string[]> {
  const paths: string[] = [];
  for await (const entry of listFiles({
    repo: { type: "dataset", name: datasetRepo },
    accessToken: client.accessToken,
    recursive: true,
    path: "data",
    ...hubOptions(client),
  })) {
    if (entry.type === "file" && entry.path.endsWith(".jsonl")) paths.push(entry.path);
  }
  return paths;
}

async function downloadDatasetText(
  client: HubClient,
  datasetRepo: string,
  path: string,
): Promise<string> {
  const blob = await downloadFile({
    repo: { type: "dataset", name: datasetRepo },
    accessToken: client.accessToken,
    path,
    ...hubOptions(client),
  });
  if (blob === null) throw new Error(`dataset file not found: ${path}`);
  return blob.text();
}

function countValidTweets(content: string): number {
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      continue;
    }
    if (validateTweet(candidate).ok) count += 1;
  }
  return count;
}

async function assertDatasetReadable(
  client: HubClient,
  repo: { type: "dataset"; name: string },
): Promise<void> {
  for await (const _entry of listFiles({
    repo,
    accessToken: client.accessToken,
    ...hubOptions(client),
  })) {
    return;
  }
}

function hubOptions(client: HubClient): { hubUrl?: string; fetch?: typeof fetch } {
  return {
    ...(client.hubUrl === undefined ? {} : { hubUrl: client.hubUrl }),
    ...(client.fetchFn === undefined ? {} : { fetch: client.fetchFn }),
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

function report(
  spaceRepo: string,
  datasetRepo: string | undefined,
  indexBucket: string | undefined,
  checks: readonly DoctorCheck[],
): DoctorReport {
  return {
    spaceRepo,
    ...(datasetRepo === undefined ? {} : { datasetRepo }),
    ...(indexBucket === undefined ? {} : { indexBucket }),
    summary: {
      pass: checks.filter((check) => check.status === "pass").length,
      warn: checks.filter((check) => check.status === "warn").length,
      fail: checks.filter((check) => check.status === "fail").length,
    },
    checks,
  };
}

function requiredIndexBucket(report: DoctorReport): string {
  if (report.indexBucket === undefined) throw new Error("Doctor report is missing INDEX_BUCKET.");
  return report.indexBucket;
}

function printHuman(report: DoctorReport): void {
  intro(`xtap-pool doctor: ${report.spaceRepo}`);
  for (const check of report.checks) {
    const marker = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    console.log(`${marker} ${check.code}: ${check.message}`);
  }
  outro(
    `${String(report.summary.pass)} passed, ${String(report.summary.warn)} warnings, ${String(
      report.summary.fail,
    )} failed.`,
  );
}

function printJson(report: DoctorReport): void {
  console.log(JSON.stringify(report, null, 2));
}

function pass(
  code: string,
  message: string,
  details?: Record<string, string | number | boolean>,
): DoctorCheck {
  return { code, status: "pass", message, ...(details === undefined ? {} : { details }) };
}

function warn(
  code: string,
  message: string,
  details?: Record<string, string | number | boolean>,
): DoctorCheck {
  return { code, status: "warn", message, ...(details === undefined ? {} : { details }) };
}

function fail(
  code: string,
  message: string,
  details?: Record<string, string | number | boolean>,
): DoctorCheck {
  return { code, status: "fail", message, ...(details === undefined ? {} : { details }) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function checkNumber(
  checks: readonly DoctorCheck[],
  code: string,
  key: string,
): number | undefined {
  const value = checks.find((check) => check.code === code)?.details?.[key];
  return typeof value === "number" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
