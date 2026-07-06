import { describe, expect, it } from "vitest";

import { authorizeUrl, exchangeCodeForIdentity, exchangeCodeForUsername } from "../src/oauth.js";
import type { OAuthSettings } from "../src/oauth.js";

const settings: OAuthSettings = {
  clientId: "cid",
  clientSecret: "csecret",
  providerUrl: "https://huggingface.co",
  redirectUri: "https://space.example/oauth/callback",
};

function fakeFetch(tokenResponse: () => Response, userInfoResponse: () => Response): typeof fetch {
  return (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/oauth/token")) return Promise.resolve(tokenResponse());
    return Promise.resolve(userInfoResponse());
  };
}

describe("authorizeUrl", () => {
  it("builds the HF authorize URL with the code flow parameters", () => {
    const url = new URL(authorizeUrl(settings, "state-123"));
    expect(url.origin).toBe("https://huggingface.co");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(settings.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.getAll("orgIds")).toEqual([]);
  });

  it("adds one configured organization id to the authorize URL", () => {
    const url = new URL(authorizeUrl(settings, "state-123", { orgId: "org-a" }));
    expect(url.searchParams.getAll("orgIds")).toEqual(["org-a"]);
  });

  it("uses only the first deprecated organization id", () => {
    const url = new URL(
      authorizeUrl(settings, "state-123", { orgIds: ["org-b", "org-a", "org-b"] }),
    );
    expect(url.searchParams.getAll("orgIds")).toEqual(["org-b"]);
  });
});

describe("exchangeCodeForUsername", () => {
  it("returns the username on a successful exchange", async () => {
    const fetchFn = fakeFetch(
      () => Response.json({ access_token: "at" }),
      () => Response.json({ preferred_username: "osolmaz" }),
    );
    await expect(exchangeCodeForUsername({ ...settings, fetchFn }, "code")).resolves.toBe(
      "osolmaz",
    );
  });

  it("returns stable organization identities from userinfo", async () => {
    const fetchFn = fakeFetch(
      () => Response.json({ access_token: "at" }),
      () =>
        Response.json({
          preferred_username: "osolmaz",
          orgs: [{ sub: "org-hf", preferred_username: "HuggingFace" }],
          organizations: [
            { sub: "org-hf", preferred_username: "huggingface" },
            { sub: "org-other", name: "OtherOrg" },
          ],
        }),
    );
    await expect(exchangeCodeForIdentity({ ...settings, fetchFn }, "code")).resolves.toEqual({
      username: "osolmaz",
      orgs: [
        { sub: "org-hf", name: "huggingface" },
        { sub: "org-other", name: "otherorg" },
      ],
    });
  });

  it("authenticates the client with HTTP Basic on the token exchange", async () => {
    let tokenInit: RequestInit | undefined;
    const fetchFn: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/oauth/token")) {
        tokenInit = init;
        return Promise.resolve(Response.json({ access_token: "at" }));
      }
      return Promise.resolve(Response.json({ preferred_username: "osolmaz" }));
    };
    await exchangeCodeForUsername({ ...settings, fetchFn }, "code");
    const headers = tokenInit?.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from("cid:csecret").toString("base64")}`;
    expect(headers["authorization"]).toBe(expected);
    const body = tokenInit?.body as URLSearchParams;
    expect(body.get("client_secret")).toBeNull();
    expect(body.get("code")).toBe("code");
  });

  it.each([
    [
      "token endpoint failure",
      fakeFetch(
        () => new Response("nope", { status: 400 }),
        () => Response.json({ preferred_username: "osolmaz" }),
      ),
    ],
    [
      "token body without access_token",
      fakeFetch(
        () => Response.json({}),
        () => Response.json({ preferred_username: "osolmaz" }),
      ),
    ],
    [
      "userinfo endpoint failure",
      fakeFetch(
        () => Response.json({ access_token: "at" }),
        () => new Response("nope", { status: 401 }),
      ),
    ],
    [
      "userinfo without username",
      fakeFetch(
        () => Response.json({ access_token: "at" }),
        () => Response.json({ name: "whoever" }),
      ),
    ],
  ])("returns undefined on %s", async (_label, fetchFn) => {
    await expect(
      exchangeCodeForUsername({ ...settings, fetchFn }, "code"),
    ).resolves.toBeUndefined();
  });
});
