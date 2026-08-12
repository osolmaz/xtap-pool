import { z } from "zod";

import type { LabelAssignment } from "./enrichment.js";
import type { PooledTweet } from "./tweet.js";

/** Stable read scopes granted to a machine consumer. */
export const serviceAccountScopeSchema = z.enum(["units:read", "taxonomy:read"]);

export type ServiceAccountScope = z.infer<typeof serviceAccountScopeSchema>;

/**
 * One enriched conversation-author unit returned by `GET /api/units`.
 * `preset_labels` and `free_labels` are evidence-bearing assignments; only
 * approved free labels appear here.
 */
export type EnrichedUnit = {
  id: string;
  posts: readonly PooledTweet[];
  contributors: readonly string[];
  preset_labels: readonly LabelAssignment[];
  free_labels: readonly LabelAssignment[];
};

/** A revision-consistent page of enriched units. */
export type UnitPage = {
  revision: string;
  cutoff?: string;
  units: readonly EnrichedUnit[];
  next_cursor?: string;
};

export type ServiceAccountKeySummary = {
  id: string;
  created_at: string;
  expires_at?: string;
};

export type ServiceAccountSummary = {
  id: string;
  name: string;
  scopes: readonly ServiceAccountScope[];
  status: "active" | "revoked";
  created_at: string;
  updated_at: string;
  keys: readonly ServiceAccountKeySummary[];
};

export type ServiceAccountsSnapshot = {
  version: 1;
  accounts: readonly ServiceAccountSummary[];
  source: "bucket" | "empty";
  config_error?: string;
};

/** One-time credential result. The raw token is never persisted by xtap-pool. */
export type IssuedServiceAccountCredential = {
  account: ServiceAccountSummary;
  token: string;
};
