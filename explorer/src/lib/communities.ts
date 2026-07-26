import type { GraphLink } from "@xtap-pool/shared";

type Adjacency = Map<string, { to: string; w: number }[]>;

type LouvainState = {
  adj: Adjacency;
  m2: number;
  degree: Map<string, number>;
  community: Map<string, string>;
  communityDegree: Map<string, number>;
};

function buildAdjacency(links: readonly GraphLink[]): { adj: Adjacency; m2: number } {
  const adj: Adjacency = new Map();
  let totalWeight = 0;
  for (const { source, target, weight } of links) {
    const a = adj.get(source) ?? [];
    const b = adj.get(target) ?? [];
    a.push({ to: target, w: weight });
    b.push({ to: source, w: weight });
    adj.set(source, a);
    adj.set(target, b);
    totalWeight += weight;
  }
  return { adj, m2: 2 * totalWeight || 1 };
}

function num(map: Map<string, number>, key: string): number {
  return map.get(key) ?? 0;
}

function weightsToCommunities(state: LouvainState, slug: string): Map<string, number> {
  const linksTo = new Map<string, number>();
  for (const { to, w } of state.adj.get(slug) ?? []) {
    const c = state.community.get(to) ?? to;
    linksTo.set(c, num(linksTo, c) + w);
  }
  return linksTo;
}

function bestCommunity(state: LouvainState, slug: string, own: string): string {
  const k = num(state.degree, slug);
  const linksTo = weightsToCommunities(state, slug);
  const gainFor = (c: string, kIn: number): number =>
    kIn - (k * num(state.communityDegree, c)) / state.m2;
  let best = own;
  let bestGain = gainFor(own, num(linksTo, own));
  const entries = [...linksTo.entries()].sort(([x], [y]) => x.localeCompare(y));
  for (const [c, kIn] of entries) {
    const gain = gainFor(c, kIn);
    if (gain > bestGain + 1e-12) {
      best = c;
      bestGain = gain;
    }
  }
  return best;
}

function localMovePass(state: LouvainState, slugs: string[]): boolean {
  let moved = false;
  for (const slug of slugs) {
    const own = state.community.get(slug) ?? slug;
    const k = state.degree.get(slug) ?? 0;
    state.communityDegree.set(own, (state.communityDegree.get(own) ?? 0) - k);
    const best = bestCommunity(state, slug, own);
    state.community.set(slug, best);
    state.communityDegree.set(best, (state.communityDegree.get(best) ?? 0) + k);
    if (best !== own) moved = true;
  }
  return moved;
}

function renumberBySize(community: Map<string, string>): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const c of community.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  const order = [...sizes.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([c]) => c);
  return new Map(order.map((c, i) => [c, i]));
}

/**
 * Deterministic single-level Louvain over a weighted edge list.
 * Returns slug -> community index by descending community size;
 * nodes without edges get -1 (rendered gray).
 */
export function communityGroups(
  slugs: readonly string[],
  links: readonly GraphLink[],
): Record<string, number> {
  const { adj, m2 } = buildAdjacency(links);
  const connected = [...adj.keys()].sort();
  const state: LouvainState = {
    adj,
    m2,
    degree: new Map(connected.map((s) => [s, (adj.get(s) ?? []).reduce((sum, e) => sum + e.w, 0)])),
    community: new Map(connected.map((s) => [s, s])),
    communityDegree: new Map(),
  };
  for (const s of connected) {
    state.communityDegree.set(s, state.degree.get(s) ?? 0);
  }
  for (let iter = 0; iter < 50; iter++) {
    if (!localMovePass(state, connected)) break;
  }
  const groupIndex = renumberBySize(state.community);
  const groups: Record<string, number> = {};
  for (const slug of slugs) {
    const c = state.community.get(slug);
    groups[slug] = c === undefined ? -1 : (groupIndex.get(c) ?? -1);
  }
  return groups;
}
