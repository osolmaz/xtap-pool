import { createHash } from "node:crypto";

import {
  createScheduledJob,
  deleteScheduledJob,
  downloadFile,
  getJob,
  getScheduledJob,
  listFiles,
  listJobs,
  listScheduledJobs,
  resumeScheduledJob,
  runScheduledJob,
  suspendScheduledJob,
} from "@huggingface/hub";
import {
  canonicalJson,
  deploymentManifestSchema,
  DEPLOYMENT_MANIFEST_PATH,
  parseEnrichReceipt,
} from "@xtap-pool/shared";
import type { EnrichReceipt } from "@xtap-pool/shared";
import { z } from "zod";

import type { HubClient } from "./hub-api.js";

export const ENRICHMENT_JOB_LABELS = {
  app: "xtap-pool",
  component: "enrichment",
} as const;

export const ENRICHMENT_JOB_DEFAULT_VARIABLES: Readonly<Record<string, string>> = {
  ENRICH_JOB_SCHEDULE: "17 */6 * * *",
  ENRICH_JOB_TIMEOUT_SECONDS: "2700",
  ENRICH_MAX_UNITS_PER_TICK: "50",
  ENRICH_MAX_TOKENS: "400000",
  ENRICH_MAX_ELAPSED_MS: "2400000",
  ENRICH_MAX_ERROR_RATE: "0.25",
  ENRICH_MAX_COST_USD: "2",
  ENRICH_MAX_COST_PER_CALL_USD: "0.25",
  ENRICH_INPUT_TOKEN_USD: "0.0000014",
  ENRICH_OUTPUT_TOKEN_USD: "0.0000044",
  ENRICH_MAX_DISCARDED_ASSIGNMENTS: "100",
  LLM_MODEL: "zai-org/GLM-5.2:fireworks-ai",
  TAXONOMY_VERSION: "1",
};

const JOB_SECRET_NAMES = ["HF_TOKEN", "INFERENCE_TOKEN"] as const;
const JOB_SECRET_NAMES_LABEL = [...JOB_SECRET_NAMES].sort().join(".");
const JOB_COMMAND = ["node", "space/dist/src/enrich-job-main.js"] as const;
const ACTIVE_JOB_STAGES = new Set(["RUNNING", "PAUSED", "UPDATING"]);
const SUCCESSFUL_JOB_STAGES = new Set(["STOPPED", "COMPLETED"]);
// Rounded up from Hugging Face's current $0.000167/min cpu-basic rate.
const CPU_BASIC_HOURLY_CEILING_USD = 0.011;

const nonempty = z.string().min(1);
const positiveInteger = z.string().regex(/^[1-9][0-9]*$/u);
const nonnegativeInteger = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const positiveNumber = z.string().refine((value) => finiteNumber(value) > 0, "must be positive");
const nonnegativeNumber = z
  .string()
  .refine((value) => finiteNumber(value) >= 0, "must be nonnegative");
const rate = z.string().refine((value) => {
  const parsed = finiteNumber(value);
  return parsed >= 0 && parsed <= 1;
}, "must be between 0 and 1");
const cronSchedule = z
  .string()
  .refine(isSupportedCronSchedule, "must be a supported alias or five-field cron expression");

const jobVariablesSchema = z
  .object({
    ENRICH_JOB_SCHEDULE: cronSchedule,
    ENRICH_JOB_TIMEOUT_SECONDS: positiveInteger,
    ENRICH_MAX_UNITS_PER_TICK: positiveInteger,
    ENRICH_MAX_TOKENS: positiveInteger,
    ENRICH_MAX_ELAPSED_MS: positiveInteger,
    ENRICH_MAX_ERROR_RATE: rate,
    ENRICH_MAX_COST_USD: positiveNumber,
    ENRICH_MAX_COST_PER_CALL_USD: positiveNumber,
    ENRICH_INPUT_TOKEN_USD: nonnegativeNumber,
    ENRICH_OUTPUT_TOKEN_USD: nonnegativeNumber,
    ENRICH_MAX_DISCARDED_ASSIGNMENTS: nonnegativeInteger,
    LLM_MODEL: nonempty,
    TAXONOMY_VERSION: positiveInteger,
  })
  .strict();

export function enrichmentJobVariableError(key: string, value: string): string | undefined {
  if (!Object.hasOwn(ENRICHMENT_JOB_DEFAULT_VARIABLES, key)) return undefined;
  const parsed = jobVariablesSchema.safeParse({
    ...ENRICHMENT_JOB_DEFAULT_VARIABLES,
    [key]: value,
  });
  if (parsed.success) return undefined;
  const issue = parsed.error.issues.find((candidate) => candidate.path[0] === key);
  return issue?.message ?? "invalid bounded enrichment setting";
}

const stringMapSchema = z.record(z.string(), z.string());
const jobWireShape = {
  spaceId: z.string().nullish(),
  command: z.array(z.string()).nullish(),
  environment: stringMapSchema.nullish(),
  // The live Jobs wire response currently uses `timeout`; the published
  // SDK type calls the same response field `timeoutSeconds`.
  timeout: z.number().int().positive().nullish(),
  timeoutSeconds: z.number().int().positive().nullish(),
  attempts: z.number().int().positive().nullish(),
  retry: z.number().int().nonnegative().nullish(),
  secrets: z.array(z.string()).optional(),
  labels: stringMapSchema.nullish(),
} as const;
const scheduledJobSchema = z
  .object({
    id: nonempty,
    schedule: nonempty,
    suspend: z.boolean(),
    concurrency: z.boolean(),
    jobSpec: z
      .object({
        ...jobWireShape,
        flavor: nonempty,
      })
      .loose(),
  })
  .loose();

const physicalJobSchema = z
  .object({
    id: nonempty,
    status: z.object({ stage: nonempty }).loose(),
    ...jobWireShape,
    flavor: z.string().nullish(),
  })
  .loose();

export type ScheduledEnrichmentJob = z.infer<typeof scheduledJobSchema>;
export type PhysicalEnrichmentJob = z.infer<typeof physicalJobSchema>;

export type EnrichmentJobSecrets = {
  datasetToken: string;
  inferenceToken: string;
};

export type DesiredEnrichmentJob = {
  namespace: string;
  spaceRepo: string;
  sourceRevision: string;
  schedule: string;
  timeoutSeconds: number;
  environment: Readonly<Record<string, string>>;
  labels: Readonly<Record<string, string>>;
};

export type EnrichmentJobInspection = {
  desired: DesiredEnrichmentJob;
  schedules: readonly ScheduledEnrichmentJob[];
  exactSchedules: readonly ScheduledEnrichmentJob[];
  mismatchedSchedules: readonly ScheduledEnrichmentJob[];
  activeJobs: readonly PhysicalEnrichmentJob[];
};

export async function desiredEnrichmentJob(
  client: HubClient,
  spaceRepo: string,
  datasetRepo: string,
  variables: ReadonlyMap<string, string>,
): Promise<DesiredEnrichmentJob> {
  const deployment = await readDeploymentManifest(client, spaceRepo);
  const configured = jobVariablesSchema.parse(
    Object.fromEntries(
      Object.keys(jobVariablesSchema.shape).map((key) => [key, variables.get(key)]),
    ),
  );
  const namespace = spaceRepo.split("/")[0];
  if (namespace === undefined || namespace.length === 0) {
    throw new Error(`Invalid Space repository: ${spaceRepo}.`);
  }
  const environment = {
    DATA_DIR: "/tmp/xtap-pool-enrichment",
    DATASET_REPO: datasetRepo,
    ENRICH_ENABLED: "true",
    ENRICH_MAX_UNITS_PER_TICK: configured.ENRICH_MAX_UNITS_PER_TICK,
    ENRICH_MAX_TOKENS: configured.ENRICH_MAX_TOKENS,
    ENRICH_MAX_ELAPSED_MS: configured.ENRICH_MAX_ELAPSED_MS,
    ENRICH_MAX_ERROR_RATE: configured.ENRICH_MAX_ERROR_RATE,
    ENRICH_MAX_COST_USD: configured.ENRICH_MAX_COST_USD,
    ENRICH_MAX_COST_PER_CALL_USD: configured.ENRICH_MAX_COST_PER_CALL_USD,
    ENRICH_INPUT_TOKEN_USD: configured.ENRICH_INPUT_TOKEN_USD,
    ENRICH_OUTPUT_TOKEN_USD: configured.ENRICH_OUTPUT_TOKEN_USD,
    ENRICH_MAX_DISCARDED_ASSIGNMENTS: configured.ENRICH_MAX_DISCARDED_ASSIGNMENTS,
    LLM_MODEL: configured.LLM_MODEL,
    TAXONOMY_VERSION: configured.TAXONOMY_VERSION,
    XTAP_SOURCE_REVISION: deployment.source_revision,
    POOL_SIGNING_SECRET: "job-not-used-0000000000000000000000000",
    SESSION_SECRET: "job-not-used-00000000000000000000000000",
    ALLOWED_USERS: "worker",
    POOL_ADMINS: "worker",
    OAUTH_CLIENT_ID: "job-not-used",
    OAUTH_CLIENT_SECRET: "job-not-used",
    SPACE_HOST: "worker.invalid",
  } as const;
  return {
    namespace,
    spaceRepo,
    sourceRevision: deployment.source_revision,
    schedule: configured.ENRICH_JOB_SCHEDULE,
    timeoutSeconds: Number(configured.ENRICH_JOB_TIMEOUT_SECONDS),
    environment,
    labels: {
      ...ENRICHMENT_JOB_LABELS,
      name: "xtap-pool-enrichment",
      space_repo: jobSpaceRepoLabel(spaceRepo),
      source_revision: deployment.source_revision,
      secret_names: JOB_SECRET_NAMES_LABEL,
    },
  };
}

export async function inspectEnrichmentJob(
  client: HubClient,
  desired: DesiredEnrichmentJob,
): Promise<EnrichmentJobInspection> {
  const [scheduledPayload, jobsPayload] = await Promise.all([
    listScheduledJobs({ namespace: desired.namespace, ...hubOptions(client) }),
    listJobs({ namespace: desired.namespace, ...hubOptions(client) }),
  ]);
  const schedules = z
    .array(scheduledJobSchema)
    .parse(scheduledPayload)
    .filter((job) => ownsJob(job.jobSpec.labels, desired.spaceRepo));
  const activeJobs = z
    .array(physicalJobSchema)
    .parse(jobsPayload)
    .filter(
      (job) => ownsJob(job.labels, desired.spaceRepo) && ACTIVE_JOB_STAGES.has(job.status.stage),
    );
  const exactSchedules = schedules.filter((job) => scheduleMatches(job, desired));
  return {
    desired,
    schedules,
    exactSchedules,
    mismatchedSchedules: schedules.filter((job) => !scheduleMatches(job, desired)),
    activeJobs,
  };
}

// eslint-disable-next-line complexity -- Schedule replacement ordering is centralized to preserve suspension, overlap, creation, verification, and deletion invariants.
export async function reconcileEnrichmentJob(
  client: HubClient,
  desired: DesiredEnrichmentJob,
  secrets?: EnrichmentJobSecrets,
): Promise<ScheduledEnrichmentJob> {
  const before = await inspectEnrichmentJob(client, desired);
  if (before.activeJobs.length > 0) {
    throw new Error(
      `Refusing schedule repair while ${String(before.activeJobs.length)} matching Hugging Face Job(s) are active.`,
    );
  }
  const exact = before.exactSchedules[0];
  const needsReplacement = exact === undefined || secrets !== undefined;
  if (!needsReplacement) {
    await suspendAndDeleteExtras(client, desired.namespace, before.schedules, exact.id);
    return exact;
  }
  if (secrets === undefined) {
    throw new Error(
      "Dataset-writer and inference token values are required to create the scheduled Job.",
    );
  }
  for (const schedule of before.schedules) {
    if (!schedule.suspend) {
      await suspendScheduledJob({
        namespace: desired.namespace,
        jobId: schedule.id,
        ...hubOptions(client),
      });
    }
  }
  const afterSuspend = await inspectEnrichmentJob(client, desired);
  if (afterSuspend.activeJobs.length > 0) {
    throw new Error(
      "A matching Hugging Face Job became active while its schedule was being repaired.",
    );
  }
  const createdPayload = await createScheduledJob({
    namespace: desired.namespace,
    schedule: desired.schedule,
    suspend: true,
    concurrency: false,
    jobSpec: {
      spaceId: desired.spaceRepo,
      command: [...JOB_COMMAND],
      environment: { ...desired.environment },
      secrets: { HF_TOKEN: secrets.datasetToken, INFERENCE_TOKEN: secrets.inferenceToken },
      flavor: "cpu-basic",
      timeoutSeconds: desired.timeoutSeconds,
      attempts: 1,
      labels: { ...desired.labels },
    },
    ...hubOptions(client),
  });
  const createdId = scheduledJobSchema.parse(createdPayload).id;
  const verified = scheduledJobSchema.parse(
    await getScheduledJob({
      namespace: desired.namespace,
      jobId: createdId,
      ...hubOptions(client),
    }),
  );
  if (!scheduleMatches(verified, desired) || !verified.suspend) {
    throw new Error(
      "Hugging Face returned a scheduled Job that does not match the requested contract.",
    );
  }
  for (const schedule of before.schedules) {
    await deleteScheduledJob({
      namespace: desired.namespace,
      jobId: schedule.id,
      ...hubOptions(client),
    });
  }
  return verified;
}

export async function suspendMismatchedEnrichmentSchedules(
  client: HubClient,
  desired: DesiredEnrichmentJob,
): Promise<number> {
  const inspection = await inspectEnrichmentJob(client, desired);
  let suspended = 0;
  for (const schedule of inspection.mismatchedSchedules) {
    if (schedule.suspend) continue;
    await suspendScheduledJob({
      namespace: desired.namespace,
      jobId: schedule.id,
      ...hubOptions(client),
    });
    suspended += 1;
  }
  return suspended;
}

export async function triggerEnrichmentJob(
  client: HubClient,
  desired: DesiredEnrichmentJob,
  scheduleId: string,
): Promise<PhysicalEnrichmentJob> {
  const inspection = await inspectEnrichmentJob(client, desired);
  if (inspection.activeJobs.length > 0) {
    throw new Error("A matching Hugging Face Job is already active.");
  }
  const payload = await runScheduledJob({
    namespace: desired.namespace,
    jobId: scheduleId,
    ...hubOptions(client),
  });
  if (payload === null)
    throw new Error("Hugging Face refused the trigger because a Job is active.");
  return physicalJobSchema.parse(payload);
}

export type EnrichmentCanaryRun = {
  jobId: string;
  receipt: EnrichReceipt;
};

export type EnrichmentCanaryResult = {
  hardCeilingUsd: number;
  runs: readonly [EnrichmentCanaryRun, EnrichmentCanaryRun];
};

// eslint-disable-next-line complexity -- The two-run canary validates one cumulative cost and continuation contract before returning evidence.
export async function runEnrichmentCanary(
  client: HubClient,
  desired: DesiredEnrichmentJob,
  datasetRepo: string,
  options: {
    pollIntervalMs?: number;
    receiptTimeoutMs?: number;
    resumeJobId?: string;
  } = {},
): Promise<EnrichmentCanaryResult> {
  const inspection = await inspectEnrichmentJob(client, desired);
  if (inspection.exactSchedules.length !== 1 || inspection.schedules.length !== 1) {
    throw new Error("The recovery canary requires one exact Hugging Face enrichment schedule.");
  }
  const schedule = inspection.exactSchedules[0];
  if (!schedule?.suspend) {
    throw new Error("The recovery canary requires a suspended schedule.");
  }
  const hardCeilingUsd = canaryHardCeilingUsd(desired);
  if (hardCeilingUsd >= 5) {
    throw new Error(
      `The two-run canary hard ceiling is $${hardCeilingUsd.toFixed(2)}, which requires explicit paid-run approval.`,
    );
  }
  const first =
    options.resumeJobId === undefined
      ? await runOneCanaryJob(client, desired, datasetRepo, schedule.id, options)
      : await recoverCanaryRun(client, desired, datasetRepo, options.resumeJobId);
  if (options.resumeJobId !== undefined) {
    assertCanaryContinuationBudget(first.receipt, desired, hardCeilingUsd);
  }
  const second = await runOneCanaryJob(client, desired, datasetRepo, schedule.id, options);
  if (first.jobId === second.jobId) throw new Error("Hugging Face reused a physical Job ID.");
  if (first.receipt.contract_hash !== second.receipt.contract_hash) {
    throw new Error("Canary attempts used different enrichment contracts.");
  }
  return { hardCeilingUsd, runs: [first, second] };
}

export function canaryHardCeilingUsd(desired: DesiredEnrichmentJob): number {
  const inferencePerRun = Number(desired.environment["ENRICH_MAX_COST_USD"]);
  if (!Number.isFinite(inferencePerRun) || inferencePerRun <= 0) {
    throw new Error("ENRICH_MAX_COST_USD must be a measurable positive canary ceiling.");
  }
  const cpuPerRun = (desired.timeoutSeconds / 3600) * CPU_BASIC_HOURLY_CEILING_USD;
  return 2 * (inferencePerRun + cpuPerRun);
}

async function runOneCanaryJob(
  client: HubClient,
  desired: DesiredEnrichmentJob,
  datasetRepo: string,
  scheduleId: string,
  options: { pollIntervalMs?: number; receiptTimeoutMs?: number },
): Promise<EnrichmentCanaryRun> {
  const job = await triggerEnrichmentJob(client, desired, scheduleId);
  await waitForJob(
    client,
    desired.namespace,
    job.id,
    desired.timeoutSeconds,
    options.pollIntervalMs,
  );
  const receipt = await waitForJobReceipt(
    client,
    datasetRepo,
    job.id,
    options.receiptTimeoutMs ?? 60_000,
    options.pollIntervalMs ?? 5_000,
  );
  validateCanaryReceipt(receipt, desired);
  return { jobId: job.id, receipt };
}

async function recoverCanaryRun(
  client: HubClient,
  desired: DesiredEnrichmentJob,
  datasetRepo: string,
  jobId: string,
): Promise<EnrichmentCanaryRun> {
  const job = physicalJobSchema.parse(
    await getJob({ namespace: desired.namespace, jobId, ...hubOptions(client) }),
  );
  if (!SUCCESSFUL_JOB_STAGES.has(job.status.stage)) {
    throw new Error(`Cannot resume from Hugging Face Job ${jobId} in ${job.status.stage}.`);
  }
  if (!physicalJobMatches(job, desired)) {
    throw new Error(`Cannot resume from Hugging Face Job ${jobId} with a different contract.`);
  }
  const receipt = await findJobReceipt(client, datasetRepo, jobId);
  if (receipt === undefined) {
    throw new Error(`No durable enrichment receipt was found for Hugging Face Job ${jobId}.`);
  }
  validateCanaryReceipt(receipt, desired);
  return { jobId, receipt };
}

async function waitForJob(
  client: HubClient,
  namespace: string,
  jobId: string,
  timeoutSeconds: number,
  pollIntervalMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1_000 + 120_000;
  while (Date.now() <= deadline) {
    const job = physicalJobSchema.parse(await getJob({ namespace, jobId, ...hubOptions(client) }));
    if (SUCCESSFUL_JOB_STAGES.has(job.status.stage)) return;
    if (job.status.stage === "ERROR" || job.status.stage === "DELETING") {
      throw new Error(`Hugging Face Job ${jobId} ended in ${job.status.stage}.`);
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for Hugging Face Job ${jobId}.`);
}

async function waitForJobReceipt(
  client: HubClient,
  datasetRepo: string,
  jobId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<EnrichReceipt> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const receipt = await findJobReceipt(client, datasetRepo, jobId);
    if (receipt !== undefined) return receipt;
    await delay(pollIntervalMs);
  }
  throw new Error(`No durable enrichment receipt was found for Hugging Face Job ${jobId}.`);
}

// eslint-disable-next-line complexity -- Receipt discovery intentionally validates every external shard and line while ignoring malformed legacy rows.
async function findJobReceipt(
  client: HubClient,
  datasetRepo: string,
  jobId: string,
): Promise<EnrichReceipt | undefined> {
  const paths: string[] = [];
  for await (const entry of listFiles({
    repo: { type: "dataset", name: datasetRepo },
    path: "enrichment/receipts",
    recursive: true,
    ...hubOptions(client),
  })) {
    if (entry.type === "file" && entry.path.endsWith(".jsonl")) paths.push(entry.path);
  }
  paths.sort().reverse();
  for (const path of paths) {
    const blob = await downloadFile({
      repo: { type: "dataset", name: datasetRepo },
      path,
      ...hubOptions(client),
    });
    if (blob === null) throw new Error(`Receipt shard disappeared: ${path}.`);
    for (const line of (await blob.text()).split("\n")) {
      if (line.trim() === "") continue;
      let candidate: unknown;
      try {
        candidate = JSON.parse(line);
      } catch {
        continue;
      }
      const receipt = parseEnrichReceipt(candidate);
      if (receipt?.worker_id === jobId) return receipt;
    }
  }
  return undefined;
}

function assertCanaryContinuationBudget(
  receipt: EnrichReceipt,
  desired: DesiredEnrichmentJob,
  hardCeilingUsd: number,
): void {
  if (receipt.cost_usd === undefined) {
    throw new Error("Cannot resume a canary without measured prior cost.");
  }
  const computePerRun = (desired.timeoutSeconds / 3600) * CPU_BASIC_HOURLY_CEILING_USD;
  const nextRunCeiling = Number(desired.environment["ENRICH_MAX_COST_USD"]) + computePerRun;
  if (receipt.cost_usd + computePerRun + nextRunCeiling > hardCeilingUsd + 1e-9) {
    throw new Error("The resumed canary would exceed its cumulative cost ceiling.");
  }
}

function validateCanaryReceipt(receipt: EnrichReceipt, desired: DesiredEnrichmentJob): void {
  const maxCost = Number(desired.environment["ENRICH_MAX_COST_USD"]);
  const maxTokens = Number(desired.environment["ENRICH_MAX_TOKENS"]);
  const tokens = receipt.prompt_tokens + receipt.completion_tokens;
  if (receipt.cost_usd === undefined || receipt.cost_usd > maxCost) {
    throw new Error("Canary receipt has missing or excessive measured cost.");
  }
  if (tokens > maxTokens) throw new Error("Canary receipt exceeds its token ceiling.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function suspendEnrichmentSchedule(
  client: HubClient,
  desired: DesiredEnrichmentJob,
  scheduleId: string,
): Promise<void> {
  await suspendScheduledJob({
    namespace: desired.namespace,
    jobId: scheduleId,
    ...hubOptions(client),
  });
}

export async function resumeEnrichmentSchedule(
  client: HubClient,
  desired: DesiredEnrichmentJob,
  scheduleId: string,
): Promise<void> {
  const inspection = await inspectEnrichmentJob(client, desired);
  if (inspection.activeJobs.length > 0) {
    throw new Error("A matching Hugging Face Job is already active.");
  }
  await resumeScheduledJob({
    namespace: desired.namespace,
    jobId: scheduleId,
    ...hubOptions(client),
  });
}

export function desiredEnrichmentJobHash(desired: DesiredEnrichmentJob): string {
  return createHash("sha256")
    .update(canonicalJson(scheduleProjection(desired)))
    .digest("hex");
}

function scheduleMatches(job: ScheduledEnrichmentJob, desired: DesiredEnrichmentJob): boolean {
  return (
    canonicalJson(actualScheduleProjection(job)) === canonicalJson(scheduleProjection(desired))
  );
}

function scheduleProjection(desired: DesiredEnrichmentJob): Record<string, unknown> {
  return {
    schedule: desired.schedule,
    concurrency: false,
    ...desiredPhysicalJobProjection(desired),
  };
}

function actualScheduleProjection(job: ScheduledEnrichmentJob): Record<string, unknown> {
  return {
    schedule: job.schedule,
    concurrency: job.concurrency,
    spaceId: job.jobSpec.spaceId ?? undefined,
    command: job.jobSpec.command ?? undefined,
    environment: job.jobSpec.environment ?? {},
    flavor: job.jobSpec.flavor,
    timeout: scheduleTimeout(job),
    retries: scheduleRetries(job),
    secrets: scheduleSecretNames(job),
    labels: job.jobSpec.labels ?? {},
  };
}

function scheduleTimeout(job: ScheduledEnrichmentJob): number | undefined {
  return job.jobSpec.timeout ?? job.jobSpec.timeoutSeconds ?? undefined;
}

function scheduleRetries(job: ScheduledEnrichmentJob): number | undefined {
  if (job.jobSpec.retry !== undefined && job.jobSpec.retry !== null) return job.jobSpec.retry;
  if (job.jobSpec.attempts === undefined || job.jobSpec.attempts === null) return undefined;
  return job.jobSpec.attempts - 1;
}

function scheduleSecretNames(job: ScheduledEnrichmentJob): readonly string[] {
  return job.jobSpec.secrets === undefined
    ? declaredSecretNames(job.jobSpec.labels)
    : [...job.jobSpec.secrets].sort();
}

function declaredSecretNames(
  labels: Readonly<Record<string, string>> | null | undefined,
): readonly string[] {
  const declared = labels?.["secret_names"];
  return declared === undefined ? [] : declared.split(".").sort();
}

async function suspendAndDeleteExtras(
  client: HubClient,
  namespace: string,
  schedules: readonly ScheduledEnrichmentJob[],
  keepId: string,
): Promise<void> {
  for (const schedule of schedules) {
    if (schedule.id === keepId) continue;
    if (!schedule.suspend) {
      await suspendScheduledJob({ namespace, jobId: schedule.id, ...hubOptions(client) });
    }
    await deleteScheduledJob({ namespace, jobId: schedule.id, ...hubOptions(client) });
  }
}

async function readDeploymentManifest(client: HubClient, spaceRepo: string) {
  const blob = await downloadFile({
    repo: { type: "space", name: spaceRepo },
    path: DEPLOYMENT_MANIFEST_PATH,
    ...hubOptions(client),
  });
  if (blob === null) {
    throw new Error(`${DEPLOYMENT_MANIFEST_PATH} is missing from ${spaceRepo}.`);
  }
  const candidate: unknown = JSON.parse(await blob.text());
  return deploymentManifestSchema.parse(candidate);
}

function physicalJobMatches(job: PhysicalEnrichmentJob, desired: DesiredEnrichmentJob): boolean {
  return (
    canonicalJson(actualPhysicalJobProjection(job)) ===
    canonicalJson(physicalJobProjection(desired))
  );
}

function physicalJobProjection(desired: DesiredEnrichmentJob): Record<string, unknown> {
  return desiredPhysicalJobProjection(desired);
}

function desiredPhysicalJobProjection(desired: DesiredEnrichmentJob): Record<string, unknown> {
  return {
    spaceId: desired.spaceRepo,
    command: [...JOB_COMMAND],
    environment: desired.environment,
    flavor: "cpu-basic",
    timeout: desired.timeoutSeconds,
    retries: 0,
    secrets: [...JOB_SECRET_NAMES].sort(),
    labels: desired.labels,
  };
}

function actualPhysicalJobProjection(job: PhysicalEnrichmentJob): Record<string, unknown> {
  return {
    spaceId: job.spaceId ?? undefined,
    command: job.command ?? undefined,
    environment: job.environment ?? {},
    flavor: job.flavor ?? undefined,
    timeout: physicalJobTimeout(job),
    retries: physicalJobRetries(job),
    secrets: physicalJobSecrets(job),
    labels: job.labels ?? {},
  };
}

function physicalJobTimeout(job: PhysicalEnrichmentJob): number | undefined {
  return job.timeout ?? job.timeoutSeconds ?? undefined;
}

function physicalJobRetries(job: PhysicalEnrichmentJob): number | undefined {
  if (job.retry !== undefined && job.retry !== null) return job.retry;
  if (job.attempts === undefined || job.attempts === null) return undefined;
  return job.attempts - 1;
}

function physicalJobSecrets(job: PhysicalEnrichmentJob): readonly string[] {
  return job.secrets === undefined ? declaredSecretNames(job.labels) : [...job.secrets].sort();
}

function ownsJob(
  labels: Readonly<Record<string, string>> | null | undefined,
  spaceRepo: string,
): boolean {
  return (
    labels?.["app"] === ENRICHMENT_JOB_LABELS.app &&
    labels["component"] === ENRICHMENT_JOB_LABELS.component &&
    labels["space_repo"] === jobSpaceRepoLabel(spaceRepo)
  );
}

function jobSpaceRepoLabel(spaceRepo: string): string {
  return createHash("sha256").update(spaceRepo).digest("base64url");
}

const CRON_ALIASES = new Set(["@annually", "@yearly", "@monthly", "@weekly", "@daily", "@hourly"]);
const CRON_BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function isSupportedCronSchedule(value: string): boolean {
  if (CRON_ALIASES.has(value)) return true;
  const fields = value.trim().split(/\s+/u);
  return (
    fields.length === CRON_BOUNDS.length &&
    fields.every((field, index) => {
      const bounds = CRON_BOUNDS[index];
      return bounds !== undefined && validCronField(field, bounds[0], bounds[1]);
    })
  );
}

function validCronField(field: string, minimum: number, maximum: number): boolean {
  return field.split(",").every((part) => validCronPart(part, minimum, maximum));
}

function validCronPart(part: string, minimum: number, maximum: number): boolean {
  const [base, step, extra] = part.split("/");
  if (base === undefined || extra !== undefined) return false;
  if (!validCronStep(step, maximum - minimum + 1)) return false;
  if (base === "*") return true;
  const [start, end, extraRange] = base.split("-");
  if (start === undefined || extraRange !== undefined) return false;
  if (end === undefined) return integerInRange(start, minimum, maximum);
  return validCronRange(start, end, minimum, maximum);
}

function validCronStep(step: string | undefined, maximum: number): boolean {
  return step === undefined || integerInRange(step, 1, maximum);
}

function validCronRange(start: string, end: string, minimum: number, maximum: number): boolean {
  return (
    integerInRange(start, minimum, maximum) &&
    integerInRange(end, minimum, maximum) &&
    Number(start) <= Number(end)
  );
}

function integerInRange(value: string, minimum: number, maximum: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum;
}

function finiteNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function hubOptions(client: HubClient): {
  accessToken: string;
  hubUrl?: string;
  fetch?: typeof fetch;
} {
  return {
    accessToken: client.accessToken,
    ...(client.hubUrl === undefined ? {} : { hubUrl: client.hubUrl }),
    ...(client.fetchFn === undefined ? {} : { fetch: client.fetchFn }),
  };
}
