import { describe, expect, it } from "vitest";

import { verifyInferenceToken } from "../src/inference-token.js";

describe("inference token verification", () => {
  it("accepts fine-grained tokens with Inference Providers permission", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          name: "alice",
          auth: {
            accessToken: {
              displayName: "providers",
              role: "fineGrained",
              fineGrained: { global: ["inference.serverless.write"], scoped: [] },
            },
          },
        }),
      );
    await expect(verifyInferenceToken({ token: "hf_ok", fetchFn })).resolves.toEqual({
      ok: true,
      username: "alice",
      tokenName: "providers",
      permissions: ["inference.serverless.write"],
    });
  });

  it("accepts documented user-scoped Inference Providers tokens", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          name: "alice",
          auth: {
            accessToken: {
              displayName: "providers",
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
    await expect(verifyInferenceToken({ token: "hf_ok", fetchFn })).resolves.toEqual({
      ok: true,
      username: "alice",
      tokenName: "providers",
      permissions: ["inference.serverless.write"],
    });
  });

  it("accepts the Hugging Face inference permission pair on a user scope", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          name: "alice",
          auth: {
            accessToken: {
              displayName: "providers",
              role: "fineGrained",
              fineGrained: {
                global: [],
                scoped: [
                  {
                    entity: { type: "user", name: "alice" },
                    permissions: ["inference.serverless.write", "inference.endpoints.infer.write"],
                  },
                ],
              },
            },
          },
        }),
      );
    await expect(verifyInferenceToken({ token: "hf_ok", fetchFn })).resolves.toEqual({
      ok: true,
      username: "alice",
      tokenName: "providers",
      permissions: ["inference.endpoints.infer.write", "inference.serverless.write"],
    });
  });

  it("rejects dataset-scoped tokens without Inference Providers permission", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          name: "alice",
          auth: {
            accessToken: {
              displayName: "dataset-only",
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
    await expect(verifyInferenceToken({ token: "hf_dataset", fetchFn })).resolves.toEqual({
      ok: false,
      errors: [
        "Unexpected scoped permission on inference token: repo.content.read, repo.content.write on dataset:alice/xtap-pool-data.",
        "Token must include inference.serverless.write.",
      ],
    });
  });

  it("rejects tokens Hugging Face does not accept", async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response("bad", { status: 401 }));
    await expect(verifyInferenceToken({ token: "bad", fetchFn })).resolves.toEqual({
      ok: false,
      errors: ["Hugging Face rejected the token (401)."],
    });
  });
});
