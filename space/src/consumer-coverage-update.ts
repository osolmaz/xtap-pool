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

type EffectSummary = {
  changedPosts: boolean;
  observationsThrough: string | null;
  semanticUnits: Set<string>;
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
  const resultUnits = collectNewResultUnits(effects, target.context.contract);
  const summary = inspectPostEffects(database, target, base, effects);
  const semantic = resultUnits.size > 0 || summary.semanticUnits.size > 0;
  const unchanged = nonSemanticCoverage(base, summary, semantic);
  if (unchanged !== null) return unchanged;

  const affectedUnits = new Set([...resultUnits, ...summary.semanticUnits]);
  const currentAffectedUnits = selectedCurrentCoverageUnitIds(database, target, {
    unitIds: [...affectedUnits],
  });
  if (
    coverageCanMoveBackward(database, base, summary.semanticUnits, currentAffectedUnits) ||
    affectedUnitsContainObservationMaximum(base, effects, affectedUnits)
  )
    return recalculate(database, target);

  const affectedLatest = selectedCurrentObservationThrough(database, target, currentAffectedUnits);
  const observationsThrough = later(summary.observationsThrough, affectedLatest);
  return {
    kind: "coverage",
    mode: "semantic",
    completeThrough: forwardCompleteThrough(database, target, base),
    observationsThrough,
  };
}

function nonSemanticCoverage(
  base: ResolvedConsumerContext,
  summary: EffectSummary,
  semantic: boolean,
): ConsumerCoverage | null {
  if (semantic) return null;
  return {
    kind: "coverage",
    mode: summary.changedPosts ? "metrics" : "reuse",
    completeThrough: base.context.complete_through,
    observationsThrough: summary.observationsThrough,
  };
}

function inspectPostEffects(
  database: Database.Database,
  target: ResolvedConsumerContext,
  base: ResolvedConsumerContext,
  effects: ConsumerCoverageEffects,
): EffectSummary {
  let observationsThrough = base.context.observations_through;
  let changedPosts = false;
  const semanticUnits = new Set<string>();
  let posts = effects.posts();
  while (posts.length > 0) {
    changedPosts = true;
    observationsThrough = later(
      observationsThrough,
      selectedObservationThrough(database, target, posts),
    );
    const semanticPosts = effects.semanticPosts(posts);
    for (const unit of effects.units(semanticPosts)) semanticUnits.add(unit);
    posts = effects.posts(posts.at(-1));
  }
  return { changedPosts, observationsThrough, semanticUnits };
}

function collectNewResultUnits(effects: ConsumerCoverageEffects, contract: string): Set<string> {
  const units = new Set<string>();
  let page = effects.newResultUnits(contract);
  while (page.length > 0) {
    for (const unit of page) units.add(unit);
    page = effects.newResultUnits(contract, page.at(-1));
  }
  return units;
}

function coverageCanMoveBackward(
  database: Database.Database,
  base: ResolvedConsumerContext,
  semanticUnits: ReadonlySet<string>,
  currentAffectedUnits: readonly string[],
): boolean {
  const boundary = base.context.complete_through;
  if (boundary === null) return semanticUnits.size > 0;
  if (semanticUnits.size === 0) return false;
  const semantic = new Set(semanticUnits);
  const selected = currentAffectedUnits.filter((unit) => semantic.has(unit));
  if (selected.length !== semantic.size) return true;
  return (
    database
      .prepare(
        `SELECT 1 FROM enrich_queue
      WHERE unit_id IN (SELECT value FROM json_each(?))
        AND latest_activity_at <= ? LIMIT 1`,
      )
      .get(JSON.stringify(selected), boundary) !== undefined
  );
}

function affectedUnitsContainObservationMaximum(
  base: ResolvedConsumerContext,
  effects: ConsumerCoverageEffects,
  units: ReadonlySet<string>,
): boolean {
  const maximum = base.context.observations_through;
  return maximum !== null && effects.unitsObservedAt([...units], maximum);
}

function forwardCompleteThrough(
  database: Database.Database,
  target: ResolvedConsumerContext,
  base: ResolvedConsumerContext,
): string | null {
  const boundary = base.context.complete_through;
  if (boundary === null) return recalculate(database, target).completeThrough;
  const forwardUnits = selectedCurrentCoverageUnitIds(database, target, {
    after: boundary,
  });
  const forward =
    forwardUnits.length === 0
      ? null
      : (selectedCompleteThrough(database, { unitIds: forwardUnits }) ?? null);
  return later(boundary, forward);
}

function later(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
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
