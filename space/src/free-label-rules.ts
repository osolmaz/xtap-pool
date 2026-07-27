/**
 * Deterministic rules governing which free-label names are accepted. These
 * rules are part of the classifier `contract_hash` — changing them requires
 * a new contract identifier so previously accepted results are re-checked.
 *
 * Everything here operates on the *normalized name plus its evidence*. It is
 * not a stylistic style guide; it enforces that the model cannot promote
 * grammatical categories, opinion phrases, or unsupported industry
 * abstractions into public navigation.
 */

import { slugifyFreeLabel } from "@xtap-pool/shared";
import type { Evidence, LabelAssignment } from "@xtap-pool/shared";

/**
 * Names hard-rejected regardless of evidence: they are grammatical
 * categories, discourse forms, or opinion phrasing that must never become a
 * public navigation category. The worker includes these deterministic rules
 * in every prompt without creating a non-durable registry transition.
 */
export const HARD_REJECTED_NAMES: readonly string[] = [
  "deixis",
  "pronoun-category",
  "grammatical-feature",
  "discourse-form",
  "quality-philosophy",
  "quality-discourse",
  "opinion",
  "sentiment",
];

/**
 * Names that are so generic they can only be accepted if the literal word (or
 * a short morphological variant) appears in every evidence quote. This is
 * what stops `manufacturing` from attaching to a DGX enclosure post that
 * discusses hardware without ever using the word manufacturing.
 */
const ABSTRACT_NAMES_REQUIRING_LITERAL: ReadonlyMap<string, readonly string[]> = new Map([
  ["manufacturing", ["manufactur"]],
  ["industry", ["industry", "industri"]],
  ["philosophy", ["philosoph"]],
  ["technology", ["technolog"]],
  ["quality", ["quality"]],
  ["discourse", ["discourse"]],
  ["business", ["business"]],
  ["policy", ["policy", "polic"]],
]);

/** Minimum length of any evidence quote after stripping whitespace. */
const MIN_QUOTE_LENGTH = 3;

/** Minimum number of alphanumeric tokens (≥3 chars each) across the evidence. */
const MIN_SUBSTANTIVE_TOKENS = 1;

export type NameValidationOutcome = { ok: true } | { ok: false; reason: string };

/** Slug-normalize the model's free-label name. Empty slug is invalid. */
export function normalizeFreeLabelName(name: string): string {
  return slugifyFreeLabel(name);
}

/**
 * Validate a free-label name against deterministic rules that do not require
 * the current registry state. Used at ingest time to discard obvious errors
 * before consulting the registry.
 */
function checkName(name: string): NameValidationOutcome {
  if (name.length === 0) return { ok: false, reason: "empty-slug" };
  if (name.length < 2) return { ok: false, reason: "too-short" };
  if (name.length > 60) return { ok: false, reason: "too-long" };
  if (HARD_REJECTED_NAMES.includes(name)) return { ok: false, reason: `hard-rejected:${name}` };
  return { ok: true };
}

function checkEvidence(evidence: readonly Evidence[]): NameValidationOutcome {
  if (evidence.length === 0) return { ok: false, reason: "no-evidence" };
  if (!evidenceHasSubstantiveText(evidence)) {
    return { ok: false, reason: "unsubstantive-evidence" };
  }
  return { ok: true };
}

export function validateFreeLabelName(
  name: string,
  evidence: readonly Evidence[],
): NameValidationOutcome {
  const nameCheck = checkName(name);
  if (!nameCheck.ok) return nameCheck;
  const evidenceCheck = checkEvidence(evidence);
  if (!evidenceCheck.ok) return evidenceCheck;
  const required = ABSTRACT_NAMES_REQUIRING_LITERAL.get(name);
  if (required !== undefined && !allQuotesContain(evidence, required)) {
    return { ok: false, reason: `abstract-name-without-literal:${name}` };
  }
  return { ok: true };
}

function evidenceHasSubstantiveText(evidence: readonly Evidence[]): boolean {
  let tokens = 0;
  for (const item of evidence) {
    const trimmed = item.quote.trim();
    if (trimmed.length < MIN_QUOTE_LENGTH) continue;
    const found = trimmed.match(/[\p{L}\p{N}]{3,}/gu);
    tokens += found?.length ?? 0;
  }
  return tokens >= MIN_SUBSTANTIVE_TOKENS;
}

function allQuotesContain(evidence: readonly Evidence[], substrings: readonly string[]): boolean {
  return evidence.every((entry) => {
    const lower = entry.quote.toLowerCase();
    return substrings.some((needle) => lower.includes(needle));
  });
}

/**
 * Verify that every quote in an assignment is a verbatim substring of the
 * matching tweet's text. Missing tweet IDs are treated as invalid evidence.
 */
export function validateEvidenceQuotes(
  assignment: LabelAssignment,
  memberTexts: ReadonlyMap<string, string>,
): NameValidationOutcome {
  for (const evidence of assignment.evidence) {
    const source = memberTexts.get(evidence.tweet_id);
    if (source === undefined) return { ok: false, reason: `unknown-tweet:${evidence.tweet_id}` };
    if (!source.includes(evidence.quote)) {
      return { ok: false, reason: `quote-not-in-tweet:${evidence.tweet_id}` };
    }
  }
  return { ok: true };
}

/**
 * Predicate helper for tests and the worker: was the unit's aggregate text
 * substantive enough to justify emitting any free labels? Used only in the
 * classifier prompt as guidance; validation is done per-assignment above.
 */
export function unitHasSubstantiveText(text: string): boolean {
  const tokens = text.match(/[\p{L}\p{N}]{3,}/gu);
  return (tokens?.length ?? 0) >= MIN_SUBSTANTIVE_TOKENS;
}
