import { describe, expect, it, vi } from "vitest";

import { checkStorageCredential, storageCredentialOk } from "../src/storage-token.js";

const rawBucket = "alice/xtap-pool-data";
const indexBucket = "alice/xtap-pool-bucket";

function scope(name: string, permissions: readonly string[], type = "bucket"): unknown {
  return { entity: { type, name }, permissions };
}

function whoami(scopes: readonly unknown[]): unknown {
  return {
    auth: {
      accessToken: {
        role: "fineGrained",
        fineGrained: { global: [], scoped: scopes },
      },
    },
  };
}

function validScopes(): readonly unknown[] {
  const permissions = ["repo.content.read", "repo.content.write"];
  return [scope(rawBucket, permissions), scope(indexBucket, permissions)];
}

function check(fetchFn: typeof fetch, token = "hf_storage") {
  return checkStorageCredential({ token, rawBucket, indexBucket, fetchFn });
}

describe("storage credential readiness", () => {
  it("accepts exact raw and index Bucket read/write scopes plus direct reads", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(whoami(validScopes())))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await check(fetchFn);
    expect(result).toEqual({ credential: "ok" });
    expect(storageCredentialOk(result)).toBe(true);
    expect(storageCredentialOk({ credential: "invalid", error: "bad" })).toBe(false);
    expect(storageCredentialOk({ credential: "unknown", error: "wait" })).toBe(false);
  });

  it("rejects a token whose index Bucket scope is missing", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json(whoami([scope(rawBucket, ["repo.content.read", "repo.content.write"])])),
      );

    await expect(check(fetchFn)).resolves.toEqual({
      credential: "invalid",
      error: `HF_TOKEN must include repo.content.read on ${indexBucket}. HF_TOKEN must include repo.content.write or repo.write on ${indexBucket}.`,
    });
  });

  it("rejects tokens whose metadata passes but a direct storage read fails", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(whoami(validScopes())))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    await expect(check(fetchFn)).resolves.toEqual({
      credential: "invalid",
      error: "Hugging Face rejected a direct private-Bucket read using HF_TOKEN (401).",
    });
  });

  it("rejects storage tokens without raw Bucket write permission", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json(
          whoami([
            scope(rawBucket, ["repo.content.read"]),
            scope(indexBucket, ["repo.content.read", "repo.content.write"]),
          ]),
        ),
      );

    await expect(check(fetchFn, "hf_readonly")).resolves.toEqual({
      credential: "invalid",
      error: `HF_TOKEN must include repo.content.write or repo.write on ${rawBucket}.`,
    });
  });

  it("rejects broad token roles", async () => {
    const broad: typeof fetch = () =>
      Promise.resolve(Response.json({ auth: { accessToken: { role: "write", fineGrained: {} } } }));
    await expect(check(broad)).resolves.toMatchObject({ credential: "invalid" });
  });

  it("accepts unrelated scopes while requiring the configured Bucket grants", async () => {
    const payload = whoami([
      scope(rawBucket, ["repo.content.read", "repo.content.write", "repo.delete"]),
      scope(indexBucket, ["repo.content.read", "repo.content.write"]),
      scope("alice/other", ["repo.content.read"]),
      scope("alice/legacy", ["repo.content.read", "repo.write"], "dataset"),
    ]) as { auth: { accessToken: { fineGrained: { global: string[] } } } };
    payload.auth.accessToken.fineGrained.global = ["inference.serverless.write"];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(payload))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await expect(check(fetchFn)).resolves.toEqual({ credential: "ok" });
  });

  it("accepts Bucket entity aliases and read probes that return not found", async () => {
    const aliases = [
      scope(`buckets/${rawBucket}`, ["repo.content.read", "repo.write"], "buckets"),
      {
        entity: { type: "bucket", namespace: "alice", name: "xtap-pool-bucket" },
        permissions: ["repo.content.read", "repo.content.write"],
      },
    ];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(whoami(aliases)))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(check(fetchFn)).resolves.toEqual({ credential: "ok" });
  });

  it("treats thrown and transient Hub failures as unknown so startup can retry", async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response("oops", { status: 503 }));

    await expect(check(fetchFn)).resolves.toEqual({
      credential: "unknown",
      error: "Hugging Face rejected HF_TOKEN (503).",
    });

    const direct = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(whoami(validScopes())))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }));
    await expect(check(direct)).resolves.toMatchObject({ credential: "unknown" });

    const thrown: typeof fetch = () => Promise.reject(new Error("offline"));
    await expect(check(thrown)).resolves.toEqual({ credential: "unknown", error: "offline" });
  });
});
