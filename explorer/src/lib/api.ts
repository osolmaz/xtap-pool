import type {
  FreeLabelGraph,
  FreeLabelDetail as ApiFreeLabelDetail,
  LabelsSummary,
  PooledTweet,
  ServiceAccountScope,
  ServiceAccountsSnapshot,
  ServiceAccountSummary,
  IssuedServiceAccountCredential,
} from "@xtap-pool/shared";

import { communityGroups } from "./communities";

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
  source: "bucket" | "bootstrap";
  config_error?: string;
};

export type AdminPoolResponse = {
  pool: PoolSnapshot;
  viewer: { username: string };
};

export type AdminEnrichment = {
  contract_hash: string;
  totals: {
    pending: number;
    running: number;
    retrying: number;
    blocked: number;
    completed: number;
  };
  worker_recently_completed: boolean;
  freshness_lag_seconds?: number;
  recent_errors: readonly { error_class: string; count: number }[];
};

export type AdminFreeLabels = {
  registry_revision: number;
  labels: readonly {
    name: string;
    status: "candidate" | "approved" | "rejected";
    unit_count: number;
    reason?: string;
  }[];
  candidates: readonly {
    name: string;
    unit_count: number;
    distinct_authors: number;
    distinct_days: number;
    representative_quotes: readonly { unit_id: string; tweet_id: string; quote: string }[];
  }[];
};

/**
 * Enrichment API shapes (labels/free labels/graph). Local contract types for
 * the endpoints described in docs/labels-and-free-labels-implementation-plan.md.
 */
export type LabelStat = {
  name: string;
  description?: string;
  count: number;
};

export type FreeLabelSummary = {
  name: string;
  post_count: number;
};

export type RelatedFreeLabel = {
  name: string;
  shared: number;
};

export type FreeLabelDetail = {
  name: string;
  related: readonly RelatedFreeLabel[];
  post_count: number;
};

export type FreeLabelGraphData = {
  nodes: readonly { id: string; name: string; docs: number; group: number }[];
  links: readonly { source: string; target: string; weight: number }[];
};

/** Free label listing (approved names only). */
export type FreeLabelStat = { name: string; count: number };

export type Filters = {
  contributors: readonly string[];
  labels: readonly string[];
  freeLabel: string;
  q: string;
  since: string;
  until: string;
  hasMedia: boolean;
  isArticle: boolean;
  dedup: boolean;
};

export const defaultFilters: Filters = {
  contributors: [],
  labels: [],
  freeLabel: "",
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
    ["labels", nonEmpty(filters.labels.join(","))],
    ["free_label", nonEmpty(filters.freeLabel)],
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

async function sendJson<T>(
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

/** Preset label taxonomy with counts. */
export async function fetchLabels(): Promise<LabelStat[]> {
  const body = await getJson<LabelsSummary>("/api/labels");
  if (body === undefined) throw new Error("session expired");
  return body.labels.map(({ name, description, count }) => ({
    name,
    description,
    count,
  }));
}

/**
 * Approved free-label vocabulary with unit counts.
 */
export async function fetchFreeLabels(): Promise<FreeLabelSummary[]> {
  const body = await getJson<{ free_labels: FreeLabelStat[] }>("/api/free-labels");
  if (body === undefined) throw new Error("session expired");
  return body.free_labels.map((entry) => ({
    name: entry.name,
    post_count: entry.count,
  }));
}

/** One approved free label with related approved labels. */
export async function fetchFreeLabel(name: string): Promise<FreeLabelDetail> {
  const body = await getJson<ApiFreeLabelDetail>(`/api/free-labels/${encodeURIComponent(name)}`);
  if (body === undefined) throw new Error("session expired");
  return {
    name: body.name,
    related: body.related.map((entry) => ({
      name: entry.name,
      shared: entry.shared_units,
    })),
    post_count: body.tweet_count,
  };
}

/** Bounded co-occurrence subgraph of the top approved free labels. */
export async function fetchFreeLabelGraph(top: number): Promise<FreeLabelGraphData> {
  const body = await getJson<FreeLabelGraph>(`/api/graph?top=${String(top)}`);
  if (body === undefined) throw new Error("session expired");
  const groups = communityGroups(
    body.nodes.map((node) => node.name),
    body.links,
  );
  return {
    nodes: body.nodes.map((node) => ({
      id: node.name,
      name: node.name,
      docs: node.unit_count,
      group: groups[node.name] ?? -1,
    })),
    links: body.links,
  };
}

export async function fetchAdminPool(): Promise<AdminPoolResponse> {
  const body = await getJson<AdminPoolResponse>("/api/admin/pool");
  if (body === undefined) throw new Error("session expired");
  return body;
}

export async function fetchAdminEnrichment(): Promise<AdminEnrichment> {
  const body = await getJson<AdminEnrichment>("/api/admin/enrichment");
  if (body === undefined) throw new Error("session expired");
  return body;
}

export async function fetchAdminFreeLabels(): Promise<AdminFreeLabels> {
  const body = await getJson<AdminFreeLabels>("/api/admin/free-labels");
  if (body === undefined) throw new Error("session expired");
  return body;
}

export async function repairPoolConfig(): Promise<PoolSnapshot> {
  return (await sendJson<{ pool: PoolSnapshot }>("/api/admin/pool/repair", "POST")).pool;
}

export async function fetchAdminServiceAccounts(): Promise<ServiceAccountsSnapshot> {
  const body = await getJson<{ service_accounts: ServiceAccountsSnapshot }>(
    "/api/admin/service-accounts",
  );
  if (body === undefined) throw new Error("session expired");
  return body.service_accounts;
}

export async function issueServiceAccount(
  name: string,
  scopes: readonly ServiceAccountScope[],
): Promise<IssuedServiceAccountCredential> {
  return sendJson<IssuedServiceAccountCredential>("/api/admin/service-accounts", "POST", {
    name,
    scopes,
  });
}

export async function rotateServiceAccount(
  accountId: string,
): Promise<IssuedServiceAccountCredential> {
  return sendJson<IssuedServiceAccountCredential>(
    `/api/admin/service-accounts/${encodeURIComponent(accountId)}/keys`,
    "POST",
  );
}

export async function revokeServiceAccount(accountId: string): Promise<ServiceAccountSummary> {
  return (
    await sendJson<{ account: ServiceAccountSummary }>(
      `/api/admin/service-accounts/${encodeURIComponent(accountId)}`,
      "DELETE",
    )
  ).account;
}

export async function revokeServiceAccountKey(
  accountId: string,
  keyId: string,
): Promise<ServiceAccountSummary> {
  return (
    await sendJson<{ account: ServiceAccountSummary }>(
      `/api/admin/service-accounts/${encodeURIComponent(accountId)}/keys/${encodeURIComponent(keyId)}`,
      "DELETE",
    )
  ).account;
}

export async function repairServiceAccounts(): Promise<ServiceAccountsSnapshot> {
  return (
    await sendJson<{ service_accounts: ServiceAccountsSnapshot }>(
      "/api/admin/service-accounts/repair",
      "POST",
    )
  ).service_accounts;
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
