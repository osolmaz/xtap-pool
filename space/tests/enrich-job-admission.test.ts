import { describe, expect, it, vi } from "vitest";

import { admitSingleEnrichmentJob } from "../src/enrich-job-admission.js";

const SOURCE_REVISION = "a".repeat(40);
const ENV = {
  HF_TOKEN: "test-token",
  INDEX_BUCKET: "owner/index",
  JOB_ID: "job-1",
  XTAP_SOURCE_REVISION: SOURCE_REVISION,
} as const;

function job(
  id: string,
  options: {
    stage?: string;
    sourceRevision?: string;
    component?: string;
    spaceRepo?: string;
  } = {},
) {
  return {
    id,
    status: { stage: options.stage ?? "RUNNING" },
    labels: {
      app: "xtap-pool",
      component: options.component ?? "enrichment",
      source_revision: options.sourceRevision ?? SOURCE_REVISION,
      space_repo: options.spaceRepo ?? "space-one",
    },
  };
}

describe("enrichment Job admission", () => {
  it("skips remote admission for a local command", async () => {
    const listJobs = vi.fn();

    await expect(
      admitSingleEnrichmentJob(
        {
          HF_TOKEN: "test-token",
          INDEX_BUCKET: "owner/index",
          XTAP_SOURCE_REVISION: SOURCE_REVISION,
        },
        { listJobs },
      ),
    ).resolves.toEqual({ admitted: true });
    expect(listJobs).not.toHaveBeenCalled();
  });

  it("admits one stable matching physical Job", async () => {
    const listJobs = vi.fn().mockResolvedValue([job("job-1")]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      admitSingleEnrichmentJob(ENV, { listJobs, sleep, settleMs: 0, confirmationMs: 0 }),
    ).resolves.toEqual({ admitted: true, jobId: "job-1" });
    expect(listJobs).toHaveBeenCalledTimes(2);
    expect(listJobs).toHaveBeenCalledWith("owner", "test-token");
    expect(sleep).toHaveBeenNthCalledWith(1, 0);
    expect(sleep).toHaveBeenNthCalledWith(2, 0);
  });

  it("fails closed before work when the schedule starts duplicate Jobs", async () => {
    const listJobs = vi.fn().mockResolvedValue([job("job-1"), job("job-2")]);

    await expect(
      admitSingleEnrichmentJob(ENV, {
        listJobs,
        sleep: () => Promise.resolve(),
        settleMs: 0,
        confirmationMs: 0,
      }),
    ).rejects.toThrow(
      "single-writer admission rejected enrichment Job job-1; active matching Jobs: job-1,job-2",
    );
    expect(listJobs).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a duplicate appears during confirmation", async () => {
    const listJobs = vi
      .fn()
      .mockResolvedValueOnce([job("job-1")])
      .mockResolvedValueOnce([job("job-1"), job("job-2")]);

    await expect(
      admitSingleEnrichmentJob(ENV, {
        listJobs,
        sleep: () => Promise.resolve(),
        settleMs: 0,
        confirmationMs: 0,
      }),
    ).rejects.toThrow(
      "single-writer admission rejected enrichment Job job-1; active matching Jobs: job-1,job-2",
    );
    expect(listJobs).toHaveBeenCalledTimes(2);
  });

  it("requires the current physical Job to be the sole matching writer", async () => {
    const listJobs = vi.fn().mockResolvedValue([job("job-2")]);

    await expect(
      admitSingleEnrichmentJob(ENV, {
        listJobs,
        sleep: () => Promise.resolve(),
        settleMs: 0,
        confirmationMs: 0,
      }),
    ).rejects.toThrow(
      "single-writer admission could not verify enrichment Job job-1; active owned Jobs: job-2",
    );
  });

  it("rejects another active writer for the same Space at another revision", async () => {
    const listJobs = vi
      .fn()
      .mockResolvedValue([job("job-1"), job("old-source", { sourceRevision: "b".repeat(40) })]);

    await expect(
      admitSingleEnrichmentJob(ENV, {
        listJobs,
        sleep: () => Promise.resolve(),
        settleMs: 0,
        confirmationMs: 0,
      }),
    ).rejects.toThrow(
      "single-writer admission rejected enrichment Job job-1; active matching Jobs: job-1,old-source",
    );
  });

  it("ignores terminal and unrelated Jobs", async () => {
    const listJobs = vi
      .fn()
      .mockResolvedValue([
        job("job-1"),
        job("terminal", { stage: "COMPLETED" }),
        job("other-space", { sourceRevision: "b".repeat(40), spaceRepo: "space-two" }),
        job("other-component", { component: "publication" }),
      ]);

    await expect(
      admitSingleEnrichmentJob(ENV, {
        listJobs,
        sleep: () => Promise.resolve(),
        settleMs: 0,
        confirmationMs: 0,
      }),
    ).resolves.toEqual({ admitted: true, jobId: "job-1" });
  });

  it("rejects missing or inconsistent production admission inputs", async () => {
    await expect(
      admitSingleEnrichmentJob({ ...ENV, HF_TOKEN: undefined }, { settleMs: 0 }),
    ).rejects.toThrow("HF_TOKEN is required for enrichment Job admission");
    await expect(
      admitSingleEnrichmentJob({ ...ENV, INDEX_BUCKET: "invalid" }, { settleMs: 0 }),
    ).rejects.toThrow("INDEX_BUCKET must use owner/name form");

    const listJobs = vi.fn().mockResolvedValue([job("job-1", { sourceRevision: "b".repeat(40) })]);
    await expect(
      admitSingleEnrichmentJob(ENV, {
        listJobs,
        sleep: () => Promise.resolve(),
        settleMs: 0,
      }),
    ).rejects.toThrow("single-writer admission could not verify enrichment Job job-1");
  });
});
