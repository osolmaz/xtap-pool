import { randomBytes } from "node:crypto";

import { downloadFile, listFiles } from "@huggingface/hub";
import { cancel, confirm, intro, isCancel, note, outro, password, spinner } from "@clack/prompts";

import { validateTweet } from "@xtap-pool/shared";

import { spacePublicUrl, validateUserList } from "./config.js";
import {
  getRepoPrivateState,
  getSpaceSecrets,
  getSpaceVariables,
  setSpaceSecret,
} from "./hub-api.js";
import type { HubClient } from "./hub-api.js";
import { verifyInferenceToken } from "./inference-token.js";
import { manifestFromSpace } from "./manifest.js";
import type { PoolManifest } from "./manifest.js";
import { captureCommand } from "./process.js";
import { verifyDatasetWriteToken } from "./token.js";

export type DoctorOptions = {
  spaceRepo: string;
  json: boolean;
  fix: boolean;
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
  validateDatasetToken?: (token: string, datasetRepo: string) => Promise<readonly string[]>;
  validateInferenceToken?: (token: string) => Promise<readonly string[]>;
  restartAndWait?: (spaceRepo: string) => Promise<void>;
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
  const report = await collectDoctorReport(client, username, options.spaceRepo, deps);
  if (options.fix && report.datasetRepo !== undefined) {
    await repairDoctorFindings(client, report, deps);
    const repaired = await collectDoctorReport(client, username, options.spaceRepo, deps);
    if (options.json) printJson(repaired);
    else printHuman(repaired);
    return repaired;
  }
  if (options.json) printJson(report);
  else printHuman(report);
  return report;
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
    return report(spaceRepo, undefined, checks);
  }

  let manifest: PoolManifest;
  try {
    manifest = manifestFromSpace(username, spaceRepo, variables);
    checks.push(pass("pool.manifest", `Derived desired state for ${spaceRepo}.`));
  } catch (error) {
    checks.push(fail("pool.manifest", errorMessage(error)));
    return report(spaceRepo, undefined, checks);
  }

  for (const key of manifest.requiredVariables) {
    checks.push(variableCheck(key, variables.get(key)));
  }

  await checkSecrets(client, manifest, checks);
  await checkDataset(client, manifest, checks);
  await checkLiveHealth(manifest, checks, deps.fetchFn ?? fetch);

  return report(spaceRepo, manifest.datasetRepo, checks);
}

function variableCheck(key: string, value: string | undefined): DoctorCheck {
  if (value === undefined) return fail(`space.variable.${key}`, `${key} is missing.`);
  if (value.trim() === "") return fail(`space.variable.${key}`, `${key} is empty.`);
  if (key === "ALLOWED_USERS" || key === "POOL_ADMINS") {
    const error = validateUserList(value);
    if (error !== undefined) return fail(`space.variable.${key}`, `${key} is invalid: ${error}`);
  }
  return pass(`space.variable.${key}`, `${key} is set.`);
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
  report: DoctorReport,
  deps: DoctorDeps,
): Promise<void> {
  const datasetRepo = report.datasetRepo;
  if (datasetRepo === undefined) return;
  const repair = repairDependencies(deps);
  const generatedChanged = await maybeRepairGeneratedSecrets(client, report, repair);
  const datasetRepairKind = datasetTokenRepairKind(report);
  const datasetChanged =
    generatedChanged && datasetRepairKind === "indeterminate"
      ? false
      : await maybeRepairDatasetToken(client, report, datasetRepo, repair, datasetRepairKind);
  const inferenceChanged = await maybeRepairInferenceToken(client, report, repair);

  if ([generatedChanged, datasetChanged, inferenceChanged].includes(true)) {
    await repair.restartAndWait(report.spaceRepo);
  }
}

type RepairDependencies = DatasetRepairDeps &
  InferenceRepairDeps &
  GeneratedSecretRepairDeps & {
    restartAndWait: (spaceRepo: string) => Promise<void>;
  };

function repairDependencies(deps: DoctorDeps): RepairDependencies {
  return {
    promptDatasetToken: deps.promptDatasetToken ?? promptDatasetTokenDefault,
    confirmDatasetTokenRepair: deps.confirmDatasetTokenRepair ?? confirmDatasetTokenRepairDefault,
    validateDatasetToken: deps.validateDatasetToken ?? validateDatasetTokenDefault,
    promptInferenceToken: deps.promptInferenceToken ?? promptInferenceTokenDefault,
    confirmGeneratedSecretRepair:
      deps.confirmGeneratedSecretRepair ?? confirmGeneratedSecretRepairDefault,
    validateInferenceToken: deps.validateInferenceToken ?? validateInferenceTokenDefault,
    restartAndWait: deps.restartAndWait ?? restartAndWaitDefault,
  };
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
  validateDatasetToken: (token: string, datasetRepo: string) => Promise<readonly string[]>;
};

async function maybeRepairDatasetToken(
  client: HubClient,
  report: DoctorReport,
  datasetRepo: string,
  deps: DatasetRepairDeps,
  repairKind = datasetTokenRepairKind(report),
): Promise<boolean> {
  if (repairKind === undefined) return false;
  if (
    repairKind === "indeterminate" &&
    !(await deps.confirmDatasetTokenRepair(datasetRepo, report))
  ) {
    return false;
  }
  const token = await deps.promptDatasetToken(datasetRepo);
  const errors = await deps.validateDatasetToken(token, datasetRepo);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  await setSpaceSecret(client, report.spaceRepo, "HF_TOKEN", token);
  return true;
}

type InferenceRepairDeps = {
  promptInferenceToken: () => Promise<string>;
  validateInferenceToken: (token: string) => Promise<readonly string[]>;
};

async function maybeRepairInferenceToken(
  client: HubClient,
  report: DoctorReport,
  deps: InferenceRepairDeps,
): Promise<boolean> {
  if (!needsInferenceToken(report)) return false;
  const token = await deps.promptInferenceToken();
  const errors = await deps.validateInferenceToken(token);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  await setSpaceSecret(client, report.spaceRepo, "INFERENCE_TOKEN", token);
  return true;
}

function datasetTokenRepairKind(report: DoctorReport): "definite" | "indeterminate" | undefined {
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

function needsInferenceToken(report: DoctorReport): boolean {
  return report.checks.some(
    (check) =>
      check.status === "fail" &&
      (check.code === "space.secret.INFERENCE_TOKEN" || check.code === "live.enrichment"),
  );
}

async function validateDatasetTokenDefault(
  token: string,
  datasetRepo: string,
): Promise<readonly string[]> {
  const validation = await verifyDatasetWriteToken({ token, datasetRepo });
  return validation.ok ? [] : validation.errors;
}

async function validateInferenceTokenDefault(token: string): Promise<readonly string[]> {
  const validation = await verifyInferenceToken({ token });
  return validation.ok ? [] : validation.errors;
}

async function promptDatasetTokenDefault(datasetRepo: string): Promise<string> {
  note(
    `Paste a fine-grained token scoped to read/write ${datasetRepo}. It will be written to the Space as HF_TOKEN.`,
    "Dataset credential",
  );
  return promptPassword("Dataset-only HF_TOKEN");
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

async function promptInferenceTokenDefault(): Promise<string> {
  note(
    [
      "Paste a separate fine-grained token with the `Make calls to Inference Providers` permission.",
      "It will be written to the Space as INFERENCE_TOKEN.",
    ].join("\n"),
    "Inference credential",
  );
  return promptPassword("Inference Providers token");
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
  checks: readonly DoctorCheck[],
): DoctorReport {
  return {
    spaceRepo,
    ...(datasetRepo === undefined ? {} : { datasetRepo }),
    summary: {
      pass: checks.filter((check) => check.status === "pass").length,
      warn: checks.filter((check) => check.status === "warn").length,
      fail: checks.filter((check) => check.status === "fail").length,
    },
    checks,
  };
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
