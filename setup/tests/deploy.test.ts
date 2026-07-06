import { describe, expect, it } from "vitest";

import { collectStaleSpaceDeletes } from "../src/deploy.js";

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
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
