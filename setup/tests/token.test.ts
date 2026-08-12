import { describe, expect, it, vi } from "vitest";

import { evaluateStorageWriteToken, verifyStorageWriteToken } from "../src/token.js";

const rawBucket = "alice/xtap-pool-data";
const indexBucket = "alice/xtap-pool-bucket";
const targets = [
  { kind: "bucket", name: rawBucket },
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

function scope(name: string, permissions: readonly string[], type = "bucket"): unknown {
  return { entity: { type, name }, permissions };
}

function validScopes(): readonly unknown[] {
  const permissions = ["repo.access.read", "repo.content.read", "repo.write"];
  return [scope(rawBucket, permissions), scope(indexBucket, permissions, "bucket")];
}

describe("storage token verification", () => {
  it("accepts direct private raw and index Bucket reads", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(whoami(validScopes())))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const report = await verifyStorageWriteToken({
      token: "hf_good",
      rawBucket,
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

  it("reports rejected identity checks and indeterminate direct reads", async () => {
    const rejectedFetch: typeof fetch = () =>
      Promise.resolve(new Response("unavailable", { status: 503 }));
    await expect(
      verifyStorageWriteToken({
        token: "hf_rejected",
        rawBucket,
        indexBucket,
        fetchFn: rejectedFetch,
      }),
    ).resolves.toEqual({
      ok: false,
      errors: ["Hugging Face rejected the token (503)."],
    });

    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(whoami(validScopes())))
      .mockResolvedValueOnce(new Response("unavailable", { status: 500 }))
      .mockResolvedValueOnce(new Response("missing probe", { status: 404 }));
    await expect(
      verifyStorageWriteToken({
        token: "hf_indeterminate",
        rawBucket,
        indexBucket,
        fetchFn,
      }),
    ).resolves.toEqual({
      ok: false,
      errors: [`Could not verify a direct read from ${rawBucket} (500).`],
    });
  });

  it("rejects permission metadata when either direct read is unauthorized", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(whoami(validScopes())))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const report = await verifyStorageWriteToken({
      token: "hf_bad",
      rawBucket,
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

  it("accepts exact read/write scopes on both Buckets", () => {
    const report = evaluateStorageWriteToken(whoami(validScopes()), targets);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.permissions).toContain(`bucket:${rawBucket}:repo.content.read`);
      expect(report.permissions).toContain(`bucket:${indexBucket}:repo.write`);
    }
  });

  it("rejects missing token metadata without throwing", () => {
    const report = evaluateStorageWriteToken({}, targets);
    expect(report).toEqual({
      ok: false,
      errors: [
        "Token role is 'unknown', expected fine-grained.",
        `Token must include repo.content.read on ${rawBucket}.`,
        `Token must include repo.content.write or repo.write on ${rawBucket}.`,
        `Token must include repo.content.read on ${indexBucket}.`,
        `Token must include repo.content.write or repo.write on ${indexBucket}.`,
      ],
    });
  });

  it("accepts prefixed and namespace-qualified entity names", () => {
    const permissions = ["repo.content.read", "repo.content.write"];
    const report = evaluateStorageWriteToken(
      whoami([
        {
          entity: { type: "bucket", namespace: "alice", name: "xtap-pool-data" },
          permissions,
        },
        scope(`buckets/${indexBucket}`, permissions, "buckets"),
      ]),
      targets,
    );
    expect(report.ok).toBe(true);
  });

  it("rejects classic tokens", () => {
    const classic = evaluateStorageWriteToken(whoami(validScopes(), "write"), targets);
    expect(classic.ok).toBe(false);
  });

  it("accepts unrelated scopes while requiring the configured Bucket grants", () => {
    const payload = whoami([
      ...validScopes(),
      scope("alice/other", ["repo.content.read"]),
      scope("alice/legacy", ["repo.content.read", "repo.write"], "dataset"),
    ]) as { auth: { accessToken: { fineGrained: { global: string[] } } } };
    payload.auth.accessToken.fineGrained.global = ["inference.serverless.write"];
    expect(evaluateStorageWriteToken(payload, targets).ok).toBe(true);
  });

  it("requires read and write permission on both exact targets", () => {
    const missingBucketWrite = evaluateStorageWriteToken(
      whoami([
        scope(rawBucket, ["repo.content.read", "repo.content.write"]),
        scope(indexBucket, ["repo.content.read"], "bucket"),
      ]),
      targets,
    );
    const unexpected = evaluateStorageWriteToken(
      whoami([
        scope(rawBucket, ["repo.content.read", "repo.settings.write"]),
        scope(indexBucket, ["repo.content.read", "repo.content.write"], "bucket"),
      ]),
      targets,
    );
    expect(missingBucketWrite.ok).toBe(false);
    expect(unexpected.ok).toBe(false);
  });
});
