import { z } from "zod";

export type OAuthSettings = {
  clientId: string;
  clientSecret: string;
  providerUrl: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
};

export type OAuthOrg = {
  sub: string;
  name?: string;
};

export type OAuthIdentity = {
  username: string;
  orgs: readonly OAuthOrg[];
};

export type AuthorizeOptions = {
  orgId?: string;
  /** @deprecated xtap-pool only supports one active member organization. */
  orgIds?: readonly string[];
};

const tokenResponseSchema = z.looseObject({ access_token: z.string().min(1) });
const orgInfoSchema = z.looseObject({
  sub: z.string().min(1),
  name: z.string().optional(),
  preferred_username: z.string().optional(),
});
const userInfoSchema = z.looseObject({
  preferred_username: z.string().min(1),
  orgs: z.array(orgInfoSchema).optional(),
  organizations: z.array(orgInfoSchema).optional(),
});

/** Hugging Face OIDC authorize URL for the code flow. */
export function authorizeUrl(
  settings: OAuthSettings,
  state: string,
  options: AuthorizeOptions = {},
): string {
  const url = new URL(`${settings.providerUrl}/oauth/authorize`);
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", settings.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("state", state);
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- read legacy option for backwards compatibility.
  const orgId = options.orgId ?? options.orgIds?.[0];
  if (orgId !== undefined) url.searchParams.set("orgIds", orgId);
  return url.toString();
}

/**
 * Exchange an authorization code for the HF identity it belongs to.
 * Returns undefined when the provider rejects the exchange.
 */
export async function exchangeCodeForIdentity(
  settings: OAuthSettings,
  code: string,
): Promise<OAuthIdentity | undefined> {
  const fetchFn = settings.fetchFn ?? fetch;
  // Hugging Face's token endpoint authenticates the client with HTTP Basic
  // (client_secret_basic), not a client_secret form field.
  const basic = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64");
  const tokenResponse = await fetchFn(`${settings.providerUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      client_id: settings.clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: settings.redirectUri,
    }),
  });
  if (!tokenResponse.ok) return undefined;
  const tokenBody = tokenResponseSchema.safeParse(await tokenResponse.json());
  if (!tokenBody.success) return undefined;

  const userResponse = await fetchFn(`${settings.providerUrl}/oauth/userinfo`, {
    headers: { authorization: `Bearer ${tokenBody.data.access_token}` },
  });
  if (!userResponse.ok) return undefined;
  const userBody = userInfoSchema.safeParse(await userResponse.json());
  if (!userBody.success) return undefined;
  return {
    username: userBody.data.preferred_username,
    orgs: normalizeOAuthOrgs([
      ...(userBody.data.orgs ?? []),
      ...(userBody.data.organizations ?? []),
    ]),
  };
}

/**
 * Exchange an authorization code for the HF username it belongs to.
 * Returns undefined when the provider rejects the exchange.
 */
export async function exchangeCodeForUsername(
  settings: OAuthSettings,
  code: string,
): Promise<string | undefined> {
  const identity = await exchangeCodeForIdentity(settings, code);
  return identity?.username;
}

function normalizeOAuthOrgs(orgs: readonly z.infer<typeof orgInfoSchema>[]): OAuthOrg[] {
  const bySub = new Map<string, OAuthOrg>();
  for (const org of orgs) {
    const normalized: OAuthOrg = { sub: org.sub };
    const name = org.preferred_username ?? org.name;
    if (name !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      normalized.name = name.toLowerCase();
    }
    bySub.set(normalized.sub, normalized);
  }
  return [...bySub.values()];
}
