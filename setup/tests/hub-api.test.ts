import { describe, expect, it } from "vitest";

import {
  getRepoPrivateState,
  getSpaceVariables,
  parseSpaceVariables,
  setSpaceSecret,
  setSpaceVariable,
} from "../src/hub-api.js";

describe("space variable parsing", () => {
  it("accepts current and simple API shapes", () => {
    const variables = parseSpaceVariables({
      DATASET_REPO: { value: "alice/xtap-pool-data" },
      ALLOWED_USERS: "alice,bob",
      IGNORED: { value: 42 },
    });
    expect([...variables.entries()]).toEqual([
      ["DATASET_REPO", "alice/xtap-pool-data"],
      ["ALLOWED_USERS", "alice,bob"],
    ]);
  });

  it("sends authenticated variable and secret requests", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchFn: typeof fetch = (input, init) => {
      requests.push({ url: requestUrl(input), init: init ?? {} });
      if (init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(Response.json({ DATASET_REPO: { value: "alice/xtap-pool-data" } }));
    };
    const client = { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn };

    await expect(getSpaceVariables(client, "alice/xtap-pool")).resolves.toEqual(
      new Map([["DATASET_REPO", "alice/xtap-pool-data"]]),
    );
    await setSpaceVariable(client, "alice/xtap-pool", "ALLOWED_USERS", "alice,bob");
    await setSpaceSecret(client, "alice/xtap-pool", "HF_TOKEN", "hf_dataset");

    expect(requests.map((request) => [request.url, request.init.method])).toEqual([
      ["https://hub.test/api/spaces/alice/xtap-pool/variables", "GET"],
      ["https://hub.test/api/spaces/alice/xtap-pool/variables", "POST"],
      ["https://hub.test/api/spaces/alice/xtap-pool/secrets", "POST"],
    ]);
    const headers = requests[0]?.init.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer hf_owner");
  });

  it("reads repo visibility from Hub info", async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(Response.json({ private: true }));
    await expect(
      getRepoPrivateState(
        { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
        { type: "dataset", name: "alice/xtap-pool-data" },
      ),
    ).resolves.toBe(true);
  });

  it("surfaces Hub errors with status and body", async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response("bad token", { status: 401 }));
    await expect(
      getSpaceVariables(
        { accessToken: "hf_owner", hubUrl: "https://hub.test", fetchFn },
        "alice/xtap-pool",
      ),
    ).rejects.toThrow("Hub request failed (401): bad token");
  });
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
