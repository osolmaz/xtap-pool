import { beforeEach, describe, expect, it, vi } from "vitest";

const hubMocks = vi.hoisted(() => ({
  createScheduledJob: vi.fn(),
  deleteScheduledJob: vi.fn(),
  downloadFile: vi.fn(),
  getJob: vi.fn(),
  getScheduledJob: vi.fn(),
  listFiles: vi.fn(),
  listJobs: vi.fn(),
  listScheduledJobs: vi.fn(),
  resumeScheduledJob: vi.fn(),
  runScheduledJob: vi.fn(),
  suspendScheduledJob: vi.fn(),
}));

vi.mock("@huggingface/hub", () => hubMocks);

import {
  canaryHardCeilingUsd,
  desiredEnrichmentJob,
  desiredEnrichmentJobHash,
  inspectEnrichmentJob,
  reconcileEnrichmentJob,
  resumeEnrichmentSchedule,
  runEnrichmentCanary,
  suspendEnrichmentSchedule,
  suspendMismatchedEnrichmentSchedules,
  triggerEnrichmentJob,
} from "../src/enrichment-job.js";
import type { DesiredEnrichmentJob } from "../src/enrichment-job.js";

const REVISION = "a".repeat(40);
const client = { accessToken: "hf_owner", hubUrl: "https://hub.test" };

beforeEach(() => {
  vi.clearAllMocks();
  hubMocks.downloadFile.mockResolvedValue(
    new Blob([JSON.stringify({ source_revision: REVISION })]),
  );
  hubMocks.listFiles.mockReturnValue(asyncIterableOf([]));
  hubMocks.listJobs.mockResolvedValue([]);
  hubMocks.listScheduledJobs.mockResolvedValue([]);
  hubMocks.deleteScheduledJob.mockResolvedValue(undefined);
  hubMocks.suspendScheduledJob.mockResolvedValue(undefined);
  hubMocks.resumeScheduledJob.mockResolvedValue(undefined);
});

describe("Hugging Face enrichment Job", () => {
  it("derives one bounded revision-bound Job contract", async () => {
    const desired = await desiredFixture();

    expect(desired).toMatchObject({
      namespace: "alice",
      spaceRepo: "alice/xtap-pool",
      sourceRevision: REVISION,
      schedule: "17 */6 * * *",
      timeoutSeconds: 2700,
      environment: {
        DATASET_REPO: "alice/xtap-pool-data",
        ENRICH_ENABLED: "true",
        ENRICH_MAX_COST_USD: "2",
        LLM_MODEL: "zai-org/GLM-5.2:fireworks-ai",
        XTAP_SOURCE_REVISION: REVISION,
      },
      labels: {
        app: "xtap-pool",
        component: "enrichment",
        space_repo: "j2EoX9oQdUwRyuhnS-n4HnjY0ks_n-QXcB1evBGoqgE",
        source_revision: REVISION,
        secret_names: "HF_TOKEN.INFERENCE_TOKEN",
      },
    });
    expect(desiredEnrichmentJobHash(desired)).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.values(desired.labels).every((value) => /^[a-zA-Z0-9._-]*$/u.test(value))).toBe(
      true,
    );
  });

  it("rejects a missing deployment manifest and invalid Space namespace", async () => {
    hubMocks.downloadFile.mockResolvedValueOnce(null);
    await expect(desiredFixture()).rejects.toThrow("is missing");

    await expect(
      desiredEnrichmentJob({ accessToken: "hf_owner" }, "", "alice/xtap-pool-data", variables()),
    ).rejects.toThrow("Invalid Space repository");
  });

  it("rejects missing or malformed bounded configuration", async () => {
    const missing = variables();
    missing.delete("ENRICH_MAX_COST_USD");
    await expect(
      desiredEnrichmentJob(client, "alice/xtap-pool", "alice/xtap-pool-data", missing),
    ).rejects.toThrow();

    const invalid = variables();
    invalid.set("ENRICH_MAX_ERROR_RATE", "2");
    await expect(
      desiredEnrichmentJob(client, "alice/xtap-pool", "alice/xtap-pool-data", invalid),
    ).rejects.toThrow();

    invalid.set("ENRICH_MAX_ERROR_RATE", "0.25");
    invalid.set("ENRICH_JOB_SCHEDULE", "every few minutes");
    await expect(
      desiredEnrichmentJob(client, "alice/xtap-pool", "alice/xtap-pool-data", invalid),
    ).rejects.toThrow("five-field cron");

    invalid.set("ENRICH_JOB_SCHEDULE", "17 */6 * * *");
    invalid.set("ENRICH_MAX_CONCURRENT_CALLS", "33");
    await expect(
      desiredEnrichmentJob(client, "alice/xtap-pool", "alice/xtap-pool-data", invalid),
    ).rejects.toThrow("1 through 32");
  });

  it("classifies exact, stale, unrelated, and active Jobs", async () => {
    const desired = await desiredFixture();
    const exact = scheduleFixture(desired, "exact");
    const stale = scheduleFixture(
      {
        ...desired,
        sourceRevision: "b".repeat(40),
        environment: { ...desired.environment, XTAP_SOURCE_REVISION: "b".repeat(40) },
        labels: { ...desired.labels, source_revision: "b".repeat(40) },
      },
      "stale",
    );
    const unrelated = {
      ...exact,
      id: "unrelated",
      jobSpec: { ...exact.jobSpec, labels: { app: "other" } },
    };
    hubMocks.listScheduledJobs.mockResolvedValue([exact, stale, unrelated]);
    hubMocks.listJobs.mockResolvedValue([
      physicalFixture(desired, "active", "RUNNING"),
      physicalFixture(desired, "done", "STOPPED"),
    ]);

    const inspection = await inspectEnrichmentJob(client, desired);

    expect(inspection.schedules.map(({ id }) => id)).toEqual(["exact", "stale"]);
    expect(inspection.exactSchedules.map(({ id }) => id)).toEqual(["exact"]);
    expect(inspection.mismatchedSchedules.map(({ id }) => id)).toEqual(["stale"]);
    expect(inspection.activeJobs.map(({ id }) => id)).toEqual(["active"]);

    hubMocks.listScheduledJobs.mockResolvedValue([
      {
        id: "sparse",
        schedule: desired.schedule,
        suspend: true,
        concurrency: false,
        jobSpec: {
          spaceId: null,
          command: null,
          environment: null,
          flavor: "cpu-basic",
          timeout: null,
          labels: desired.labels,
        },
      },
    ]);
    const sparse = await inspectEnrichmentJob(client, desired);
    expect(sparse.exactSchedules).toEqual([]);
    expect(sparse.mismatchedSchedules.map(({ id }) => id)).toEqual(["sparse"]);

    const sdkTimeout = {
      ...exact,
      id: "sdk-timeout",
      jobSpec: {
        spaceId: exact.jobSpec.spaceId,
        command: exact.jobSpec.command,
        environment: exact.jobSpec.environment,
        flavor: exact.jobSpec.flavor,
        timeoutSeconds: desired.timeoutSeconds,
        retry: 0,
        labels: exact.jobSpec.labels,
      },
    };
    hubMocks.listScheduledJobs.mockResolvedValue([sdkTimeout]);
    const compatible = await inspectEnrichmentJob(client, desired);
    expect(compatible.exactSchedules.map(({ id }) => id)).toEqual(["sdk-timeout"]);
  });

  it("rejects schedules with missing secrets or automatic retries", async () => {
    const desired = await desiredFixture();
    const exact = scheduleFixture(desired, "exact");
    const missingSecret = {
      ...exact,
      id: "missing-secret",
      jobSpec: { ...exact.jobSpec, secrets: ["HF_TOKEN"] },
    };
    const retrying = {
      ...exact,
      id: "retrying",
      jobSpec: { ...exact.jobSpec, retry: 1 },
    };
    hubMocks.listScheduledJobs.mockResolvedValue([missingSecret, retrying]);

    const inspection = await inspectEnrichmentJob(client, desired);

    expect(inspection.exactSchedules).toEqual([]);
    expect(inspection.mismatchedSchedules.map(({ id }) => id)).toEqual([
      "missing-secret",
      "retrying",
    ]);
  });

  it("creates and verifies a suspended non-concurrent replacement before deleting old schedules", async () => {
    const desired = await desiredFixture();
    const old = scheduleFixture({ ...desired, schedule: "0 0 * * *" }, "old", false);
    const created = scheduleFixture(desired, "created", true);
    hubMocks.listScheduledJobs.mockResolvedValueOnce([old]).mockResolvedValueOnce([old]);
    hubMocks.createScheduledJob.mockResolvedValue(created);
    hubMocks.getScheduledJob.mockResolvedValue(created);

    await expect(
      reconcileEnrichmentJob(client, desired, {
        datasetToken: "hf_dataset",
        inferenceToken: "hf_inference",
      }),
    ).resolves.toMatchObject({ id: "created", suspend: true, concurrency: false });

    expect(hubMocks.suspendScheduledJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "old" }),
    );
    expect(hubMocks.createScheduledJob).toHaveBeenCalledWith(
      expect.objectContaining({
        suspend: true,
        concurrency: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest's asymmetric matcher is intentionally assigned inside the expected object.
        jobSpec: expect.objectContaining({
          spaceId: "alice/xtap-pool",
          command: ["node", "space/dist/src/enrich-job-main.js"],
          secrets: { HF_TOKEN: "hf_dataset", INFERENCE_TOKEN: "hf_inference" },
          flavor: "cpu-basic",
          timeoutSeconds: 2700,
        }),
      }),
    );
    expect(hubMocks.deleteScheduledJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "old" }),
    );
    expect(hubMocks.createScheduledJob.mock.invocationCallOrder[0]).toBeLessThan(
      hubMocks.deleteScheduledJob.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("keeps one exact schedule and removes only suspended extras without token values", async () => {
    const desired = await desiredFixture();
    const exact = scheduleFixture(desired, "exact", true);
    const stale = scheduleFixture({ ...desired, schedule: "0 0 * * *" }, "stale", false);
    hubMocks.listScheduledJobs.mockResolvedValue([exact, stale]);

    await expect(reconcileEnrichmentJob(client, desired)).resolves.toMatchObject({ id: "exact" });

    expect(hubMocks.createScheduledJob).not.toHaveBeenCalled();
    expect(hubMocks.deleteScheduledJob).toHaveBeenCalledTimes(1);
    expect(hubMocks.deleteScheduledJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "stale" }),
    );
  });

  it("refuses replacement, trigger, and resume while a matching Job is active", async () => {
    const desired = await desiredFixture();
    hubMocks.listJobs.mockResolvedValue([physicalFixture(desired, "active", "RUNNING")]);

    await expect(
      reconcileEnrichmentJob(client, desired, {
        datasetToken: "hf_dataset",
        inferenceToken: "hf_inference",
      }),
    ).rejects.toThrow("active");
    await expect(triggerEnrichmentJob(client, desired, "schedule")).rejects.toThrow("active");
    await expect(resumeEnrichmentSchedule(client, desired, "schedule")).rejects.toThrow("active");
    expect(hubMocks.createScheduledJob).not.toHaveBeenCalled();
    expect(hubMocks.runScheduledJob).not.toHaveBeenCalled();
    expect(hubMocks.resumeScheduledJob).not.toHaveBeenCalled();
  });

  it("runs two bounded physical Jobs and verifies their durable continuation receipts", async () => {
    const desired = await desiredFixture();
    const exact = scheduleFixture(desired, "exact", true);
    hubMocks.listScheduledJobs.mockResolvedValue([exact]);
    hubMocks.runScheduledJob
      .mockResolvedValueOnce(physicalFixture(desired, "job-1", "RUNNING"))
      .mockResolvedValueOnce(physicalFixture(desired, "job-2", "RUNNING"));
    hubMocks.getJob
      .mockResolvedValueOnce(physicalFixture(desired, "job-1", "COMPLETED"))
      .mockResolvedValueOnce(physicalFixture(desired, "job-2", "STOPPED"));
    hubMocks.listFiles.mockReturnValue(
      asyncIterableOf([{ type: "file", path: "enrichment/receipts/2026-07-28.jsonl" }]),
    );
    hubMocks.downloadFile.mockImplementation((options: { path?: string }) =>
      Promise.resolve(
        options.path === ".xtap-deployment.json"
          ? new Blob([JSON.stringify({ source_revision: REVISION })])
          : new Blob([
              `\nnot-json\n{}\n${JSON.stringify(receiptFixture("other-job"))}\n${JSON.stringify(receiptFixture("job-1"))}\n${JSON.stringify({ ...receiptFixture("job-2"), units: 0, calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 })}\n`,
            ]),
      ),
    );

    const result = await runEnrichmentCanary(client, desired, "alice/xtap-pool-data", {
      pollIntervalMs: 0,
      receiptTimeoutMs: 100,
    });

    expect(result.hardCeilingUsd).toBeCloseTo(4.0165);
    expect(result.runs.map(({ jobId }) => jobId)).toEqual(["job-1", "job-2"]);
    expect(result.runs.map(({ receipt }) => receipt.units)).toEqual([7, 0]);
  });

  it("resumes a bounded canary from a matching completed Job and launches only its continuation", async () => {
    const desired = await desiredFixture();
    const exact = scheduleFixture(desired, "exact", true);
    hubMocks.listScheduledJobs.mockResolvedValue([exact]);
    hubMocks.runScheduledJob.mockResolvedValue(physicalFixture(desired, "job-2", "RUNNING"));
    hubMocks.getJob
      .mockResolvedValueOnce({
        ...physicalFixture(desired, "job-1", "COMPLETED"),
        secrets: undefined,
      })
      .mockResolvedValueOnce(physicalFixture(desired, "job-2", "COMPLETED"));
    hubMocks.listFiles.mockReturnValue(
      asyncIterableOf([{ type: "file", path: "enrichment/receipts/2026-07-28.jsonl" }]),
    );
    hubMocks.downloadFile.mockImplementation((options: { path?: string }) =>
      Promise.resolve(
        options.path === ".xtap-deployment.json"
          ? new Blob([JSON.stringify({ source_revision: REVISION })])
          : new Blob([
              [receiptFixture("job-1"), receiptFixture("job-2")]
                .map((receipt) => JSON.stringify(receipt))
                .join("\n"),
            ]),
      ),
    );

    const result = await runEnrichmentCanary(client, desired, "alice/xtap-pool-data", {
      resumeJobId: "job-1",
      pollIntervalMs: 0,
      receiptTimeoutMs: 100,
    });

    expect(result.runs.map(({ jobId }) => jobId)).toEqual(["job-1", "job-2"]);
    expect(hubMocks.runScheduledJob).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe canary continuation Jobs", async () => {
    const desired = await desiredFixture();
    hubMocks.listScheduledJobs.mockResolvedValue([scheduleFixture(desired, "exact", true)]);
    hubMocks.getJob.mockResolvedValue({
      ...physicalFixture(desired, "job-1", "COMPLETED"),
      environment: { ...desired.environment, ENRICH_MAX_UNITS_PER_TICK: "25" },
    });

    await expect(
      runEnrichmentCanary(client, desired, "alice/xtap-pool-data", {
        resumeJobId: "job-1",
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("different contract");
  });

  it("requires secrets for a missing schedule and rejects a replacement race", async () => {
    const desired = await desiredFixture();
    await expect(reconcileEnrichmentJob(client, desired)).rejects.toThrow(
      "token values are required",
    );

    const stale = scheduleFixture({ ...desired, schedule: "0 0 * * *" }, "stale", false);
    hubMocks.listScheduledJobs.mockResolvedValue([stale]);
    hubMocks.listJobs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([physicalFixture(desired, "racing", "RUNNING")]);
    await expect(
      reconcileEnrichmentJob(client, desired, {
        datasetToken: "hf_dataset",
        inferenceToken: "hf_inference",
      }),
    ).rejects.toThrow("became active");
    expect(hubMocks.createScheduledJob).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable schedule returned by Hugging Face", async () => {
    const desired = await desiredFixture();
    const created = scheduleFixture(desired, "created", true);
    const wrong = scheduleFixture({ ...desired, schedule: "0 0 * * *" }, "created", true);
    hubMocks.createScheduledJob.mockResolvedValue(created);
    hubMocks.getScheduledJob.mockResolvedValue(wrong);

    await expect(
      reconcileEnrichmentJob(client, desired, {
        datasetToken: "hf_dataset",
        inferenceToken: "hf_inference",
      }),
    ).rejects.toThrow("does not match");
  });

  it("fails closed when Hugging Face refuses a manual trigger", async () => {
    const desired = await desiredFixture();
    hubMocks.runScheduledJob.mockResolvedValue(null);

    await expect(triggerEnrichmentJob(client, desired, "schedule")).rejects.toThrow(
      "refused the trigger",
    );
  });

  it("rejects unsafe canary schedule and cost states", async () => {
    const desired = await desiredFixture();
    await expect(runEnrichmentCanary(client, desired, "alice/xtap-pool-data")).rejects.toThrow(
      "one exact",
    );

    const activeSchedule = scheduleFixture(desired, "active-schedule", false);
    hubMocks.listScheduledJobs.mockResolvedValue([activeSchedule]);
    await expect(runEnrichmentCanary(client, desired, "alice/xtap-pool-data")).rejects.toThrow(
      "suspended",
    );

    const expensive = {
      ...desired,
      environment: { ...desired.environment, ENRICH_MAX_COST_USD: "3" },
    };
    hubMocks.listScheduledJobs.mockResolvedValue([scheduleFixture(expensive, "expensive", true)]);
    await expect(runEnrichmentCanary(client, expensive, "alice/xtap-pool-data")).rejects.toThrow(
      "requires explicit paid-run approval",
    );

    expect(() =>
      canaryHardCeilingUsd({
        ...desired,
        environment: { ...desired.environment, ENRICH_MAX_COST_USD: "unknown" },
      }),
    ).toThrow("measurable positive");
  });

  it("rejects failed physical Jobs and absent durable receipts", async () => {
    const desired = await desiredFixture();
    const exact = scheduleFixture(desired, "exact", true);
    hubMocks.listScheduledJobs.mockResolvedValue([exact]);
    hubMocks.runScheduledJob.mockResolvedValue(physicalFixture(desired, "failed", "RUNNING"));
    hubMocks.getJob.mockResolvedValue(physicalFixture(desired, "failed", "ERROR"));

    await expect(
      runEnrichmentCanary(client, desired, "alice/xtap-pool-data", {
        pollIntervalMs: 0,
        receiptTimeoutMs: 0,
      }),
    ).rejects.toThrow("ended in ERROR");

    hubMocks.runScheduledJob.mockResolvedValue(physicalFixture(desired, "deleted", "RUNNING"));
    hubMocks.getJob.mockResolvedValue(physicalFixture(desired, "deleted", "DELETING"));
    await expect(
      runEnrichmentCanary(client, desired, "alice/xtap-pool-data", {
        pollIntervalMs: 0,
        receiptTimeoutMs: 0,
      }),
    ).rejects.toThrow("ended in DELETING");

    hubMocks.runScheduledJob.mockResolvedValue(physicalFixture(desired, "missing", "RUNNING"));
    hubMocks.getJob.mockResolvedValue(physicalFixture(desired, "missing", "STOPPED"));
    hubMocks.listFiles.mockReturnValue(asyncIterableOf([]));
    await expect(
      runEnrichmentCanary(client, desired, "alice/xtap-pool-data", {
        pollIntervalMs: 0,
        receiptTimeoutMs: 0,
      }),
    ).rejects.toThrow("No durable enrichment receipt");

    hubMocks.runScheduledJob.mockResolvedValue(physicalFixture(desired, "gone", "RUNNING"));
    hubMocks.getJob.mockResolvedValue(physicalFixture(desired, "gone", "STOPPED"));
    hubMocks.listFiles.mockReturnValue(
      asyncIterableOf([{ type: "file", path: "enrichment/receipts/gone.jsonl" }]),
    );
    hubMocks.downloadFile.mockResolvedValue(null);
    await expect(
      runEnrichmentCanary(client, desired, "alice/xtap-pool-data", {
        pollIntervalMs: 0,
        receiptTimeoutMs: 100,
      }),
    ).rejects.toThrow("Receipt shard disappeared");
  });

  it.each([
    ["missing cost", { cost_usd: undefined }, "cost"],
    ["too many tokens", { prompt_tokens: 400001 }, "token"],
  ])("rejects a canary receipt with %s", async (_name, override, message) => {
    const desired = await desiredFixture();
    const exact = scheduleFixture(desired, "exact", true);
    hubMocks.listScheduledJobs.mockResolvedValue([exact]);
    hubMocks.runScheduledJob.mockResolvedValue(physicalFixture(desired, "job-1", "RUNNING"));
    hubMocks.getJob.mockResolvedValue(physicalFixture(desired, "job-1", "STOPPED"));
    hubMocks.listFiles.mockReturnValue(
      asyncIterableOf([{ type: "file", path: "enrichment/receipts/receipt.jsonl" }]),
    );
    hubMocks.downloadFile.mockResolvedValue(
      new Blob([`${JSON.stringify({ ...receiptFixture("job-1"), ...override })}\n`]),
    );

    await expect(
      runEnrichmentCanary(client, desired, "alice/xtap-pool-data", {
        pollIntervalMs: 0,
        receiptTimeoutMs: 100,
      }),
    ).rejects.toThrow(message);
  });

  it("rejects reused physical identities and changed contracts across attempts", async () => {
    const desired = await desiredFixture();
    const exact = scheduleFixture(desired, "exact", true);
    hubMocks.listScheduledJobs.mockResolvedValue([exact]);
    hubMocks.runScheduledJob.mockResolvedValue(physicalFixture(desired, "same", "RUNNING"));
    hubMocks.getJob.mockResolvedValue(physicalFixture(desired, "same", "STOPPED"));
    hubMocks.listFiles.mockReturnValue(
      asyncIterableOf([{ type: "file", path: "enrichment/receipts/receipt.jsonl" }]),
    );
    hubMocks.downloadFile.mockResolvedValue(
      new Blob([`${JSON.stringify(receiptFixture("same"))}\n`]),
    );
    await expect(
      runEnrichmentCanary(client, desired, "alice/xtap-pool-data", {
        pollIntervalMs: 0,
        receiptTimeoutMs: 100,
      }),
    ).rejects.toThrow("reused a physical Job ID");

    hubMocks.runScheduledJob
      .mockReset()
      .mockResolvedValueOnce(physicalFixture(desired, "job-1", "RUNNING"))
      .mockResolvedValueOnce(physicalFixture(desired, "job-2", "RUNNING"));
    hubMocks.getJob
      .mockReset()
      .mockResolvedValueOnce(physicalFixture(desired, "job-1", "STOPPED"))
      .mockResolvedValueOnce(physicalFixture(desired, "job-2", "STOPPED"));
    hubMocks.downloadFile.mockResolvedValue(
      new Blob([
        `${JSON.stringify(receiptFixture("job-1"))}\n${JSON.stringify({ ...receiptFixture("job-2"), contract_hash: "changed" })}\n`,
      ]),
    );
    await expect(
      runEnrichmentCanary(client, desired, "alice/xtap-pool-data", {
        pollIntervalMs: 0,
        receiptTimeoutMs: 100,
      }),
    ).rejects.toThrow("different enrichment contracts");
  });

  it("suspends only stale owned schedules and triggers a suspended exact schedule", async () => {
    const desired = await desiredFixture();
    const exact = scheduleFixture(desired, "exact", true);
    const stale = scheduleFixture({ ...desired, schedule: "0 0 * * *" }, "stale", false);
    const alreadySuspended = scheduleFixture(
      { ...desired, schedule: "30 0 * * *" },
      "already-suspended",
      true,
    );
    hubMocks.listScheduledJobs.mockResolvedValue([exact, stale, alreadySuspended]);
    hubMocks.runScheduledJob.mockResolvedValue(physicalFixture(desired, "job", "RUNNING"));

    await expect(suspendMismatchedEnrichmentSchedules(client, desired)).resolves.toBe(1);
    expect(hubMocks.suspendScheduledJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "stale" }),
    );

    hubMocks.listScheduledJobs.mockResolvedValue([exact]);
    await expect(triggerEnrichmentJob(client, desired, "exact")).resolves.toMatchObject({
      id: "job",
    });
    expect(hubMocks.runScheduledJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "exact" }),
    );

    await suspendEnrichmentSchedule(client, desired, "exact");
    await resumeEnrichmentSchedule(client, desired, "exact");
    expect(hubMocks.suspendScheduledJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "exact" }),
    );
    expect(hubMocks.resumeScheduledJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "exact" }),
    );
  });
});

function asyncIterableOf(entries: readonly unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () =>
          Promise.resolve(
            index < entries.length
              ? { value: entries[index++], done: false }
              : { value: undefined, done: true },
          ),
      };
    },
  };
}

function receiptFixture(workerId: string): Record<string, unknown> {
  return {
    started_at: "2026-07-28T00:00:00.000Z",
    finished_at: "2026-07-28T00:01:00.000Z",
    units: 7,
    calls: 2,
    prompt_tokens: 1000,
    completion_tokens: 100,
    cost_usd: 0.00184,
    failures: 0,
    retries: 0,
    blocked: 0,
    contract_hash: "contract",
    worker_id: workerId,
    discarded_assignments: 0,
    new_candidates: 0,
    new_approvals: 0,
    new_rejections: 0,
  };
}

async function desiredFixture(): Promise<DesiredEnrichmentJob> {
  return desiredEnrichmentJob(client, "alice/xtap-pool", "alice/xtap-pool-data", variables());
}

function variables(): Map<string, string> {
  return new Map([
    ["ENRICH_JOB_SCHEDULE", "17 */6 * * *"],
    ["ENRICH_JOB_TIMEOUT_SECONDS", "2700"],
    ["ENRICH_MAX_UNITS_PER_TICK", "50"],
    ["ENRICH_MAX_CONCURRENT_CALLS", "1"],
    ["ENRICH_MAX_TOKENS", "400000"],
    ["ENRICH_MAX_ELAPSED_MS", "2400000"],
    ["ENRICH_MAX_ERROR_RATE", "0.25"],
    ["ENRICH_MAX_COST_USD", "2"],
    ["ENRICH_MAX_COST_PER_CALL_USD", "0.25"],
    ["ENRICH_INPUT_TOKEN_USD", "0.0000014"],
    ["ENRICH_OUTPUT_TOKEN_USD", "0.0000044"],
    ["ENRICH_MAX_DISCARDED_ASSIGNMENTS", "100"],
    ["LLM_MODEL", "zai-org/GLM-5.2:fireworks-ai"],
    ["TAXONOMY_VERSION", "1"],
  ]);
}

function scheduleFixture(
  desired: DesiredEnrichmentJob,
  id: string,
  suspend = true,
): {
  id: string;
  schedule: string;
  suspend: boolean;
  concurrency: boolean;
  jobSpec: {
    spaceId: string;
    command: string[];
    environment: Readonly<Record<string, string>>;
    flavor: string;
    timeout: number;
    retry: number;
    secrets: string[];
    labels: Readonly<Record<string, string>>;
  };
} {
  return {
    id,
    schedule: desired.schedule,
    suspend,
    concurrency: false,
    jobSpec: {
      spaceId: desired.spaceRepo,
      command: ["node", "space/dist/src/enrich-job-main.js"],
      environment: desired.environment,
      flavor: "cpu-basic",
      timeout: desired.timeoutSeconds,
      retry: 0,
      secrets: ["HF_TOKEN", "INFERENCE_TOKEN"],
      labels: desired.labels,
    },
  };
}

function physicalFixture(
  desired: DesiredEnrichmentJob,
  id: string,
  stage: string,
): Record<string, unknown> {
  return {
    id,
    status: { stage },
    spaceId: desired.spaceRepo,
    command: ["node", "space/dist/src/enrich-job-main.js"],
    environment: desired.environment,
    flavor: "cpu-basic",
    timeout: desired.timeoutSeconds,
    retry: 0,
    secrets: ["HF_TOKEN", "INFERENCE_TOKEN"],
    labels: desired.labels,
  };
}
