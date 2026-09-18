import { createRawBucketClient } from "./bucket-log.js";
import type { BucketObject, RawBucketClient } from "./bucket-log.js";

const SOURCE_REVISION = /^[a-f0-9]{40}$/u;
const PHYSICAL_JOB_ID = /^[a-f0-9]{24}$/u;
const DEFAULT_SETTLE_MS = 15_000;
const DEFAULT_CONFIRMATION_MS = 2_000;
const CONTENDER_WINDOW_MS = 5 * 60_000;

export type EnrichmentJobAdmission = {
  admitted: true;
  jobId?: string;
};

type AdmissionClient = Pick<RawBucketClient, "list" | "upload">;

type AdmissionDependencies = {
  client?: AdmissionClient;
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
  const sourceRevision = validSourceRevision(required(env, "XTAP_SOURCE_REVISION"));
  const indexBucket = validBucket(required(env, "INDEX_BUCKET"));
  const physicalJobId = validPhysicalJobId(jobId);
  const client = dependencies.client ?? createRawBucketClient(indexBucket, accessToken);
  const sleep = dependencies.sleep ?? delay;
  const settleMs = boundedDelay(dependencies.settleMs ?? DEFAULT_SETTLE_MS, "settleMs");
  const confirmationMs = boundedDelay(
    dependencies.confirmationMs ?? DEFAULT_CONFIRMATION_MS,
    "confirmationMs",
  );
  const prefix = claimPrefix(sourceRevision);

  await client.upload(claimKey(prefix, physicalJobId), claimBytes(sourceRevision, physicalJobId));
  await sleep(settleMs);
  requireElectedWriter(await client.list(prefix), prefix, physicalJobId);
  await sleep(confirmationMs);
  requireElectedWriter(await client.list(prefix), prefix, physicalJobId);
  return { admitted: true, jobId: physicalJobId };
}

function requireElectedWriter(
  objects: readonly BucketObject[],
  prefix: string,
  jobId: string,
): void {
  const currentCreatedAt = physicalJobCreatedAt(jobId);
  const contenders = [
    ...new Set(
      objects
        .map((object) => jobIdFromClaimKey(object.key, prefix))
        .filter((candidate): candidate is string => candidate !== undefined)
        .filter(
          (candidate) =>
            Math.abs(physicalJobCreatedAt(candidate) - currentCreatedAt) <= CONTENDER_WINDOW_MS,
        ),
    ),
  ].sort();
  if (!contenders.includes(jobId)) {
    throw new Error(
      `single-writer admission could not verify enrichment Job ${jobId}; contenders: ${jobIds(contenders)}`,
    );
  }
  const elected = contenders[0];
  if (elected !== jobId) {
    throw new Error(
      `single-writer admission rejected enrichment Job ${jobId}; elected ${elected ?? "none"}; contenders: ${jobIds(contenders)}`,
    );
  }
}

function claimPrefix(sourceRevision: string): string {
  return `operations/enrichment/admission/${sourceRevision}/claims`;
}

function claimKey(prefix: string, jobId: string): string {
  return `${prefix}/${jobId}.json`;
}

function claimBytes(sourceRevision: string, jobId: string): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      schema_version: 1,
      job_id: jobId,
      source_revision: sourceRevision,
      created_at: new Date(physicalJobCreatedAt(jobId)).toISOString(),
    })}\n`,
  );
}

function jobIdFromClaimKey(key: string, prefix: string): string | undefined {
  const pathPrefix = `${prefix}/`;
  if (!key.startsWith(pathPrefix)) return undefined;
  const relative = key.slice(pathPrefix.length);
  const match = /^([a-f0-9]{24})\.json$/u.exec(relative);
  return match?.[1];
}

function physicalJobCreatedAt(jobId: string): number {
  return Number.parseInt(jobId.slice(0, 8), 16) * 1_000;
}

function validPhysicalJobId(value: string): string {
  if (!PHYSICAL_JOB_ID.test(value)) {
    throw new Error("JOB_ID must be a 24-character hexadecimal Hugging Face Job ID");
  }
  return value;
}

function validSourceRevision(value: string): string {
  if (!SOURCE_REVISION.test(value)) {
    throw new Error("XTAP_SOURCE_REVISION must be a 40-character lowercase Git revision");
  }
  return value;
}

function validBucket(value: string): string {
  const [namespace, name, extra] = value.split("/");
  if (
    namespace === undefined ||
    namespace.length === 0 ||
    name === undefined ||
    name.length === 0 ||
    extra !== undefined
  ) {
    throw new Error("INDEX_BUCKET must use owner/name form for enrichment Job admission");
  }
  return value;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for enrichment Job admission`);
  }
  return value;
}

function boundedDelay(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new Error(`${name} must be an integer from 0 to 60000`);
  }
  return value;
}

function jobIds(jobIds: readonly string[]): string {
  return jobIds.length === 0 ? "none" : jobIds.join(",");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
