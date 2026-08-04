import { describe, expect, it, vi } from "vitest";

import { checkDatasetCredential } from "../src/dataset-token.js";

const datasetRepo = "alice/xtap-pool-data";
const indexBucket = "alice/xtap-pool-bucket";

function scope(name: string, permissions: readonly string[], type: string): unknown {
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
  return [scope(datasetRepo, permissions, "dataset"), scope(indexBucket, permissions, "bucket")];
}

function check(fetchFn: typeof fetch, token = "hf_storage") {
  return checkDatasetCredential({ token, datasetRepo, indexBucket, fetchFn });
}

describe("storage credential readiness", () => {
  it("accepts exact dataset and Bucket read/write scopes plus direct reads", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(whoami(validScopes())))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await expect(check(fetchFn)).resolves.toEqual({ credential: "ok" });
  });

  it("rejects a token whose Bucket metadata scope is missing", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json(
          whoami([scope(datasetRepo, ["repo.content.read", "repo.content.write"], "dataset")]),
        ),
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

  it("rejects storage tokens without write permission", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json(
          whoami([
            scope(datasetRepo, ["repo.content.read"], "dataset"),
            scope(indexBucket, ["repo.content.read", "repo.content.write"], "bucket"),
          ]),
        ),
      );

    await expect(check(fetchFn, "hf_readonly")).resolves.toEqual({
      credential: "invalid",
      error: `HF_TOKEN must include repo.content.write or repo.write on ${datasetRepo}.`,
    });
  });

  it("treats transient Hub failures as unknown so startup can retry", async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response("oops", { status: 503 }));

    await expect(check(fetchFn)).resolves.toEqual({
      credential: "unknown",
      error: "Hugging Face rejected HF_TOKEN (503).",
    });
  });
});
