import { describe, expect, it } from "vitest";

import { checkInferenceCredential } from "../src/inference-token.js";

describe("inference credential readiness", () => {
  it("accepts tokens with Inference Providers permission", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          auth: {
            accessToken: {
              role: "fineGrained",
              fineGrained: { global: ["inference.serverless.write"], scoped: [] },
            },
          },
        }),
      );

    await expect(
      checkInferenceCredential({ enabled: true, token: "hf_ok", fetchFn }),
    ).resolves.toEqual({ credential: "ok" });
  });

  it("accepts documented user-scoped Inference Providers tokens", async () => {
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
                    entity: { type: "user", name: "alice" },
                    permissions: ["inference.serverless.write"],
                  },
                ],
              },
            },
          },
        }),
      );

    await expect(
      checkInferenceCredential({ enabled: true, token: "hf_ok", fetchFn }),
    ).resolves.toEqual({ credential: "ok" });
  });

  it("rejects tokens without Inference Providers permission", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          auth: { accessToken: { role: "fineGrained", fineGrained: { global: [], scoped: [] } } },
        }),
      );

    await expect(
      checkInferenceCredential({ enabled: true, token: "hf_dataset", fetchFn }),
    ).resolves.toEqual({
      credential: "invalid",
      error: "INFERENCE_TOKEN must include inference.serverless.write.",
    });
  });

  it("rejects inference tokens with additional dataset-scoped permissions", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          auth: {
            accessToken: {
              role: "fineGrained",
              fineGrained: {
                global: ["inference.serverless.write"],
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
      checkInferenceCredential({ enabled: true, token: "hf_mixed", fetchFn }),
    ).resolves.toEqual({
      credential: "invalid",
      error:
        "Unexpected scoped permission on INFERENCE_TOKEN: repo.content.read on dataset:alice/xtap-pool-data.",
    });
  });

  it("treats transient Hub failures as unknown so startup can retry", async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response("oops", { status: 503 }));

    await expect(
      checkInferenceCredential({ enabled: true, token: "hf_inference", fetchFn }),
    ).resolves.toEqual({
      credential: "unknown",
      error: "Hugging Face rejected INFERENCE_TOKEN (503).",
    });
  });
});
