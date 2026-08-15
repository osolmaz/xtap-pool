import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { beforeEach, describe, expect, it, vi } from "vitest";

const hubMocks = vi.hoisted(() => ({
  createScheduledJob: vi.fn(),
  deleteScheduledJob: vi.fn(),
  downloadFile: vi.fn(),
  getScheduledJob: vi.fn(),
  listFiles: vi.fn(),
  listJobs: vi.fn(),
  listScheduledJobs: vi.fn(),
  resumeScheduledJob: vi.fn(),
  runScheduledJob: vi.fn(),
  suspendScheduledJob: vi.fn(),
  HUB_URL: "https://hub.test",
}));

vi.mock("@huggingface/hub", () => hubMocks);

import { collectDoctorReport, runDoctor } from "../src/doctor.js";
import type { DesiredEnrichmentJob, ScheduledEnrichmentJob } from "../src/enrichment-job.js";

function asyncIterableOf(entries: { type: string; path: string }[]): AsyncIterable<unknown> {
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

beforeEach(() => {
  vi.clearAllMocks();
  mockDownloads(`${JSON.stringify(sampleTweet())}\n`);
  hubMocks.listJobs.mockResolvedValue([]);
  hubMocks.listScheduledJobs.mockResolvedValue([scheduledJobFixture()]);
});

describe("doctor", () => {
  it("flags a live Space that indexed zero tweets while the storage has files", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const report = await collectDoctorReport(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn: fetchFixture({ tweets: 0 }) },
      "alice",
      "alice/xtap-pool",
      { fetchFn: fetchFixture({ tweets: 0 }) },
    );

    expect(report.rawBucket).toBe("alice/xtap-pool-data");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "live.indexed_storage", status: "fail" }),
    );
  });

  it("reports malformed storage data without offering a token repair", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    mockDownloads("not json\n{}\n");
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({ tweets: 0, secretWrites });
    const promptStorageToken = vi.fn<() => Promise<string>>();

    const report = await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        promptStorageToken,
        confirmStorageTokenRepair: () => Promise.resolve(true),
        promptInferenceToken: () => Promise.resolve("hf_inference"),
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: () => Promise.resolve(),
      },
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "storage.segments", status: "fail" }),
    );
    expect(report.checks).not.toContainEqual(
      expect.objectContaining({ code: "live.indexed_storage" }),
    );
    expect(promptStorageToken).not.toHaveBeenCalled();
    expect(secretWrites).toEqual([]);
  });

  it("passes the live indexing check when health reports tweets", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const report = await collectDoctorReport(
      {
        accessToken: "hf_owner",
        hubUrl: "https://hub.test",
        fetchFn: fetchFixture({ tweets: 12 }),
      },
      "alice",
      "alice/xtap-pool",
      { fetchFn: fetchFixture({ tweets: 12 }) },
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "live.indexed_storage", status: "pass" }),
    );
  });

  it("treats a missing data tree as an empty readable storage", async () => {
    hubMocks.listFiles
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      })
      .mockReturnValueOnce(asyncIterableOf([{ type: "file", path: ".gitattributes" }]));
    const report = await collectDoctorReport(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn: fetchFixture({ tweets: 0 }) },
      "alice",
      "alice/xtap-pool",
      { fetchFn: fetchFixture({ tweets: 0 }) },
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        code: "storage.segments",
        status: "warn",
        details: { count: 0, records: 0, tweets: 0 },
      }),
    );
  });

  it("does not require live tweets when raw storage has only non-tweet records", async () => {
    mockDownloads("{}\n", "enrichment/receipts/2026-08-12.jsonl");
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const report = await collectDoctorReport(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn: fetchFixture({ tweets: 0 }) },
      "alice",
      "alice/xtap-pool",
      { fetchFn: fetchFixture({ tweets: 0 }) },
    );

    expect(report.checks).not.toContainEqual(
      expect.objectContaining({ code: "live.indexed_storage" }),
    );
  });

  it("fails a public storage because pooled data must stay private", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const report = await collectDoctorReport(
      {
        accessToken: "hf_owner",
        hubUrl: "https://hub.test",
        fetchFn: fetchFixture({ tweets: 12, storagePrivate: false }),
      },
      "alice",
      "alice/xtap-pool",
      { fetchFn: fetchFixture({ tweets: 12, storagePrivate: false }) },
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "storage.visibility", status: "fail" }),
    );
  });

  it("fails invalid ENRICH_ENABLED values while deriving the manifest", async () => {
    const fetchFn = fetchFixture({ tweets: 0, variables: { ENRICH_ENABLED: "yes" } });
    const report = await collectDoctorReport(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      "alice/xtap-pool",
      { fetchFn },
    );

    expect(report.rawBucket).toBeUndefined();
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        code: "pool.manifest",
        status: "fail",
        message: "ENRICH_ENABLED must be 'true' or 'false', got 'yes'.",
      }),
    );
  });

  it("repairs malformed bounded enrichment variables to safe defaults", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const variableWrites: { key: string; value: string }[] = [];
    const fixtureOptions = {
      tweets: 12,
      variables: {
        ENRICH_JOB_SCHEDULE: "every few minutes",
        ENRICH_MAX_COST_USD: "0",
        ENRICH_MAX_ERROR_RATE: "2",
      },
      variableWrites,
    };
    const fetchFn = fetchFixture(fixtureOptions);

    const report = await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      { fetchFn },
    );

    expect(variableWrites).toEqual([
      { key: "ENRICH_JOB_SCHEDULE", value: "17 */6 * * *" },
      { key: "ENRICH_MAX_ERROR_RATE", value: "0.25" },
      { key: "ENRICH_MAX_COST_USD", value: "10" },
    ]);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "space.variable.ENRICH_JOB_SCHEDULE", status: "pass" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "space.variable.ENRICH_MAX_COST_USD", status: "pass" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "space.variable.ENRICH_MAX_ERROR_RATE", status: "pass" }),
    );
  });

  it("reports a cost limit that cannot admit the configured reservation wave", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const fetchFn = fetchFixture({
      tweets: 12,
      variables: { ENRICH_MAX_COST_USD: "2" },
    });

    const report = await collectDoctorReport(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      "alice/xtap-pool",
      { fetchFn },
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        code: "job.reservation_capacity",
        status: "fail",
        message:
          "ENRICH_MAX_COST_USD must be at least 8 to admit the configured concurrent call wave.",
      }),
    );
  });

  it("repairs a newly defaulted concurrency and its reservation capacity together", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const variableWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({
      tweets: 12,
      variables: {
        ENRICH_MAX_CONCURRENT_CALLS: "",
        ENRICH_MAX_COST_USD: "2",
      },
      variableWrites,
    });

    const report = await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      { fetchFn },
    );

    expect(variableWrites).toEqual([
      { key: "ENRICH_MAX_CONCURRENT_CALLS", value: "32" },
      { key: "ENRICH_MAX_COST_USD", value: "10" },
    ]);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "job.reservation_capacity", status: "pass" }),
    );
  });

  it("preserves a deliberate compatible concurrency and cost pair", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const variableWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({
      tweets: 12,
      variables: {
        ENRICH_MAX_CONCURRENT_CALLS: "1",
        ENRICH_MAX_COST_USD: "2",
      },
      variableWrites,
    });
    const inspectJob = (_client: unknown, desired: DesiredEnrichmentJob) => {
      const schedule = scheduledJobFixture();
      return Promise.resolve({
        desired,
        schedules: [schedule],
        exactSchedules: [schedule],
        mismatchedSchedules: [],
        activeJobs: [],
      });
    };

    const report = await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      { fetchFn, inspectJob },
    );

    expect(variableWrites).toEqual([]);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "job.reservation_capacity", status: "pass" }),
    );
  });

  it("fails required runtime variables that are present but empty", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const report = await collectDoctorReport(
      {
        accessToken: "hf_owner",
        hubUrl: "https://hub.test",
        fetchFn: fetchFixture({
          tweets: 12,
          variables: { ALLOWED_USERS: "", POOL_ADMINS: "" },
        }),
      },
      "alice",
      "alice/xtap-pool",
      {
        fetchFn: fetchFixture({
          tweets: 12,
          variables: { ALLOWED_USERS: "", POOL_ADMINS: "" },
        }),
      },
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "space.variable.ALLOWED_USERS", status: "fail" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "space.variable.POOL_ADMINS", status: "fail" }),
    );
  });

  it("fails malformed bootstrap username variables", async () => {
    const fetchFn = fetchFixture({
      tweets: 0,
      variables: { ALLOWED_USERS: "not a username", POOL_ADMINS: "also bad" },
    });
    const report = await collectDoctorReport(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      "alice/xtap-pool",
      { fetchFn },
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "space.variable.ALLOWED_USERS", status: "fail" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "space.variable.POOL_ADMINS", status: "fail" }),
    );
  });

  it("fails live readiness without misclassifying storage state as a token failure", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const fetchFn = fetchFixture({
      tweets: 1,
      storageCredential: "ok",
      storageState: "invalid",
      storageStateError: "enrichment/vocabulary.json is malformed",
      inferenceCredential: "ok",
    });
    const report = await collectDoctorReport(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      "alice/xtap-pool",
      { fetchFn },
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "live.readiness", status: "fail" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "live.storage", status: "pass" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "live.storage_state", status: "fail" }),
    );
  });

  it("reports unresolved live readiness without assuming missing diagnostic text", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const fetchFn = fetchFixture({
      tweets: "pending",
      storageCredential: "unknown",
      storageState: "unknown",
      inferenceCredential: "unknown",
      inferenceState: "unknown",
    });

    const report = await collectDoctorReport(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      "alice/xtap-pool",
      { fetchFn },
    );

    for (const code of [
      "live.healthz",
      "live.storage",
      "live.storage_state",
      "live.enrichment",
      "live.enrichment_state",
    ]) {
      expect(report.checks).toContainEqual(expect.objectContaining({ code, status: "warn" }));
    }
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "live.readiness", status: "fail" }),
    );

    const diagnosticFetch = fetchFixture({
      tweets: "pending",
      storageCredential: "unknown",
      storageError: "storage credential check pending",
      storageState: "unknown",
      storageStateError: "storage rebuild pending",
      inferenceCredential: "unknown",
      inferenceError: "inference credential check pending",
      inferenceState: "unknown",
      inferenceStateError: "taxonomy reload pending",
    });
    const diagnosticReport = await collectDoctorReport(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn: diagnosticFetch },
      "alice",
      "alice/xtap-pool",
      { fetchFn: diagnosticFetch },
    );
    expect(
      diagnosticReport.checks.find((check) => check.code === "live.readiness")?.message,
    ).toContain("storage rebuild pending");
    expect(
      diagnosticReport.checks.find((check) => check.code === "live.storage")?.message,
    ).toContain("storage credential check pending");
    expect(
      diagnosticReport.checks.find((check) => check.code === "live.enrichment")?.message,
    ).toContain("inference credential check pending");
  });

  it("repairs missing role secrets with validated replacement tokens", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({ tweets: 0, secretWrites, omitSecrets: true });
    const restarts: string[] = [];

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        ...jobCredentialRepairDeps(),
        promptStorageToken: () => Promise.resolve("hf_storage"),
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: (spaceRepo) => {
          restarts.push(spaceRepo);
          return Promise.resolve();
        },
      },
    );

    expect(secretWrites).toEqual([{ key: "HF_TOKEN", value: "hf_storage" }]);
    expect(restarts).toEqual(["alice/xtap-pool"]);
  });

  it("re-prompts invalid replacement tokens without discarding completed repair input", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({ tweets: 0, secretWrites, omitSecrets: true });
    const promptStorageToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("hf_bad_storage")
      .mockResolvedValueOnce("hf_good_storage");
    const promptInferenceToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("hf_bad_inference")
      .mockResolvedValueOnce("hf_good_inference");

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        ...jobCredentialRepairDeps("hf_good_storage", "hf_good_inference"),
        promptStorageToken,
        promptInferenceToken,
        validateStorageToken: (token) =>
          Promise.resolve(token === "hf_good_storage" ? [] : ["storage token rejected"]),
        validateInferenceToken: (token) =>
          Promise.resolve(token === "hf_good_inference" ? [] : ["inference token rejected"]),
        restartAndWait: () => Promise.resolve(),
      },
    );

    expect(promptStorageToken).toHaveBeenCalledTimes(2);
    expect(promptInferenceToken).not.toHaveBeenCalled();
    expect(secretWrites).toEqual([{ key: "HF_TOKEN", value: "hf_good_storage" }]);
  });

  it("repairs an existing storage token reported invalid by the live Space", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({
      tweets: 1,
      secretWrites,
      storageCredential: "invalid",
      storageError:
        "HF_TOKEN must include repo.content.write or repo.write on alice/xtap-pool-data.",
    });
    const promptJobStorageToken = vi.fn().mockResolvedValue("hf_job_storage");
    const promptJobInferenceToken = vi.fn().mockResolvedValue("hf_job_inference");
    const reconcileJob = vi.fn().mockResolvedValue(undefined);
    const restarts: string[] = [];

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        promptStorageToken: () => Promise.resolve("hf_storage"),
        promptJobStorageToken,
        promptJobInferenceToken,
        reconcileJob,
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: (spaceRepo) => {
          restarts.push(spaceRepo);
          return Promise.resolve();
        },
      },
    );

    expect(promptJobStorageToken).toHaveBeenCalledWith("alice/xtap-pool-data");
    expect(promptJobInferenceToken).toHaveBeenCalledTimes(1);
    expect(reconcileJob).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "hf_owner" }),
      expect.objectContaining({ spaceRepo: "alice/xtap-pool" }),
      { storageToken: "hf_job_storage", inferenceToken: "hf_job_inference" },
    );
    expect(secretWrites).toEqual([{ key: "HF_TOKEN", value: "hf_storage" }]);
    expect(restarts).toEqual(["alice/xtap-pool"]);
  });

  it("does not repair the unused Space inference token", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({
      tweets: 1,
      secretWrites,
      inferenceCredential: "invalid",
      inferenceError: "INFERENCE_TOKEN must include inference.serverless.write.",
    });
    const promptStorageToken = vi.fn<() => Promise<string>>();
    const restarts: string[] = [];

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        promptStorageToken,
        promptInferenceToken: () => Promise.resolve("hf_inference"),
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: (spaceRepo) => {
          restarts.push(spaceRepo);
          return Promise.resolve();
        },
      },
    );

    expect(promptStorageToken).not.toHaveBeenCalled();
    expect(secretWrites).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("repairs missing generated secrets after explicit confirmation", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({
      tweets: 0,
      secretWrites,
      omitGeneratedSecrets: true,
      healthStatus: 503,
    });
    const promptStorageToken = vi.fn<() => Promise<string>>();
    const restarts: string[] = [];

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        promptStorageToken,
        confirmGeneratedSecretRepair: () => Promise.resolve(true),
        promptInferenceToken: () => Promise.resolve("hf_inference"),
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: (spaceRepo) => {
          restarts.push(spaceRepo);
          return Promise.resolve();
        },
      },
    );

    expect(promptStorageToken).not.toHaveBeenCalled();
    expect(secretWrites.map((write) => write.key).sort()).toEqual([
      "POOL_SIGNING_SECRET",
      "SESSION_SECRET",
    ]);
    expect(secretWrites.every((write) => /^[0-9a-f]{64}$/.test(write.value))).toBe(true);
    expect(restarts).toEqual(["alice/xtap-pool"]);
  });

  it("rotates the existing generated secret when another is missing and health is unavailable", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({
      tweets: 0,
      secretWrites,
      generatedSecrets: ["SESSION_SECRET"],
      healthStatus: 503,
    });

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        confirmGeneratedSecretRepair: () => Promise.resolve(true),
        promptInferenceToken: () => Promise.resolve("hf_inference"),
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: () => Promise.resolve(),
      },
    );

    expect(secretWrites.map((write) => write.key).sort()).toEqual([
      "POOL_SIGNING_SECRET",
      "SESSION_SECRET",
    ]);
  });

  it("offers generated-secret repair for possibly malformed existing generated secrets", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({ tweets: 0, secretWrites, healthStatus: 503 });
    const promptStorageToken = vi.fn<() => Promise<string>>();
    const restarts: string[] = [];

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        promptStorageToken,
        confirmGeneratedSecretRepair: () => Promise.resolve(true),
        confirmStorageTokenRepair: () => Promise.resolve(true),
        promptInferenceToken: () => Promise.resolve("hf_inference"),
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: (spaceRepo) => {
          restarts.push(spaceRepo);
          return Promise.resolve();
        },
      },
    );

    expect(promptStorageToken).not.toHaveBeenCalled();
    expect(secretWrites.map((write) => write.key).sort()).toEqual([
      "POOL_SIGNING_SECRET",
      "SESSION_SECRET",
    ]);
    expect(restarts).toEqual(["alice/xtap-pool"]);
  });

  it("offers storage token repair when live health is unavailable", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({ tweets: 0, secretWrites, healthStatus: 503 });
    const restarts: string[] = [];

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        ...jobCredentialRepairDeps(),
        promptStorageToken: () => Promise.resolve("hf_storage"),
        confirmGeneratedSecretRepair: () => Promise.resolve(false),
        confirmStorageTokenRepair: () => Promise.resolve(true),
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: (spaceRepo) => {
          restarts.push(spaceRepo);
          return Promise.resolve();
        },
      },
    );

    expect(secretWrites).toEqual([{ key: "HF_TOKEN", value: "hf_storage" }]);
    expect(restarts).toEqual(["alice/xtap-pool"]);
  });

  it("does not replace the storage token when indeterminate health repair is declined", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({ tweets: 0, secretWrites, healthStatus: 503 });
    const promptStorageToken = vi.fn<() => Promise<string>>();
    const restarts: string[] = [];

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        promptStorageToken,
        confirmGeneratedSecretRepair: () => Promise.resolve(false),
        confirmStorageTokenRepair: () => Promise.resolve(false),
        promptInferenceToken: () => Promise.resolve("hf_inference"),
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: (spaceRepo) => {
          restarts.push(spaceRepo);
          return Promise.resolve();
        },
      },
    );

    expect(promptStorageToken).not.toHaveBeenCalled();
    expect(secretWrites).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("does not replace the storage token for zero indexed tweets when repair is declined", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({ tweets: 0, secretWrites });
    const promptStorageToken = vi.fn<() => Promise<string>>();
    const restarts: string[] = [];

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        promptStorageToken,
        confirmStorageTokenRepair: () => Promise.resolve(false),
        promptInferenceToken: () => Promise.resolve("hf_inference"),
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: (spaceRepo) => {
          restarts.push(spaceRepo);
          return Promise.resolve();
        },
      },
    );

    expect(promptStorageToken).not.toHaveBeenCalled();
    expect(secretWrites).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("offers storage token repair for an empty pool when live health is unavailable", async () => {
    hubMocks.listFiles
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      })
      .mockReturnValueOnce(asyncIterableOf([{ type: "file", path: ".gitattributes" }]))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      })
      .mockReturnValueOnce(asyncIterableOf([{ type: "file", path: ".gitattributes" }]));
    const secretWrites: { key: string; value: string }[] = [];
    const fetchFn = fetchFixture({ tweets: 0, secretWrites, healthStatus: 503 });
    const restarts: string[] = [];

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        ...jobCredentialRepairDeps(),
        promptStorageToken: () => Promise.resolve("hf_storage"),
        confirmGeneratedSecretRepair: () => Promise.resolve(false),
        confirmStorageTokenRepair: () => Promise.resolve(true),
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
        restartAndWait: (spaceRepo) => {
          restarts.push(spaceRepo);
          return Promise.resolve();
        },
      },
    );

    expect(secretWrites).toEqual([{ key: "HF_TOKEN", value: "hf_storage" }]);
    expect(restarts).toEqual(["alice/xtap-pool"]);
  });

  it("creates a missing suspended Job schedule from separately validated hidden inputs", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const fetchFn = fetchFixture({ tweets: 12 });
    const reconcileJob = vi.fn().mockResolvedValue(undefined);
    const promptJobStorageToken = vi.fn().mockResolvedValue("hf_job_storage");
    const promptJobInferenceToken = vi.fn().mockResolvedValue("hf_job_inference");

    await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      { spaceRepo: "alice/xtap-pool", json: true, fix: true },
      {
        fetchFn,
        inspectJob: (_client, desired) =>
          Promise.resolve({
            desired,
            schedules: [],
            exactSchedules: [],
            mismatchedSchedules: [],
            activeJobs: [],
          }),
        reconcileJob,
        promptJobStorageToken,
        promptJobInferenceToken,
        validateStorageToken: () => Promise.resolve([]),
        validateInferenceToken: () => Promise.resolve([]),
      },
    );

    expect(promptJobStorageToken).toHaveBeenCalledWith("alice/xtap-pool-data");
    expect(promptJobInferenceToken).toHaveBeenCalledTimes(1);
    expect(reconcileJob).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "hf_owner" }),
      expect.objectContaining({ spaceRepo: "alice/xtap-pool" }),
      { storageToken: "hf_job_storage", inferenceToken: "hf_job_inference" },
    );
  });

  it("runs the two-Job canary and activates only after explicit recurring-cost approval", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const fetchFn = fetchFixture({ tweets: 12 });
    let resumed = false;
    const resumeJobSchedule = vi.fn().mockImplementation(() => {
      resumed = true;
      return Promise.resolve();
    });
    const inspectJob = (_client: unknown, desired: DesiredEnrichmentJob) => {
      const schedule = { ...scheduledJobFixture(), suspend: !resumed };
      return Promise.resolve({
        desired,
        schedules: [schedule],
        exactSchedules: [schedule],
        mismatchedSchedules: [],
        activeJobs: [],
      });
    };
    const runJobCanary = vi.fn().mockResolvedValue({
      hardCeilingUsd: 4.0165,
      runs: [
        { jobId: "job-1", receipt: receiptFixture("job-1") },
        { jobId: "job-2", receipt: receiptFixture("job-2") },
      ],
    });

    const report = await runDoctor(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      "alice",
      {
        spaceRepo: "alice/xtap-pool",
        json: true,
        fix: false,
        canary: true,
        resumeCanaryJobId: "job-1",
        approvedCostCeilingUsd: 500,
        enableSchedule: true,
      },
      {
        fetchFn,
        inspectJob,
        runJobCanary,
        confirmScheduleEnable: () => Promise.resolve(true),
        resumeJobSchedule,
      },
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "job.canary", status: "pass" }),
    );
    expect(runJobCanary).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "hf_owner" }),
      expect.objectContaining({ spaceRepo: "alice/xtap-pool" }),
      "alice/xtap-pool-data",
      { resumeJobId: "job-1", approvedCostCeilingUsd: 500 },
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "job.schedule.approval", status: "pass" }),
    );
    expect(resumeJobSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "hf_owner" }),
      expect.objectContaining({ spaceRepo: "alice/xtap-pool" }),
      "schedule-1",
    );
  });

  it("refuses to report activation until Hugging Face confirms the schedule is active", async () => {
    hubMocks.listFiles.mockReturnValue(rawSegmentEntries());
    const fetchFn = fetchFixture({ tweets: 12 });
    const inspectJob = (_client: unknown, desired: DesiredEnrichmentJob) => {
      const schedule = scheduledJobFixture();
      return Promise.resolve({
        desired,
        schedules: [schedule],
        exactSchedules: [schedule],
        mismatchedSchedules: [],
        activeJobs: [],
      });
    };

    await expect(
      runDoctor(
        { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
        "alice",
        {
          spaceRepo: "alice/xtap-pool",
          json: true,
          fix: false,
          canary: true,
          enableSchedule: true,
        },
        {
          fetchFn,
          inspectJob,
          runJobCanary: () =>
            Promise.resolve({
              hardCeilingUsd: 4.0165,
              runs: [
                { jobId: "job-1", receipt: receiptFixture("job-1") },
                { jobId: "job-2", receipt: receiptFixture("job-2") },
              ],
            }),
          confirmScheduleEnable: () => Promise.resolve(true),
          resumeJobSchedule: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow("did not confirm");
  });
});

const SOURCE_REVISION = "a".repeat(40);
let rawSegmentPath = "";
let rawSegmentBlob = new Blob([]);

function mockDownloads(
  storageContent: string,
  sourcePath = "data/alice/2026/07/tweets-2026-07-26.jsonl",
): void {
  const lines = storageContent.trimEnd().split("\n");
  const raw = Buffer.from(
    `${JSON.stringify({
      schema_version: 1,
      transaction_id: "11111111-1111-4111-8111-111111111111",
      created_at: "2026-07-26T12:00:00.000Z",
      operations: [{ path: sourcePath, mode: "append", lines }],
    })}\n`,
  );
  const digest = createHash("sha256").update(raw).digest("hex");
  rawSegmentPath = `v1/segments/tweet/2026/07/26/1785067200000-11111111-1111-4111-8111-111111111111-${digest}.json.gz`;
  rawSegmentBlob = new Blob([gzipSync(raw)]);
  hubMocks.downloadFile.mockImplementation(
    (options: { repo?: { type?: string; name?: string }; path?: string }) => {
      if (options.repo?.type === "space") {
        return Promise.resolve(new Blob([JSON.stringify({ source_revision: SOURCE_REVISION })]));
      }
      if (options.repo?.name === "alice/xtap-pool-bucket") {
        return Promise.resolve(new Blob(["{}"]));
      }
      return Promise.resolve(options.path === rawSegmentPath ? rawSegmentBlob : null);
    },
  );
}

function rawSegmentEntries(): AsyncIterable<unknown> {
  return asyncIterableOf([{ type: "file", path: rawSegmentPath }]);
}

function scheduledJobFixture(): ScheduledEnrichmentJob {
  return {
    id: "schedule-1",
    schedule: "17 */6 * * *",
    suspend: true,
    concurrency: false,
    jobSpec: {
      spaceId: "alice/xtap-pool",
      command: ["node", "space/dist/src/enrich-job-main.js"],
      environment: jobEnvironment(),
      flavor: "cpu-upgrade",
      timeout: 2700,
      retry: 0,
      secrets: ["HF_TOKEN", "INFERENCE_TOKEN"],
      labels: {
        app: "xtap-pool",
        component: "enrichment",
        name: "xtap-pool-enrichment",
        space_repo: "j2EoX9oQdUwRyuhnS-n4HnjY0ks_n-QXcB1evBGoqgE",
        source_revision: SOURCE_REVISION,
        secret_names: "HF_TOKEN.INFERENCE_TOKEN",
      },
    },
  };
}

function jobEnvironment(): Record<string, string> {
  return {
    DATA_DIR: "/tmp/xtap-pool-enrichment",
    RAW_BUCKET: "alice/xtap-pool-data",
    INDEX_BUCKET: "alice/xtap-pool-bucket",
    ENRICH_ENABLED: "true",
    ENRICH_MAX_CONCURRENT_CALLS: "32",
    ENRICH_MAX_ELAPSED_MS: "2400000",
    ENRICH_MAX_ERROR_RATE: "0.25",
    ENRICH_MAX_COST_USD: "10",
    ENRICH_MAX_COST_PER_CALL_USD: "0.25",
    ENRICH_INPUT_TOKEN_USD: "0.0000014",
    ENRICH_OUTPUT_TOKEN_USD: "0.0000044",
    ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT: "0.15",
    ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS: "200",
    LLM_MODEL: "zai-org/GLM-5.2:fireworks-ai",
    TAXONOMY_VERSION: "1",
    XTAP_SOURCE_REVISION: SOURCE_REVISION,
    POOL_SIGNING_SECRET: "job-not-used-0000000000000000000000000",
    SESSION_SECRET: "job-not-used-00000000000000000000000000",
    ALLOWED_USERS: "worker",
    POOL_ADMINS: "worker",
    OAUTH_CLIENT_ID: "job-not-used",
    OAUTH_CLIENT_SECRET: "job-not-used",
    SPACE_HOST: "worker.invalid",
  };
}

function receiptFixture(workerId: string) {
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

function sampleTweet(): Record<string, unknown> {
  return {
    id: "1",
    url: "https://x.com/alice/status/1",
    text: "hello",
    captured_at: "2026-07-26T12:00:00Z",
    author: { username: "alice" },
  };
}

function fetchFixture(options: {
  tweets: unknown;
  secretWrites?: { key: string; value: string }[];
  variableWrites?: { key: string; value: string }[];
  omitSecrets?: boolean;
  omitGeneratedSecrets?: boolean;
  generatedSecrets?: readonly ("POOL_SIGNING_SECRET" | "SESSION_SECRET")[];
  healthStatus?: number;
  storagePrivate?: boolean;
  indexBucketPrivate?: boolean;
  indexManifestStatus?: number;
  variables?: Record<string, string>;
  storageCredential?: "ok" | "invalid" | "unknown";
  storageError?: string;
  storageState?: "ready" | "invalid" | "unknown";
  storageStateError?: string;
  inferenceCredential?: "ok" | "invalid" | "missing" | "unknown";
  inferenceError?: string;
  inferenceState?: "ready" | "invalid" | "unknown";
  inferenceStateError?: string;
}): typeof fetch {
  return (input, init) => routeFixtureRequest(requestUrl(input), init, options);
}

type FixtureOptions = Parameters<typeof fetchFixture>[0];

function routeFixtureRequest(
  url: string,
  init: RequestInit | undefined,
  options: FixtureOptions,
): Promise<Response> {
  if (url.endsWith("/variables")) {
    if (init?.method === "POST") {
      const write = jsonBody(init);
      options.variableWrites?.push(write);
      options.variables = { ...options.variables, [write.key]: write.value };
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(variablesResponse(options.variables));
  }
  if (url.endsWith("/secrets")) return handleSecretsRequest(init, options);
  return handleReadRequest(url, options);
}

function handleSecretsRequest(
  init: RequestInit | undefined,
  options: {
    secretWrites?: { key: string; value: string }[];
    omitSecrets?: boolean;
    omitGeneratedSecrets?: boolean;
    generatedSecrets?: readonly ("POOL_SIGNING_SECRET" | "SESSION_SECRET")[];
  },
): Promise<Response> {
  if (init?.method === "POST") {
    options.secretWrites?.push(jsonBody(init));
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  return Promise.resolve(secretsResponse(options));
}

function handleReadRequest(url: string, options: FixtureOptions): Promise<Response> {
  if (url.includes("/api/buckets/alice/xtap-pool-data")) {
    return Promise.resolve(Response.json({ private: options.storagePrivate ?? true }));
  }
  if (url.includes("/api/buckets/alice/xtap-pool-bucket")) {
    return Promise.resolve(Response.json({ private: options.indexBucketPrivate ?? true }));
  }
  if (url === "https://alice-xtap-pool.hf.space/healthz") {
    return Promise.resolve(
      Response.json(healthPayload(options), { status: options.healthStatus ?? 200 }),
    );
  }
  return Promise.resolve(new Response("unexpected", { status: 500 }));
}

function healthPayload(options: FixtureOptions): Record<string, unknown> {
  if (options.inferenceCredential === undefined && options.storageCredential === undefined) {
    return { ok: true, tweets: options.tweets };
  }
  return {
    ok: true,
    tweets: options.tweets,
    readiness: {
      ok: fixtureReadinessOk(options),
      storage: fixtureStorageReadiness(options),
      enrichment: fixtureEnrichmentReadiness(options),
    },
  };
}

function fixtureStorageReadiness(options: FixtureOptions): Record<string, unknown> | undefined {
  if (options.storageCredential === undefined) return undefined;
  return {
    indexed_files: 1,
    indexed_tweets: options.tweets,
    enrichment_rows: 0,
    credential: options.storageCredential,
    credential_error: options.storageError,
    state: options.storageState ?? "ready",
    error: options.storageStateError,
  };
}

function fixtureEnrichmentReadiness(options: FixtureOptions): Record<string, unknown> | undefined {
  if (options.inferenceCredential === undefined) return undefined;
  return {
    enabled: true,
    model: "zai-org/GLM-5.2",
    credential: options.inferenceCredential,
    credential_error: options.inferenceError,
    state: options.inferenceState ?? "ready",
    error: options.inferenceStateError,
  };
}

function fixtureReadinessOk(options: FixtureOptions): boolean {
  return (
    credentialReady(options.storageCredential) &&
    componentReady(options.storageState) &&
    credentialReady(options.inferenceCredential) &&
    componentReady(options.inferenceState)
  );
}

function credentialReady(value: string | undefined): boolean {
  return value === undefined || value === "ok";
}

function componentReady(value: string | undefined): boolean {
  return value === undefined || value === "ready";
}

function variablesResponse(overrides: Record<string, string> | undefined): Response {
  const values = {
    RAW_BUCKET: "alice/xtap-pool-data",
    INDEX_BUCKET: "alice/xtap-pool-bucket",
    ALLOWED_USERS: "alice",
    POOL_ADMINS: "alice",
    ENRICH_ENABLED: "false",
    ENRICH_JOB_SCHEDULE: "17 */6 * * *",
    ENRICH_JOB_TIMEOUT_SECONDS: "2700",
    ENRICH_MAX_CONCURRENT_CALLS: "32",
    ENRICH_MAX_ELAPSED_MS: "2400000",
    ENRICH_MAX_ERROR_RATE: "0.25",
    ENRICH_MAX_COST_USD: "10",
    ENRICH_MAX_COST_PER_CALL_USD: "0.25",
    ENRICH_INPUT_TOKEN_USD: "0.0000014",
    ENRICH_OUTPUT_TOKEN_USD: "0.0000044",
    ENRICH_MAX_DISCARDED_ASSIGNMENTS_PER_UNIT: "0.15",
    ENRICH_DISCARDED_ASSIGNMENT_RATE_MIN_UNITS: "200",
    LLM_MODEL: "zai-org/GLM-5.2:fireworks-ai",
    TAXONOMY_VERSION: "1",
    ...overrides,
  };
  return Response.json(
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
  );
}

function secretsResponse(options: {
  omitSecrets?: boolean;
  omitGeneratedSecrets?: boolean;
  generatedSecrets?: readonly ("POOL_SIGNING_SECRET" | "SESSION_SECRET")[];
}): Response {
  if (options.omitSecrets) {
    return Response.json([{ key: "POOL_SIGNING_SECRET" }, { key: "SESSION_SECRET" }]);
  }
  const secrets = [
    { key: "HF_TOKEN" },
    { key: "INFERENCE_TOKEN" },
    ...(
      options.generatedSecrets ??
      (options.omitGeneratedSecrets ? [] : ["POOL_SIGNING_SECRET", "SESSION_SECRET"])
    ).map((key) => ({ key })),
  ];
  return Response.json(secrets);
}

function jobCredentialRepairDeps(
  storageToken = "hf_job_storage",
  inferenceToken = "hf_job_inference",
) {
  return {
    promptJobStorageToken: () => Promise.resolve(storageToken),
    promptJobInferenceToken: () => Promise.resolve(inferenceToken),
    reconcileJob: () => Promise.resolve(undefined),
  };
}

function jsonBody(init: RequestInit): { key: string; value: string } {
  if (typeof init.body !== "string") throw new Error("expected string body");
  return JSON.parse(init.body) as { key: string; value: string };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
