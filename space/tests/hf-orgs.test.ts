import { describe, expect, it } from "vitest";

import { createHuggingFaceOrgResolver } from "../src/hf-orgs.js";

describe("createHuggingFaceOrgResolver", () => {
  it("resolves a Hugging Face org slug to a stable member org grant", async () => {
    const fetchFn: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe("https://huggingface.co/api/organizations/huggingface/overview");
      return Promise.resolve(
        Response.json({ _id: "org-hf", name: "HuggingFace", fullname: "Hugging Face" }),
      );
    };

    await expect(
      createHuggingFaceOrgResolver("https://huggingface.co", fetchFn)("HuggingFace"),
    ).resolves.toEqual({
      name: "huggingface",
      sub: "org-hf",
      display_name: "Hugging Face",
    });
  });

  it("rejects missing organizations", async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response("no", { status: 404 }));
    await expect(
      createHuggingFaceOrgResolver("https://huggingface.co", fetchFn)("missing"),
    ).rejects.toThrow("Hugging Face organization not found: missing");
  });
});
