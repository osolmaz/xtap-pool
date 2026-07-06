import type { PooledTweet } from "@xtap-pool/shared";

export type TweetRecord = {
  tweet: PooledTweet;
  contributors: readonly string[];
};

export type TweetPage = {
  records: readonly TweetRecord[];
  nextCursor?: string;
};

export type ContributorStats = {
  username: string;
  tweetCount: number;
  lastPooledAt: string;
};

export type Me = {
  username: string;
  isAdmin: boolean;
};

export type MemberOrgGrant = {
  name: string;
  sub: string;
  display_name?: string;
};

export type PoolSnapshot = {
  version: 1;
  admins: readonly string[];
  members: readonly string[];
  member_orgs: readonly MemberOrgGrant[];
  bootstrap_admins: readonly string[];
  updated_at: string;
  updated_by?: string;
  source: "dataset" | "bootstrap";
  config_error?: string;
};

export type AdminPoolResponse = {
  pool: PoolSnapshot;
  viewer: { username: string };
};

export type Filters = {
  contributors: readonly string[];
  q: string;
  since: string;
  until: string;
  hasMedia: boolean;
  isArticle: boolean;
  dedup: boolean;
};

export const defaultFilters: Filters = {
  contributors: [],
  q: "",
  since: "",
  until: "",
  hasMedia: false,
  isArticle: false,
  dedup: true,
};

function nonEmpty(value: string): string | undefined {
  return value === "" ? undefined : value;
}

function flag(active: boolean): string | undefined {
  return active ? "true" : undefined;
}

/** Serialize UI filter state into /api/tweets query parameters. */
export function tweetsQueryString(filters: Filters, cursor?: string): string {
  const until = nonEmpty(filters.until);
  const entries: [string, string | undefined][] = [
    ["contributors", nonEmpty(filters.contributors.join(","))],
    ["q", nonEmpty(filters.q)],
    ["since", nonEmpty(filters.since)],
    ["until", until === undefined ? undefined : `${until}T23:59:59.999Z`],
    ["has_media", flag(filters.hasMedia)],
    ["is_article", flag(filters.isArticle)],
    ["dedup", String(filters.dedup)],
    ["cursor", cursor],
  ];
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
}

async function getJson<T>(path: string): Promise<T | undefined> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error(`request failed: ${String(response.status)} ${path}`);
  return (await response.json()) as T;
}

async function sendJson<T>(path: string, method: "PUT" | "DELETE"): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`request failed: ${String(response.status)} ${path}`);
  return (await response.json()) as T;
}

/** Current viewer, or undefined when not signed in. */
export async function fetchMe(): Promise<Me | undefined> {
  const me = await getJson<Partial<Me> & { username: string }>("/api/me");
  return me === undefined ? undefined : { username: me.username, isAdmin: me.isAdmin === true };
}

export async function fetchTweets(filters: Filters, cursor?: string): Promise<TweetPage> {
  const page = await getJson<TweetPage>(`/api/tweets?${tweetsQueryString(filters, cursor)}`);
  if (page === undefined) throw new Error("session expired");
  return page;
}

export async function fetchContributors(): Promise<ContributorStats[]> {
  const body = await getJson<{ contributors: ContributorStats[] }>("/api/contributors");
  if (body === undefined) throw new Error("session expired");
  return body.contributors;
}

export async function fetchAdminPool(): Promise<AdminPoolResponse> {
  const body = await getJson<AdminPoolResponse>("/api/admin/pool");
  if (body === undefined) throw new Error("session expired");
  return body;
}

export async function addPoolMember(username: string): Promise<PoolSnapshot> {
  return (
    await sendJson<{ pool: PoolSnapshot }>(
      `/api/admin/members/${encodeURIComponent(username)}`,
      "PUT",
    )
  ).pool;
}

export async function removePoolMember(username: string): Promise<PoolSnapshot> {
  return (
    await sendJson<{ pool: PoolSnapshot }>(
      `/api/admin/members/${encodeURIComponent(username)}`,
      "DELETE",
    )
  ).pool;
}

export async function addPoolAdmin(username: string): Promise<PoolSnapshot> {
  return (
    await sendJson<{ pool: PoolSnapshot }>(
      `/api/admin/admins/${encodeURIComponent(username)}`,
      "PUT",
    )
  ).pool;
}

export async function removePoolAdmin(username: string): Promise<PoolSnapshot> {
  return (
    await sendJson<{ pool: PoolSnapshot }>(
      `/api/admin/admins/${encodeURIComponent(username)}`,
      "DELETE",
    )
  ).pool;
}

export async function addPoolMemberOrg(orgName: string): Promise<PoolSnapshot> {
  return (
    await sendJson<{ pool: PoolSnapshot }>(
      `/api/admin/member-orgs/${encodeURIComponent(orgName)}`,
      "PUT",
    )
  ).pool;
}

export async function removePoolMemberOrg(orgName: string): Promise<PoolSnapshot> {
  return (
    await sendJson<{ pool: PoolSnapshot }>(
      `/api/admin/member-orgs/${encodeURIComponent(orgName)}`,
      "DELETE",
    )
  ).pool;
}
