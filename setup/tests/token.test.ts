import { describe, expect, it, vi } from "vitest";

import { evaluateStorageWriteToken, verifyStorageWriteToken } from "../src/token.js";

const datasetRepo = "alice/xtap-pool-data";
const indexBucket = "alice/xtap-pool-bucket";
const targets = [
  { kind: "dataset", name: datasetRepo },
  { kind: "bucket", name: indexBucket },
] as const;

function whoami(scoped: readonly unknown[], role = "fineGrained"): unknown {
  return {
    name: "owner",
    auth: {
      accessToken: {
        displayName: "storage-writer",
        role,
        fineGrained: { global: [], scoped },
      },
    },
  };
}

function scope(name: string, permissions: readonly string[], type = "dataset"): unknown {
  return { entity: { type, name }, permissions };
}

function validScopes(): readonly unknown[] {
  const permissions = ["repo.access.read", "repo.content.read", "repo.write"];
  return [scope(datasetRepo, permissions), scope(indexBucket, permissions, "bucket")];
}

describe("storage token verification", () => {
  it("accepts direct private-dataset and private-Bucket reads", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(whoami(validScopes())))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const report = await verifyStorageWriteToken({
      token: "hf_good",
      datasetRepo,
      indexBucket,
      fetchFn,
    });
    expect(report.ok).toBe(true);
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      `https://huggingface.co/api/buckets/${indexBucket}`,
      expect.objectContaining({ headers: { authorization: "Bearer hf_good" } }),
    );
  });

  it("rejects permission metadata when either direct read is unauthorized", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(whoami(validScopes())))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const report = await verifyStorageWriteToken({
      token: "hf_bad",
      datasetRepo,
      indexBucket,
      fetchFn,
    });
    expect(report).toEqual({
      ok: false,
      errors: [
        `Token permissions claim access to ${indexBucket}, but Hugging Face rejected a direct private-Bucket read (401).`,
      ],
    });
  });

  it("accepts exact read/write scopes on the dataset and Bucket", () => {
    const report = evaluateStorageWriteToken(whoami(validScopes()), targets);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.permissions).toContain(`dataset:${datasetRepo}:repo.content.read`);
      expect(report.permissions).toContain(`bucket:${indexBucket}:repo.write`);
    }
  });

  it("accepts prefixed entity names", () => {
    const permissions = ["repo.content.read", "repo.content.write"];
    const report = evaluateStorageWriteToken(
      whoami([
        scope(`datasets/${datasetRepo}`, permissions),
        scope(`buckets/${indexBucket}`, permissions, "buckets"),
      ]),
      targets,
    );
    expect(report.ok).toBe(true);
  });

  it("rejects classic tokens, unrelated scopes, and global permissions", () => {
    const classic = evaluateStorageWriteToken(whoami(validScopes(), "write"), targets);
    const unrelated = evaluateStorageWriteToken(
      whoami([...validScopes(), scope("alice/other", ["repo.content.read"])]),
      targets,
    );
    const global = whoami(validScopes()) as {
      auth: { accessToken: { fineGrained: { global: string[] } } };
    };
    global.auth.accessToken.fineGrained.global = ["inference.serverless.write"];
    expect(classic.ok).toBe(false);
    expect(unrelated.ok).toBe(false);
    expect(evaluateStorageWriteToken(global, targets).ok).toBe(false);
  });

  it("requires read and write permission on both exact targets", () => {
    const missingBucketWrite = evaluateStorageWriteToken(
      whoami([
        scope(datasetRepo, ["repo.content.read", "repo.content.write"]),
        scope(indexBucket, ["repo.content.read"], "bucket"),
      ]),
      targets,
    );
    const unexpected = evaluateStorageWriteToken(
      whoami([
        scope(datasetRepo, ["repo.content.read", "repo.settings.write"]),
        scope(indexBucket, ["repo.content.read", "repo.content.write"], "bucket"),
      ]),
      targets,
    );
    expect(missingBucketWrite.ok).toBe(false);
    expect(unexpected.ok).toBe(false);
  });
});
