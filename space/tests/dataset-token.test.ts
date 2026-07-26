import { describe, expect, it } from "vitest";

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
