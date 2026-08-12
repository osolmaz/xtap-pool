import { describe, expect, it } from "vitest";
import { z } from "zod";

import { collectStaleSpaceDeletes, configureSpace } from "../src/deploy.js";
import { ENRICHMENT_JOB_DEFAULT_VARIABLES } from "../src/enrichment-job.js";

describe("setup deployment helpers", () => {
  it("builds delete operations for remote Space files missing from the staged upload", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchFn: typeof fetch = (input, init) => {
      requests.push({ url: requestUrl(input), init: init ?? {} });
      return Promise.resolve(
        Response.json([
          { type: "file", path: "README.md", size: 1 },
          { type: "file", path: "space/old.ts", size: 1 },
          { type: "directory", path: "space", size: 0 },
          { type: "file", path: ".gitattributes", size: 1 },
        ]),
      );
    };

    await expect(
      collectStaleSpaceDeletes(
        { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
        "alice/xtap-pool",
        ["README.md", "Dockerfile"],
      ),
    ).resolves.toEqual([{ operation: "delete", path: "space/old.ts" }]);
    expect(requests[0]?.url).toBe(
      "https://hub.test/api/spaces/alice/xtap-pool/tree/main?recursive=true&expand=false",
    );
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer hf_owner");
  });

  it("can retain the dataset variable while it updates Bucket variables", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchFn: typeof fetch = (input, init) => {
      requests.push({ url: requestUrl(input), init: init ?? {} });
      if (init?.method === "GET") {
        return Promise.resolve(Response.json({ DATASET_REPO: { value: "alice/legacy" } }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    await configureSpace(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      {
        namespace: "alice",
        spaceRepo: "alice/xtap-pool",
        rawBucket: "alice/xtap-pool-data",
        indexBucket: "alice/xtap-pool-bucket",
        allowedUsers: ["alice"],
        poolAdmins: ["alice"],
      },
      {
        initializeGeneratedSecrets: false,
        allowLegacyDatasetRemoval: true,
        retainLegacyDataset: true,
      },
    );

    expect(requests[0]).toMatchObject({
      url: "https://hub.test/api/spaces/alice/xtap-pool/variables",
      init: { method: "GET" },
    });
    expect(requests.some((request) => request.init.method === "DELETE")).toBe(false);
    const writes = requests
      .slice(1)
      .map((request) => requestBody(request.init))
      .filter((body): body is string => body !== undefined)
      .map(parseVariableWrite);
    expect(Object.fromEntries(writes.map(({ key, value }) => [key, value]))).toEqual({
      RAW_BUCKET: "alice/xtap-pool-data",
      INDEX_BUCKET: "alice/xtap-pool-bucket",
      ALLOWED_USERS: "alice",
      POOL_ADMINS: "alice",
      ENRICH_ENABLED: "false",
      ...ENRICHMENT_JOB_DEFAULT_VARIABLES,
    });
  });

  it("blocks a legacy update until the pinned Bucket import is verified", async () => {
    const fetchFn: typeof fetch = (_input, init) =>
      Promise.resolve(
        init?.method === "GET"
          ? Response.json({ DATASET_REPO: { value: "alice/legacy" } })
          : new Response(null, { status: 204 }),
      );

    await expect(
      configureSpace(
        { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
        {
          namespace: "alice",
          spaceRepo: "alice/xtap-pool",
          rawBucket: "alice/xtap-pool-data",
          indexBucket: "alice/xtap-pool-bucket",
          allowedUsers: ["alice"],
          poolAdmins: ["alice"],
        },
        { initializeGeneratedSecrets: false },
      ),
    ).rejects.toThrow("complete and verify the pinned Bucket import");
  });
});

function parseVariableWrite(body: string): { key: string; value: string } {
  const candidate: unknown = JSON.parse(body);
  return z.object({ key: z.string(), value: z.string() }).strict().parse(candidate);
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBody(init: RequestInit): string | undefined {
  if (init.body === undefined || init.body === null) return undefined;
  if (typeof init.body === "string") return init.body;
  throw new Error("expected string request body");
}
