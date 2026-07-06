import { describe, expect, it } from "vitest";

import { collectStaleSpaceDeletes, configureSpace } from "../src/deploy.js";

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

  it("can update variables without initializing generated secrets", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchFn: typeof fetch = (input, init) => {
      requests.push({ url: requestUrl(input), init: init ?? {} });
      if (init?.method === "GET") return Promise.resolve(Response.json({}));
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    await configureSpace(
      { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
      {
        namespace: "alice",
        spaceRepo: "alice/xtap-pool",
        datasetRepo: "alice/xtap-pool-data",
        allowedUsers: ["alice"],
        poolAdmins: ["alice"],
      },
      { initializeGeneratedSecrets: false },
    );

    expect(requests.map((request) => [request.url, request.init.method])).toEqual([
      ["https://hub.test/api/spaces/alice/xtap-pool/variables", "GET"],
      ["https://hub.test/api/spaces/alice/xtap-pool/variables", "POST"],
      ["https://hub.test/api/spaces/alice/xtap-pool/variables", "POST"],
      ["https://hub.test/api/spaces/alice/xtap-pool/variables", "POST"],
    ]);
    expect(requests.map((request) => requestBody(request.init))).toEqual([
      undefined,
      JSON.stringify({ key: "DATASET_REPO", value: "alice/xtap-pool-data" }),
      JSON.stringify({ key: "ALLOWED_USERS", value: "alice" }),
      JSON.stringify({ key: "POOL_ADMINS", value: "alice" }),
    ]);
  });
});

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
