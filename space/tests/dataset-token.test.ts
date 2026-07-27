import { describe, expect, it, vi } from "vitest";

import { checkDatasetCredential } from "../src/dataset-token.js";

describe("dataset credential readiness", () => {
  it("accepts fine-grained tokens with dataset read/write permissions only", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          auth: {
            accessToken: {
              role: "fineGrained",
              fineGrained: {
                global: [],
                scoped: [
                  {
                    entity: { type: "dataset", name: "alice/xtap-pool-data" },
                    permissions: ["repo.content.read", "repo.content.write"],
                  },
                ],
              },
            },
          },
        }),
      );

    await expect(
      checkDatasetCredential({ token: "hf_dataset", datasetRepo: "alice/xtap-pool-data", fetchFn }),
    ).resolves.toEqual({ credential: "ok" });
  });

  it("rejects tokens whose metadata passes but private-dataset downloads fail", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          auth: {
            accessToken: {
              role: "fineGrained",
              fineGrained: {
                global: [],
                scoped: [
                  {
                    entity: { type: "dataset", name: "alice/xtap-pool-data" },
                    permissions: ["repo.content.read", "repo.content.write"],
                  },
                ],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    await expect(
      checkDatasetCredential({ token: "hf_dataset", datasetRepo: "alice/xtap-pool-data", fetchFn }),
    ).resolves.toEqual({
      credential: "invalid",
      error: "Hugging Face rejected a direct private-dataset download using HF_TOKEN (401).",
    });
  });

  it("rejects dataset tokens without write permission", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          auth: {
            accessToken: {
              role: "fineGrained",
              fineGrained: {
                global: [],
                scoped: [
                  {
                    entity: { type: "dataset", name: "alice/xtap-pool-data" },
                    permissions: ["repo.content.read"],
                  },
                ],
              },
            },
          },
        }),
      );

    await expect(
      checkDatasetCredential({
        token: "hf_readonly",
        datasetRepo: "alice/xtap-pool-data",
        fetchFn,
      }),
    ).resolves.toEqual({
      credential: "invalid",
      error: "HF_TOKEN must include repo.content.write or repo.write on alice/xtap-pool-data.",
    });
  });

  it("treats transient Hub failures as unknown so startup can retry", async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response("oops", { status: 503 }));

    await expect(
      checkDatasetCredential({ token: "hf_dataset", datasetRepo: "alice/xtap-pool-data", fetchFn }),
    ).resolves.toEqual({
      credential: "unknown",
      error: "Hugging Face rejected HF_TOKEN (503).",
    });
  });
});
