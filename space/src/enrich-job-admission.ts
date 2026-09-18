import { listJobs } from "@huggingface/hub";
import { z } from "zod";

const ACTIVE_JOB_STAGES = new Set(["PAUSED", "RUNNING", "SCHEDULING", "UPDATING"]);
const ENRICHMENT_LABELS = {
  app: "xtap-pool",
  component: "enrichment",
} as const;
const DEFAULT_SETTLE_MS = 15_000;
const DEFAULT_CONFIRMATION_MS = 2_000;

const physicalJobSchema = z
  .object({
    id: z.string().min(1),
    status: z.object({ stage: z.string().min(1) }).loose(),
    labels: z.record(z.string(), z.string()).nullish(),
  })
  .loose();

export type EnrichmentJobAdmission = {
  admitted: true;
  jobId?: string;
};

type AdmissionDependencies = {
  listJobs?: (namespace: string, accessToken: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  settleMs?: number;
  confirmationMs?: number;
};

export async function admitSingleEnrichmentJob(
  env: Readonly<Record<string, string | undefined>>,
  dependencies: AdmissionDependencies = {},
): Promise<EnrichmentJobAdmission> {
  const jobId = env["JOB_ID"];
  if (jobId === undefined) return { admitted: true };

  const accessToken = required(env, "HF_TOKEN");
  const sourceRevision = required(env, "XTAP_SOURCE_REVISION");
  const namespace = bucketNamespace(required(env, "INDEX_BUCKET"));
  const readJobs =
    dependencies.listJobs ??
    ((owner: string, token: string) => listJobs({ namespace: owner, accessToken: token }));
  const sleep = dependencies.sleep ?? delay;
  const settleMs = boundedDelay(dependencies.settleMs ?? DEFAULT_SETTLE_MS, "settleMs");
  const confirmationMs = boundedDelay(
    dependencies.confirmationMs ?? DEFAULT_CONFIRMATION_MS,
    "confirmationMs",
  );

  await sleep(settleMs);
  requireOnlyOwnedActiveJob(await readJobs(namespace, accessToken), jobId, sourceRevision);
  await sleep(confirmationMs);
  requireOnlyOwnedActiveJob(await readJobs(namespace, accessToken), jobId, sourceRevision);
  return { admitted: true, jobId };
}

type PhysicalJob = z.infer<typeof physicalJobSchema>;

function requireOnlyOwnedActiveJob(payload: unknown, jobId: string, sourceRevision: string): void {
  const activeJobs = z.array(physicalJobSchema).parse(payload).filter(isActiveEnrichmentJob);
  const spaceRepo = verifiedCurrentSpaceRepo(activeJobs, jobId, sourceRevision);
  const matching = activeJobs.filter((job) => job.labels?.["space_repo"] === spaceRepo);
  if (matching.length !== 1 || matching[0]?.id !== jobId) {
    throw new Error(
      `single-writer admission rejected enrichment Job ${jobId}; active matching Jobs: ${jobIds(matching)}`,
    );
  }
}

function isActiveEnrichmentJob(job: PhysicalJob): boolean {
  return (
    ACTIVE_JOB_STAGES.has(job.status.stage) &&
    job.labels?.["app"] === ENRICHMENT_LABELS.app &&
    job.labels["component"] === ENRICHMENT_LABELS.component
  );
}

function verifiedCurrentSpaceRepo(
  activeJobs: PhysicalJob[],
  jobId: string,
  sourceRevision: string,
): string {
  const current = activeJobs.find((job) => job.id === jobId);
  const spaceRepo = current?.labels?.["space_repo"];
  if (current?.labels?.["source_revision"] !== sourceRevision || spaceRepo === undefined) {
    throw new Error(
      `single-writer admission could not verify enrichment Job ${jobId}; active owned Jobs: ${jobIds(activeJobs)}`,
    );
  }
  return spaceRepo;
}

function jobIds(jobs: PhysicalJob[]): string {
  const ids = jobs.map((job) => job.id).sort();
  return ids.length === 0 ? "none" : ids.join(",");
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for enrichment Job admission`);
  }
  return value;
}

function bucketNamespace(bucket: string): string {
  const [namespace, name, extra] = bucket.split("/");
  if (
    namespace === undefined ||
    namespace.length === 0 ||
    name === undefined ||
    name.length === 0 ||
    extra !== undefined
  ) {
    throw new Error("INDEX_BUCKET must use owner/name form for enrichment Job admission");
  }
  return namespace;
}

function boundedDelay(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new Error(`${name} must be an integer from 0 to 60000`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
