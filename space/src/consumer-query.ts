import { z } from "zod";
import { canonicalJson } from "@xtap-pool/shared";
import { consumerSelectionSchema } from "./consumer-context.js";
import type { ConsumerSelection } from "./consumer-context.js";
import { ConsumerHttpError } from "./consumer-errors.js";

export type ConsumerRoute = "bootstrap" | "changes" | "history" | "reconcile";
const filters = ["author_ids", "labels", "label_mode", "free_label", "publication"];
const options = {
  bootstrap: ["cursor", "limit"],
  changes: ["after", "limit", "reconciled"],
  history: ["cursor", "at", "post_ids", "since", "until", "limit", "reconciled"],
  reconcile: ["cursor", "limit"],
};
export function consumerQuery(url: URL, route: ConsumerRoute): URLSearchParams {
  const query = url.searchParams;
  const allowed = new Set([...filters, ...options[route]]);
  for (const key of query.keys()) {
    if (!allowed.has(key) || query.getAll(key).length !== 1)
      throw new ConsumerHttpError(
        400,
        "invalid_query",
        `Unsupported or repeated query option: ${key}`,
      );
  }
  return query;
}
export function pageLimit(query: URLSearchParams): number {
  const raw = query.get("limit");
  if (raw !== null && !/^[1-9]\d{0,2}$/u.test(raw))
    throw new ConsumerHttpError(400, "invalid_limit", "Limit must be an integer from 1 to 500.");
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .parse(raw ?? 200);
}
function csv(value: string): string[] {
  return value.split(",").map((part) => part.trim());
}
export function initialSelection(query: URLSearchParams): ConsumerSelection {
  return consumerSelectionSchema.parse({
    author_ids: csv(query.get("author_ids") ?? ""),
    labels: query.has("labels") ? csv(query.get("labels") ?? "") : [],
    label_mode: query.get("label_mode") ?? "any",
    publication: query.get("publication"),
    ...(query.has("free_label") ? { free_label: query.get("free_label") } : {}),
  });
}
export function bindSelection(query: URLSearchParams, selection: ConsumerSelection): void {
  const merged = new URLSearchParams();
  for (const key of filters) {
    const value = selection[key as keyof ConsumerSelection];
    if (Array.isArray(value)) {
      if (value.length > 0) merged.set(key, value.join(","));
    } else if (value !== undefined) merged.set(key, value);
    if (query.has(key)) merged.set(key, query.get(key) ?? "");
  }
  if (canonicalJson(initialSelection(merged)) !== canonicalJson(selection))
    throw new ConsumerHttpError(400, "selection_conflict", "The selection is fixed by the cursor.");
}
export const historyRequestSchema = z
  .object({
    post_ids: z
      .array(z.string().regex(/^[1-9]\d{0,19}$/u))
      .min(1)
      .max(100),
    since: z.iso.datetime().transform((v) => new Date(v).toISOString()),
    until: z.iso.datetime().transform((v) => new Date(v).toISOString()),
  })
  .strict()
  .superRefine((v, c) => {
    const duration = Date.parse(v.until) - Date.parse(v.since);
    if (
      duration <= 0 ||
      duration > 30 * 86_400_000 ||
      new Set(v.post_ids).size !== v.post_ids.length
    )
      c.addIssue({
        code: "custom",
        message: "History requires distinct IDs and a positive range of at most 30 days.",
      });
  });
export function historyRequest(query: URLSearchParams) {
  return historyRequestSchema.parse({
    post_ids: csv(query.get("post_ids") ?? "").sort(),
    since: query.get("since"),
    until: query.get("until"),
  });
}
