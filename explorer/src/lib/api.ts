import type {
  ConceptGraph,
  ConceptSummary as ApiConceptSummary,
  ConceptsSummary,
  LabelsSummary,
  PooledTweet,
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
  source: "dataset" | "bootstrap";
  config_error?: string;
};

export type AdminPoolResponse = {
  pool: PoolSnapshot;
  viewer: { username: string };
};

/**
 * Enrichment API shapes (labels/concepts/graph). Local contract types for
 * the endpoints described in docs/labels-and-concepts-implementation-plan.md.
 */
export type LabelStat = {
  name: string;
  description?: string;
  count: number;
};

export type ConceptSummary = {
  slug: string;
  name: string;
  aliases: readonly string[];
  post_count: number;
};

export type RelatedConcept = {
  slug: string;
  name: string;
  shared: number;
};

export type ConceptDetail = {
  name: string;
  aliases: readonly string[];
  related: readonly RelatedConcept[];
  post_count: number;
};

export type ConceptGraphData = {
  nodes: readonly { id: string; name: string; docs: number; group: number }[];
  links: readonly { source: string; target: string; weight: number }[];
};

export type Filters = {
  contributors: readonly string[];
  labels: readonly string[];
  concept: string;
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
  concept: "",
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
    ["concept", nonEmpty(filters.concept)],
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

async function sendJson<T>(path: string, method: "POST" | "PUT" | "DELETE"): Promise<T> {
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

/** Full concept vocabulary with post counts. */
export async function fetchConcepts(): Promise<ConceptSummary[]> {
  const body = await getJson<ConceptsSummary>("/api/concepts");
  if (body === undefined) throw new Error("session expired");
  return body.concepts.map((concept) => ({
    slug: concept.slug,
    name: concept.name,
    aliases: concept.aliases,
    post_count: concept.unit_count,
  }));
}

/** One concept with aliases, related concepts and its post count. */
export async function fetchConcept(slug: string): Promise<ConceptDetail> {
  const body = await getJson<ApiConceptSummary>(`/api/concepts/${encodeURIComponent(slug)}`);
  if (body === undefined) throw new Error("session expired");
  return {
    name: body.name,
    aliases: body.aliases,
    related: body.related.map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      shared: entry.shared_units,
    })),
    post_count: body.tweet_count,
  };
}

/** Bounded co-occurrence subgraph of the top concepts. */
export async function fetchConceptGraph(top: number): Promise<ConceptGraphData> {
  const body = await getJson<ConceptGraph>(`/api/graph?top=${String(top)}`);
  if (body === undefined) throw new Error("session expired");
  const groups = communityGroups(
    body.nodes.map((node) => node.slug),
    body.links,
  );
  return {
    nodes: body.nodes.map((node) => ({
      id: node.slug,
      name: node.name,
      docs: node.unit_count,
      group: groups[node.slug] ?? -1,
    })),
    links: body.links,
  };
}

export async function fetchAdminPool(): Promise<AdminPoolResponse> {
  const body = await getJson<AdminPoolResponse>("/api/admin/pool");
  if (body === undefined) throw new Error("session expired");
  return body;
}

export async function repairPoolConfig(): Promise<PoolSnapshot> {
  return (await sendJson<{ pool: PoolSnapshot }>("/api/admin/pool/repair", "POST")).pool;
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
