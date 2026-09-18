import { describe, expect, it, vi } from "vitest";

import type { BucketObject } from "../src/bucket-log.js";
import { admitSingleEnrichmentJob } from "../src/enrich-job-admission.js";

const SOURCE_REVISION = "a".repeat(40);
const LEADER_JOB_ID = "6aad07e852d0dbd7f1d695e1";
const FOLLOWER_JOB_ID = "6aad07ea52d0dbd7f1d695e2";
const CLAIM_PREFIX = `operations/enrichment/admission/${SOURCE_REVISION}/claims`;
const ENV = {
  HF_TOKEN: "test-token",
  INDEX_BUCKET: "owner/index",
  JOB_ID: LEADER_JOB_ID,
  XTAP_SOURCE_REVISION: SOURCE_REVISION,
} as const;

function claim(jobId: string, prefix = CLAIM_PREFIX): BucketObject {
  return {
    key: `${prefix}/${jobId}.json`,
    oid: jobId,
    size: 1,
  };
}

function clientWithListings(...listings: readonly BucketObject[][]) {
  const upload = vi.fn<(key: string, content: Uint8Array) => Promise<void>>();
  upload.mockResolvedValue(undefined);
  const list = vi.fn<(prefix: string) => Promise<readonly BucketObject[]>>();
  list.mockImplementation(() => {
    const next = listings[Math.min(list.mock.calls.length - 1, listings.length - 1)];
    return Promise.resolve(next ?? []);
  });
  return { client: { list, upload }, list, upload };
}

describe("enrichment Job admission", () => {
  it("skips remote admission for a local command", async () => {
    const { client, list, upload } = clientWithListings();

    await expect(
      admitSingleEnrichmentJob(
        {
          HF_TOKEN: "test-token",
          INDEX_BUCKET: "owner/index",
          XTAP_SOURCE_REVISION: SOURCE_REVISION,
        },
        { client },
      ),
    ).resolves.toEqual({ admitted: true });
    expect(list).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("publishes a durable claim and admits one stable physical Job", async () => {
    const { client, list, upload } = clientWithListings(
      [claim(LEADER_JOB_ID)],
      [claim(LEADER_JOB_ID)],
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      admitSingleEnrichmentJob(ENV, { client, sleep, settleMs: 0, confirmationMs: 0 }),
    ).resolves.toEqual({ admitted: true, jobId: LEADER_JOB_ID });
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0]).toBe(`${CLAIM_PREFIX}/${LEADER_JOB_ID}.json`);
    const claimContent = upload.mock.calls[0]?.[1];
    expect(claimContent).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(claimContent)) as unknown).toEqual({
      schema_version: 1,
      job_id: LEADER_JOB_ID,
      source_revision: SOURCE_REVISION,
      created_at: new Date(Number.parseInt(LEADER_JOB_ID.slice(0, 8), 16) * 1_000).toISOString(),
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledWith(CLAIM_PREFIX);
    expect(sleep).toHaveBeenNthCalledWith(1, 0);
    expect(sleep).toHaveBeenNthCalledWith(2, 0);
  });

  it("elects the earliest simultaneous physical Job", async () => {
    const listing = [claim(FOLLOWER_JOB_ID), claim(LEADER_JOB_ID)];
    const { client } = clientWithListings(listing, listing);

    await expect(
      admitSingleEnrichmentJob(ENV, {
        client,
        sleep: () => Promise.resolve(),
        settleMs: 0,
        confirmationMs: 0,
      }),
    ).resolves.toEqual({ admitted: true, jobId: LEADER_JOB_ID });
  });

  it("rejects the later simultaneous physical Job before work", async () => {
    const listing = [claim(FOLLOWER_JOB_ID), claim(LEADER_JOB_ID)];
    const { client, list } = clientWithListings(listing, listing);

    await expect(
      admitSingleEnrichmentJob(
        { ...ENV, JOB_ID: FOLLOWER_JOB_ID },
        {
          client,
          sleep: () => Promise.resolve(),
          settleMs: 0,
          confirmationMs: 0,
        },
      ),
    ).rejects.toThrow(
      `single-writer admission rejected enrichment Job ${FOLLOWER_JOB_ID}; elected ${LEADER_JOB_ID}; contenders: ${LEADER_JOB_ID},${FOLLOWER_JOB_ID}`,
    );
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("rejects a later Job that appears during confirmation", async () => {
    const { client, list } = clientWithListings(
      [claim(FOLLOWER_JOB_ID)],
      [claim(FOLLOWER_JOB_ID), claim(LEADER_JOB_ID)],
    );

    await expect(
      admitSingleEnrichmentJob(
        { ...ENV, JOB_ID: FOLLOWER_JOB_ID },
        {
          client,
          sleep: () => Promise.resolve(),
          settleMs: 0,
          confirmationMs: 0,
        },
      ),
    ).rejects.toThrow(`elected ${LEADER_JOB_ID}`);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("fails closed when its durable claim is not visible", async () => {
    const { client } = clientWithListings([claim(FOLLOWER_JOB_ID)]);

    await expect(
      admitSingleEnrichmentJob(ENV, {
        client,
        sleep: () => Promise.resolve(),
        settleMs: 0,
        confirmationMs: 0,
      }),
    ).rejects.toThrow(
      `single-writer admission could not verify enrichment Job ${LEADER_JOB_ID}; contenders: ${FOLLOWER_JOB_ID}`,
    );
  });

  it("ignores old claims and claims outside the current source revision", async () => {
    const oldJobId = "6aac000052d0dbd7f1d695e3";
    const listing = [
      claim(LEADER_JOB_ID),
      claim(oldJobId),
      claim(FOLLOWER_JOB_ID, `operations/enrichment/admission/${"b".repeat(40)}/claims`),
    ];
    const { client } = clientWithListings(listing, listing);

    await expect(
      admitSingleEnrichmentJob(ENV, {
        client,
        sleep: () => Promise.resolve(),
        settleMs: 0,
        confirmationMs: 0,
      }),
    ).resolves.toEqual({ admitted: true, jobId: LEADER_JOB_ID });
  });

  it("rejects malformed production admission inputs", async () => {
    const { client } = clientWithListings();
    await expect(
      admitSingleEnrichmentJob({ ...ENV, HF_TOKEN: undefined }, { client, settleMs: 0 }),
    ).rejects.toThrow("HF_TOKEN is required for enrichment Job admission");
    await expect(
      admitSingleEnrichmentJob({ ...ENV, INDEX_BUCKET: "invalid" }, { client, settleMs: 0 }),
    ).rejects.toThrow("INDEX_BUCKET must use owner/name form");
    await expect(
      admitSingleEnrichmentJob({ ...ENV, JOB_ID: "job-1" }, { client, settleMs: 0 }),
    ).rejects.toThrow("JOB_ID must be a 24-character hexadecimal Hugging Face Job ID");
    await expect(
      admitSingleEnrichmentJob(
        { ...ENV, XTAP_SOURCE_REVISION: "NOT-A-REVISION" },
        { client, settleMs: 0 },
      ),
    ).rejects.toThrow("XTAP_SOURCE_REVISION must be a 40-character lowercase Git revision");
  });
});
