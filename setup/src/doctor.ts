import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { downloadFile, listFiles } from "@huggingface/hub";
import { cancel, confirm, intro, isCancel, note, outro, password, spinner } from "@clack/prompts";

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
  rawBucket?: string;
  indexBucket?: string;
  summary: Record<DoctorStatus, number>;
  checks: readonly DoctorCheck[];
};

export type DoctorDeps = {
  fetchFn?: typeof fetch;
  promptStorageToken?: (rawBucket: string) => Promise<string>;
  confirmStorageTokenRepair?: (rawBucket: string, report: DoctorReport) => Promise<boolean>;
  promptInferenceToken?: () => Promise<string>;
  confirmGeneratedSecretRepair?: (
    keys: readonly GeneratedSecretKey[],
    report: DoctorReport,
  ) => Promise<boolean>;
  validateStorageToken?: (
    token: string,
    rawBucket: string,
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
  promptJobStorageToken?: (rawBucket: string) => Promise<string>;
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
  if (options.fix && current.rawBucket !== undefined) {
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
  await checkStorage(client, manifest, checks);
  await checkIndexBucket(client, manifest, checks);
  await checkEnrichmentJob(client, manifest, variables, checks, deps);
  await checkLiveHealth(manifest, checks, deps.fetchFn ?? fetch);

  return report(spaceRepo, manifest.rawBucket, manifest.indexBucket, checks);
}

// eslint-disable-next-line complexity -- This boundary keeps canary evidence, paid approval, and activation in one fail-closed transaction.
async function runDoctorCanary(
  client: HubClient,
  username: string,
  current: DoctorReport,
  options: DoctorOptions,
  deps: DoctorDeps,
): Promise<DoctorReport> {
  if (current.rawBucket === undefined)
    throw new Error("Cannot run a canary without raw Bucket storage.");
  if (current.summary.fail > 0) {
    throw new Error("Refusing the paid recovery canary while doctor checks are failing.");
  }
  const variables = await getSpaceVariables(client, current.spaceRepo);
  const manifest = manifestFromSpace(username, current.spaceRepo, variables);
  const desired = await desiredEnrichmentJob(
    client,
    manifest.spaceRepo,
    manifest.rawBucket,
    variables,
  );
  const canary = await (deps.runJobCanary ?? runEnrichmentCanary)(
    client,
    desired,
    manifest.rawBucket,
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
    return report(current.spaceRepo, manifest.rawBucket, manifest.indexBucket, checks);
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
    return report(current.spaceRepo, manifest.rawBucket, manifest.indexBucket, checks);
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
  return report(current.spaceRepo, manifest.rawBucket, manifest.indexBucket, [
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

async function checkStorage(
  client: HubClient,
  manifest: PoolManifest,
  checks: DoctorCheck[],
): Promise<void> {
  try {
    const isPrivate = await getRepoPrivateState(client, {
      type: "bucket",
      name: manifest.rawBucket,
    });
    checks.push(
      isPrivate
        ? pass("storage.visibility", `${manifest.rawBucket} is private.`)
        : fail("storage.visibility", `${manifest.rawBucket} is public.`),
    );
  } catch (error) {
    checks.push(fail("storage.visibility", errorMessage(error)));
  }

  try {
    const stats = await storageSegmentStats(client, manifest.rawBucket);
    checks.push(
      stats.segments > 0
        ? pass("storage.segments", `Storage has ${String(stats.segments)} verified raw segments.`, {
            count: stats.segments,
            records: stats.records,
          })
        : warn("storage.segments", "Storage has no raw segments.", { count: 0, records: 0 }),
    );
  } catch (error) {
    checks.push(fail("storage.segments", errorMessage(error)));
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
    const manifestFile = await downloadFile({
      repo: { type: "bucket", name: manifest.indexBucket },
      accessToken: client.accessToken,
      path: "index/current.json",
      ...hubOptions(client),
    });
    checks.push(
      manifestFile === null
        ? fail("index.manifest", "The durable index manifest is missing.")
        : pass("index.manifest", "The durable index manifest exists."),
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
      manifest.rawBucket,
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
  pushOptionalCheck(checks, liveStorageCredentialCheck(health));
  pushOptionalCheck(checks, liveStorageStateCheck(health));
  pushOptionalCheck(checks, liveEnrichmentCheck(health));
  pushOptionalCheck(checks, liveEnrichmentStateCheck(health));
  recordIndexedStorageCheck(checks, tweets);
}

function pushOptionalCheck(checks: DoctorCheck[], check: DoctorCheck | undefined): void {
  if (check !== undefined) checks.push(check);
}

function recordIndexedStorageCheck(checks: DoctorCheck[], tweets: number | undefined): void {
  const segmentCount = checkNumber(checks, "storage.segments", "count") ?? 0;
  const storageRecordCount = checkNumber(checks, "storage.segments", "records");
  if (segmentCount === 0 || tweets === undefined || storageRecordCount === undefined) return;
  checks.push(indexedStorageCheck(segmentCount, storageRecordCount, tweets));
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

function liveStorageCredentialCheck(health: HealthPayload): DoctorCheck | undefined {
  const storage = asRecord(asRecord(health.readiness)["storage"]);
  const credential = text(storage["credential"]);
  if (credential === "ok") return pass("live.storage", "The live Space accepts HF_TOKEN.");
  if (credential === "invalid") {
    const error = credentialError(storage);
    return fail(
      "live.storage",
      error.length > 0
        ? `The live Space reports an unusable HF_TOKEN: ${error}`
        : "The live Space reports an unusable HF_TOKEN.",
    );
  }
  if (credential === "unknown") {
    const error = credentialError(storage);
    return warn(
      "live.storage",
      error.length > 0
        ? `The live Space could not verify HF_TOKEN yet: ${error}`
        : "The live Space could not verify HF_TOKEN yet.",
    );
  }
  return undefined;
}

function liveStorageStateCheck(health: HealthPayload): DoctorCheck | undefined {
  const storage = asRecord(asRecord(health.readiness)["storage"]);
  const state = text(storage["state"]);
  const error = text(storage["error"]);
  if (state === "ready") return pass("live.storage_state", "The live storage state is ready.");
  if (state === "invalid") {
    return fail(
      "live.storage_state",
      error.length > 0
        ? `The live storage state is invalid: ${error}`
        : "The live storage state is invalid.",
    );
  }
  if (state === "unknown") {
    return warn(
      "live.storage_state",
      error.length > 0
        ? `The live storage state is still resolving: ${error}`
        : "The live storage state is still resolving.",
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
  return ["storage", "enrichment"]
    .map((key) => text(asRecord(readiness[key])["error"]))
    .filter((error) => error.length > 0);
}

function credentialError(component: Record<string, unknown>): string {
  const explicit = text(component["credential_error"]);
  return explicit.length > 0 ? explicit : text(component["error"]);
}

function healthCheck(tweets: number | undefined): DoctorCheck {
  return tweets === undefined
    ? warn("live.healthz", "/healthz responded without a numeric tweets count.")
    : pass("live.healthz", `/healthz reports ${String(tweets)} indexed tweets.`, { tweets });
}

function indexedStorageCheck(
  storageFileCount: number,
  storageRecordCount: number | undefined,
  tweets: number,
): DoctorCheck {
  if (tweets === 0) {
    return fail(
      "live.indexed_storage",
      "The storage has valid tweet records, but the live Space indexed zero tweets. Update or restart the Space, then check the Space HF_TOKEN storage credential if it still cannot index them.",
      { storageFiles: storageFileCount, storageRecords: storageRecordCount ?? 0, tweets },
    );
  }
  return pass("live.indexed_storage", "The live Space is indexing storage-backed tweets.");
}

async function repairDoctorFindings(
  client: HubClient,
  username: string,
  report: DoctorReport,
  deps: DoctorDeps,
): Promise<void> {
  const rawBucket = report.rawBucket;
  if (rawBucket === undefined) return;
  const repair = repairDependencies(deps);
  const jobVariablesChanged = await maybeRepairJobVariables(client, report);
  const webWorkerChanged = await maybeDisableSpaceEnrichment(client, report);
  const generatedChanged = await maybeRepairGeneratedSecrets(client, report, repair);
  const storageRepairKind = storageTokenRepairKind(report);
  const storageChanged =
    generatedChanged && storageRepairKind === "indeterminate"
      ? false
      : await maybeRepairStorageToken(client, report, rawBucket, repair, storageRepairKind);
  if ([webWorkerChanged, generatedChanged, storageChanged].includes(true)) {
    await repair.restartAndWait(report.spaceRepo);
  }
  await maybeRepairEnrichmentJob(
    client,
    username,
    report,
    repair,
    jobVariablesChanged,
    storageChanged,
  );
}

type RepairDependencies = StorageRepairDeps &
  GeneratedSecretRepairDeps &
  JobRepairDeps & {
    restartAndWait: (spaceRepo: string) => Promise<void>;
  };

// eslint-disable-next-line complexity -- Dependency defaults are centralized so every repair branch is injectable in tests.
function repairDependencies(deps: DoctorDeps): RepairDependencies {
  return {
    promptStorageToken: deps.promptStorageToken ?? promptStorageTokenDefault,
    confirmStorageTokenRepair: deps.confirmStorageTokenRepair ?? confirmStorageTokenRepairDefault,
    validateStorageToken: deps.validateStorageToken ?? validateStorageTokenDefault,
    confirmGeneratedSecretRepair:
      deps.confirmGeneratedSecretRepair ?? confirmGeneratedSecretRepairDefault,
    validateInferenceToken: deps.validateInferenceToken ?? validateInferenceTokenDefault,
    inspectJob: deps.inspectJob ?? inspectEnrichmentJob,
    reconcileJob: deps.reconcileJob ?? reconcileEnrichmentJob,
    promptJobStorageToken: deps.promptJobStorageToken ?? promptJobStorageTokenDefault,
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

type StorageRepairDeps = {
  promptStorageToken: (rawBucket: string) => Promise<string>;
  confirmStorageTokenRepair: (rawBucket: string, report: DoctorReport) => Promise<boolean>;
  validateStorageToken: (
    token: string,
    rawBucket: string,
    indexBucket: string,
  ) => Promise<readonly string[]>;
};

async function maybeRepairStorageToken(
  client: HubClient,
  report: DoctorReport,
  rawBucket: string,
  deps: StorageRepairDeps,
  repairKind = storageTokenRepairKind(report),
): Promise<boolean> {
  if (repairKind === undefined) return false;
  if (
    repairKind === "indeterminate" &&
    !(await deps.confirmStorageTokenRepair(rawBucket, report))
  ) {
    return false;
  }
  const token = await promptForValidToken(
    "Storage credential rejected",
    () => deps.promptStorageToken(rawBucket),
    (candidate) => deps.validateStorageToken(candidate, rawBucket, requiredIndexBucket(report)),
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
  promptJobStorageToken: (rawBucket: string) => Promise<string>;
  promptJobInferenceToken: () => Promise<string>;
  validateStorageToken: (
    token: string,
    rawBucket: string,
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
  storageCredentialChanged: boolean,
): Promise<void> {
  if (
    !variablesChanged &&
    !storageCredentialChanged &&
    !report.checks.some((check) => check.code === "job.schedule" && check.status === "fail")
  ) {
    return;
  }
  const variables = await getSpaceVariables(client, report.spaceRepo);
  const manifest = manifestFromSpace(username, report.spaceRepo, variables);
  const desired = await desiredEnrichmentJob(
    client,
    manifest.spaceRepo,
    manifest.rawBucket,
    variables,
  );
  const inspection = await deps.inspectJob(client, desired);
  if (inspection.activeJobs.length > 0) {
    throw new Error("Refusing Hugging Face schedule repair while an enrichment Job is active.");
  }
  if (inspection.exactSchedules.length > 0 && !storageCredentialChanged) {
    await deps.reconcileJob(client, desired);
    return;
  }
  const storageToken = await promptForValidToken(
    "Job storage credential rejected",
    () => deps.promptJobStorageToken(manifest.rawBucket),
    (candidate) => deps.validateStorageToken(candidate, manifest.rawBucket, manifest.indexBucket),
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
  if (failedCodes.has("space.secret.HF_TOKEN") || failedCodes.has("live.storage"))
    return "definite";
  if (failedCodes.has("live.indexed_storage")) return "indeterminate";
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

async function validateStorageTokenDefault(
  token: string,
  rawBucket: string,
  indexBucket: string,
): Promise<readonly string[]> {
  const validation = await verifyStorageWriteToken({ token, rawBucket, indexBucket });
  return validation.ok ? [] : validation.errors;
}

async function validateInferenceTokenDefault(token: string): Promise<readonly string[]> {
  const validation = await verifyInferenceToken({ token });
  return validation.ok ? [] : validation.errors;
}

async function promptStorageTokenDefault(rawBucket: string): Promise<string> {
  note(
    `Paste a fine-grained token scoped to read/write ${rawBucket} and the configured index Bucket. It will be written to the Space as HF_TOKEN.`,
    "Storage credential",
  );
  return promptPassword("Storage-only HF_TOKEN");
}

async function confirmStorageTokenRepairDefault(
  rawBucket: string,
  report: DoctorReport,
): Promise<boolean> {
  note(
    [
      "The live Space health endpoint is unavailable, but doctor cannot prove the Space HF_TOKEN is the cause.",
      `Replace HF_TOKEN only if you want to rotate the storage credential for ${rawBucket}.`,
      `Failing checks: ${report.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.code)
        .join(", ")}`,
    ].join("\n"),
    "Indeterminate repair",
  );
  const ok = await confirm({
    message: `Replace the Space HF_TOKEN for ${rawBucket}?`,
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

async function promptJobStorageTokenDefault(rawBucket: string): Promise<string> {
  note(
    [
      `Paste a fine-grained token scoped to read/write ${rawBucket} and the configured index Bucket.`,
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

type StorageSegmentStats = { segments: number; records: number };

// eslint-disable-next-line complexity -- Segment inspection validates every structural and checksum boundary.
async function storageSegmentStats(
  client: HubClient,
  rawBucket: string,
): Promise<StorageSegmentStats> {
  const paths: string[] = [];
  try {
    for await (const entry of listFiles({
      repo: { type: "bucket", name: rawBucket },
      accessToken: client.accessToken,
      recursive: true,
      path: "v1/segments",
      ...hubOptions(client),
    })) {
      if (entry.type === "file" && entry.path.endsWith(".json.gz")) paths.push(entry.path);
    }
  } catch (error) {
    if (asRecord(error)["statusCode"] === 404) return { segments: 0, records: 0 };
    throw error;
  }
  let records = 0;
  for (const path of paths) {
    const blob = await downloadFile({
      repo: { type: "bucket", name: rawBucket },
      accessToken: client.accessToken,
      path,
      ...hubOptions(client),
    });
    if (blob === null) throw new Error(`raw Bucket segment disappeared: ${path}`);
    const raw = gunzipSync(new Uint8Array(await blob.arrayBuffer()));
    const expected = /-([a-f0-9]{64})\.json\.gz$/u.exec(path)?.[1];
    if (expected === undefined || createHash("sha256").update(raw).digest("hex") !== expected) {
      throw new Error(`raw Bucket segment checksum mismatch: ${path}`);
    }
    const segment = asRecord(JSON.parse(raw.toString("utf8")) as unknown);
    if (segment["schema_version"] !== 1 || !Array.isArray(segment["operations"])) {
      throw new Error(`invalid raw Bucket segment: ${path}`);
    }
    for (const operation of segment["operations"]) {
      const value = asRecord(operation);
      if (value["mode"] === "append" && Array.isArray(value["lines"])) {
        if (!value["lines"].every((line) => typeof line === "string" && line.length > 0)) {
          throw new Error(`invalid raw Bucket append operation: ${path}`);
        }
        records += value["lines"].length;
      } else if (value["mode"] !== "write" || typeof value["content"] !== "string") {
        throw new Error(`invalid raw Bucket operation: ${path}`);
      }
    }
  }
  return { segments: paths.length, records };
}

function hubOptions(client: HubClient): { hubUrl?: string; fetch?: typeof fetch } {
  return {
    ...(client.hubUrl === undefined ? {} : { hubUrl: client.hubUrl }),
    ...(client.fetchFn === undefined ? {} : { fetch: client.fetchFn }),
  };
}

function report(
  spaceRepo: string,
  rawBucket: string | undefined,
  indexBucket: string | undefined,
  checks: readonly DoctorCheck[],
): DoctorReport {
  return {
    spaceRepo,
    ...(rawBucket === undefined ? {} : { rawBucket }),
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
