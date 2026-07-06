import { z } from "zod";

import { normalizeOrgName } from "./membership.js";
import type { MemberOrgGrant } from "./membership.js";

const orgOverviewSchema = z.looseObject({
  _id: z.string().min(1),
  name: z.string().min(1),
  fullname: z.string().min(1).optional(),
});

export type OrgResolver = (orgName: string) => Promise<MemberOrgGrant>;

export function createHuggingFaceOrgResolver(
  providerUrl: string,
  fetchFn: typeof fetch = fetch,
): OrgResolver {
  return async (orgName) => {
    const requestedName = normalizeOrgName(orgName);
    const response = await fetchFn(
      `${providerUrl}/api/organizations/${encodeURIComponent(requestedName)}/overview`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      throw new Error(`Hugging Face organization not found: ${requestedName}`);
    }
    const parsed = orgOverviewSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`Hugging Face organization response was invalid: ${requestedName}`);
    }
    const resolvedName = normalizeOrgName(parsed.data.name);
    return {
      name: resolvedName,
      sub: parsed.data._id,
      ...(parsed.data.fullname === undefined ? {} : { display_name: parsed.data.fullname }),
    };
  };
}
