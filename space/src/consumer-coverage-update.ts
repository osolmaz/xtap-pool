import type Database from "better-sqlite3";
import { canonicalJson } from "@xtap-pool/shared";
import type { ResolvedConsumerContext } from "./consumer-context.js";
import { ConsumerBootstrapRequired, ConsumerIndexState } from "./consumer-index-state.js";
import { historicalSelection } from "./consumer-changes.js";
import { selectedCompleteThrough } from "./enrich-store.js";
import {
  selectedCurrentCoverageUnitIds,
  selectedCurrentObservationThrough,
  selectedObservationThrough,
} from "./consumer-coverage.js";
import { ConsumerCoverageEffects } from "./consumer-coverage-effects.js";

export type ConsumerCoverage = {
  kind: "coverage";
  mode: "reuse" | "metrics" | "semantic";
  completeThrough: string | null;
  observationsThrough: string | null;
};
/** Called only on the verified current DB, under the runtime mutex. The base
 * clocks remain valid only while the selected content and completion state do. */
export function updateConsumerCoverage(
  database: Database.Database,
  target: ResolvedConsumerContext,
  base?: ResolvedConsumerContext,
): ConsumerCoverage {
  if (base === undefined || !sameCoverageSelection(base, target))
    return recalculate(database, target);
  const effects = new ConsumerCoverageEffects(database, base, target);
  if (effects.hasNewResults(target.context.contract)) return recalculate(database, target);
  let posts = effects.posts();
  if (posts.length === 0)
    return {
      kind: "coverage",
      mode: "reuse",
      completeThrough: base.context.complete_through,
      observationsThrough: base.context.observations_through,
    };
  // Prove the whole delta before reading any selected bodies. Attempts cannot
  // turn done work pending; non-done retry states have the same coverage effect.
  while (posts.length > 0) {
    if (!posts.every((post) => effects.unchanged(post))) return recalculate(database, target);
    posts = effects.posts(posts.at(-1));
  }
  return metricCoverage(database, target, base, effects);
}
function metricCoverage(
  database: Database.Database,
  target: ResolvedConsumerContext,
  base: ResolvedConsumerContext,
  effects: ConsumerCoverageEffects,
): ConsumerCoverage {
  let through = base.context.observations_through;
  let posts = effects.posts();
  while (posts.length > 0) {
    const latest = selectedObservationThrough(database, target, posts);
    if (latest !== null && (through === null || latest > through)) through = latest;
    posts = effects.posts(posts.at(-1));
  }
  return {
    kind: "coverage",
    mode: "metrics",
    completeThrough: base.context.complete_through,
    observationsThrough: through,
  };
}

function recalculate(
  database: Database.Database,
  target: ResolvedConsumerContext,
): ConsumerCoverage {
  try {
    new ConsumerIndexState(database, target.context.contract, "read").require(
      target.context.source,
    );
  } catch (error) {
    if (error instanceof ConsumerBootstrapRequired) return historicalCoverage(database, target);
    throw error;
  }
  const unitIds = selectedCurrentCoverageUnitIds(database, target);
  return {
    kind: "coverage",
    mode: "semantic",
    completeThrough: selectedCompleteThrough(database, { unitIds }) ?? null,
    observationsThrough: selectedCurrentObservationThrough(database, target, unitIds),
  };
}

function historicalCoverage(
  database: Database.Database,
  target: ResolvedConsumerContext,
): ConsumerCoverage {
  return {
    kind: "coverage",
    mode: "semantic",
    completeThrough: selectedCompleteThrough(database, historicalSelection(target)) ?? null,
    observationsThrough: selectedObservationThrough(database, target),
  };
}
function sameCoverageSelection(
  base: ResolvedConsumerContext,
  target: ResolvedConsumerContext,
): boolean {
  const old = base.context;
  const next = target.context;
  if (
    old.contract !== next.contract ||
    old.projection !== next.projection ||
    old.taxonomy.version !== next.taxonomy.version ||
    canonicalJson(old.selection) !== canonicalJson(next.selection)
  )
    return false;
  const free = next.selection.free_label;
  return (
    old.registry.approved.some((label) => label.name === free) ===
    next.registry.approved.some((label) => label.name === free)
  );
}
