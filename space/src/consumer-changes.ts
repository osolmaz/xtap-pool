import type Database from "better-sqlite3";
import { canonicalJson, contentHash } from "@xtap-pool/shared";
import type { EnrichedUnit } from "@xtap-pool/shared";
import { HistoricalUnitReader, HistoricalReadLimitError } from "./historical-unit-reader.js";
import type { HistoricalBoundary, HistoricalSelection } from "./historical-unit-reader.js";
import { SourceEffectStore } from "./source-effect-store.js";
import { ConsumerObservationReader } from "./consumer-observations.js";
import { ConsumerPostAccess } from "./consumer-post-access.js";
import { ConsumerPageBuilder } from "./consumer-page.js";
import type { ConsumerStep } from "./consumer-page.js";
import type { ConsumerCursor } from "./consumer-cursor.js";
import { InvalidConsumerCursor } from "./consumer-cursor.js";
import { consumerUnitHash } from "./consumer-content.js";
import { changedApprovals } from "./consumer-registry.js";
import { consumerHistoryUntil } from "./consumer-context.js";
import type { ResolvedConsumerContext } from "./consumer-context.js";

import { ConsumerPrivacyEffects } from "./consumer-privacy.js";

type Position = ConsumerCursor["position"];
type PairBatch = {
  ids: string[];
  before: Map<string, EnrichedUnit>;
  after: Map<string, EnrichedUnit>;
};
const OBSERVATION_SEGMENT_BATCH = 1;

/** Pure bounded read steps. Signing, durable context creation, deadlines, and HTTP
 * authorization belong to the caller; this class never acknowledges a partial item. */
export class ConsumerChangeEngine {
  private readonly reader: HistoricalUnitReader;
  private readonly effects: SourceEffectStore;
  private readonly observations: ConsumerObservationReader;
  private readonly access: ConsumerPostAccess;
  private readonly selection: HistoricalSelection;
  private readonly targetBoundary: HistoricalBoundary;
  private readonly baseBoundary: HistoricalBoundary | undefined;
  private readonly changed: string[];
  private readonly removed: ConsumerPrivacyEffects | undefined;

  constructor(
    database: Database.Database,
    private readonly target: ResolvedConsumerContext,
    private readonly base: ResolvedConsumerContext | undefined,
    private readonly privacy?: ResolvedConsumerContext,
  ) {
    const context = target.context;
    this.removed = privacyEffects(database, target, base, privacy);
    if (
      base !== undefined &&
      (base.context.contract !== context.contract ||
        canonicalJson(base.context.selection) !== canonicalJson(context.selection))
    )
      throw new Error("consumer selection or contract changed; explicit bootstrap is required");
    this.selection = historicalSelection(target);
    this.targetBoundary = {
      segments: target.snapshot.files.map((file) => file.key),
      registry: context.registry,
    };
    this.baseBoundary =
      base === undefined
        ? undefined
        : {
            segments: base.snapshot.files.map((file) => file.key),
            registry: base.context.registry,
          };
    const old = new Set(this.baseBoundary?.segments ?? []);
    const current = new Set(this.targetBoundary.segments);
    if ([...old].some((key) => !current.has(key)))
      throw new Error("consumer source is not append-only");
    this.changed = this.targetBoundary.segments.filter((key) => !old.has(key));
    this.reader = new HistoricalUnitReader(database, context.taxonomy.version, context.contract);
    this.effects = new SourceEffectStore(database, "read");
    this.observations = new ConsumerObservationReader(
      database,
      context.taxonomy.version,
      context.contract,
    );
    this.access = new ConsumerPostAccess(database, context.taxonomy.version, context.contract);
  }

  step(cursor: ConsumerCursor, limit: number): ConsumerStep {
    assertCursorContexts(cursor, this.target, this.base);
    switch (cursor.position.kind) {
      case "bootstrap":
      case "content":
        return this.content(cursor, cursor.position, limit);
      case "activation":
        return this.activation(cursor, cursor.position, limit);
      case "observations":
        return this.samples(cursor, cursor.position, limit);
      default:
        throw new InvalidConsumerCursor();
    }
  }

  private content(
    cursor: ConsumerCursor,
    position: Extract<Position, { kind: "bootstrap" | "content" }>,
    limit: number,
  ): ConsumerStep {
    const candidates = this.candidates(position);
    const batch = this.readPairs(candidates.ids);
    const page = new ConsumerPageBuilder(limit);
    let next: Position = position;
    for (const id of batch.ids) {
      const advanced = this.addUnit(page, position.kind, id, batch);
      if (advanced === undefined) return { changes: page.changes, cursor: this.move(cursor, next) };
      next = advanced;
      if (next.kind === "activation")
        return { changes: page.changes, cursor: this.move(cursor, next) };
    }
    const more = candidates.hasMore || batch.ids.length < candidates.ids.length;
    if (!more)
      next =
        position.kind === "bootstrap" || this.changed.length === 0
          ? { kind: "idle" }
          : { kind: "observations", segment_offset: 0 };
    return { changes: page.changes, cursor: this.move(cursor, next) };
  }

  private addUnit(
    page: ConsumerPageBuilder,
    kind: "bootstrap" | "content",
    id: string,
    batch: PairBatch,
  ): Position | undefined {
    const before = batch.before.get(id);
    const after = this.publishable(batch.after.get(id));
    const change = replacement(id, before, after);
    if (change !== undefined && !page.add(change)) return undefined;
    return kind === "content" && after !== undefined && newlyVisible(before, after).length > 0
      ? { kind: "activation", unit: id }
      : { kind, after: id };
  }

  private candidates(position: Extract<Position, { kind: "bootstrap" | "content" }>): {
    ids: string[];
    hasMore: boolean;
  } {
    const options = {
      targetSegments: this.targetBoundary.segments,
      authorIds: this.target.context.selection.author_ids,
      ...(position.after === undefined ? {} : { after: position.after }),
      limit: position.kind === "bootstrap" ? 200 : 32,
    };
    if (position.kind === "bootstrap") return this.effects.bootstrapUnits(options);
    if (this.baseBoundary === undefined) throw new InvalidConsumerCursor();
    const affected = this.effects.affectedUnits({
      ...options,
      changedSegments: this.changed,
      baseSegments: this.baseBoundary.segments,
      changedLabels: changedApprovals(this.baseBoundary.registry, this.targetBoundary.registry),
      contractHash: this.target.context.contract,
    });
    const restored = this.removed?.restoredUnits(position.after, 33) ?? [];
    const ids = [...new Set([...affected.ids, ...restored])].sort();
    return { ids: ids.slice(0, 32), hasMore: affected.hasMore || ids.length > 32 };
  }

  private publishable(unit: EnrichedUnit | undefined): EnrichedUnit | undefined {
    return unit !== undefined && this.access.canPublish(unit, this.selection) ? unit : undefined;
  }

  private readPairs(ids: readonly string[]): PairBatch {
    if (ids.length === 0) return { ids: [], before: new Map(), after: new Map() };
    let selected = [...ids];
    for (;;) {
      try {
        const before =
          this.baseBoundary === undefined
            ? []
            : this.reader.read(selected, this.baseBoundary, this.selection);
        const after = this.reader.read(selected, this.targetBoundary, this.selection);
        return {
          ids: selected,
          before: new Map(
            before
              .filter((unit) => !this.removed?.includes(unit.posts.map((post) => post.id)))
              .map((unit) => [unit.id, unit]),
          ),
          after: new Map(after.map((unit) => [unit.id, unit])),
        };
      } catch (error) {
        if (!(error instanceof HistoricalReadLimitError) || selected.length <= 1) throw error;
        selected = selected.slice(0, Math.floor(selected.length / 2));
      }
    }
  }

  private activation(
    cursor: ConsumerCursor,
    position: Extract<Position, { kind: "activation" }>,
    limit: number,
  ): ConsumerStep {
    const pair = this.readPairs([position.unit]);
    const after = pair.after.get(position.unit);
    if (after === undefined || !this.access.canPublish(after, this.selection))
      return {
        changes: [{ type: "unit_remove", unit_id: position.unit, reason: "not_available" }],
        cursor: this.move(cursor, { kind: "content", after: position.unit }),
      };
    const ids = newlyVisible(pair.before.get(position.unit), after).filter(
      (id) => id >= (position.after?.post_id ?? ""),
    );
    const postIds = ids.slice(0, 100);
    if (postIds.length === 0)
      return { changes: [], cursor: this.move(cursor, { kind: "content", after: position.unit }) };
    const until = consumerHistoryUntil(this.target.context);
    const history = this.observations.history({
      postIds,
      boundary: this.targetBoundary,
      selection: this.selection,
      since: this.target.context.history_since,
      until,
      ...(position.after === undefined ? {} : { after: position.after }),
      limit,
    });
    const changes = history.observations.map((observation) => ({
      type: "observation" as const,
      observation,
    }));
    if (history.next !== undefined)
      return {
        changes,
        cursor: this.move(cursor, { ...position, after: history.next }),
      };
    const last = postIds.at(-1);
    const next: Position =
      ids.length > postIds.length && last !== undefined
        ? { ...position, after: { post_id: last, observed_at: until, id: "f".repeat(64) } }
        : { kind: "content", after: position.unit };
    return { changes, cursor: this.move(cursor, next) };
  }

  private samples(
    cursor: ConsumerCursor,
    position: Extract<Position, { kind: "observations" }>,
    limit: number,
  ): ConsumerStep {
    if (this.baseBoundary === undefined) throw new InvalidConsumerCursor();
    const keys = this.changed.slice(
      position.segment_offset,
      position.segment_offset + OBSERVATION_SEGMENT_BATCH,
    );
    if (keys.length === 0) return { changes: [], cursor: this.move(cursor, { kind: "idle" }) };
    const sample = this.observations.changed({
      changedSegments: keys,
      previousChangedSegments: this.changed.slice(0, position.segment_offset),
      baseSegments: this.baseBoundary.segments,
      boundary: this.targetBoundary,
      selection: this.selection,
      since: this.target.context.history_since,
      ...(position.after === undefined ? {} : { after: position.after }),
      limit,
    });
    const next: Position =
      sample.hasMore && sample.scanned !== undefined
        ? { ...position, after: sample.scanned }
        : position.segment_offset + keys.length < this.changed.length
          ? { kind: "observations", segment_offset: position.segment_offset + keys.length }
          : { kind: "idle" };
    return {
      changes: sample.observations.map((observation) => ({ type: "observation", observation })),
      cursor: this.move(cursor, next),
    };
  }

  private move(cursor: ConsumerCursor, position: Position): ConsumerCursor {
    const next = { ...cursor };
    if (position.kind === "idle" && this.privacy !== undefined) {
      const keys = new Set(this.targetBoundary.segments);
      if (this.privacy.snapshot.files.every((file) => keys.has(file.key))) delete next.privacy;
    }
    return {
      ...next,
      position,
      ...(position.kind === "idle"
        ? { base: null, started_at: this.target.context.created_at }
        : {}),
    };
  }
}

export function historicalSelection(target: ResolvedConsumerContext): HistoricalSelection {
  const selection = target.context.selection;
  return {
    authorIds: selection.author_ids,
    labels: selection.labels,
    labelMode: selection.label_mode,
    publication: selection.publication,
    ...(selection.free_label === undefined ? {} : { freeLabel: selection.free_label }),
  };
}
function assertCursorContexts(
  cursor: ConsumerCursor,
  target: ResolvedConsumerContext,
  base: ResolvedConsumerContext | undefined,
): void {
  if (cursor.target !== target.id || cursor.base !== (base?.id ?? null))
    throw new InvalidConsumerCursor();
}
function newlyVisible(before: EnrichedUnit | undefined, after: EnrichedUnit): string[] {
  const old = new Set(before?.posts.map((post) => post.id) ?? []);
  return after.posts
    .filter((post) => !old.has(post.id) && post["is_retweet"] !== true)
    .map((post) => post.id)
    .sort();
}
function replacement(
  id: string,
  before: EnrichedUnit | undefined,
  after: EnrichedUnit | undefined,
): ConsumerStep["changes"][number] | undefined {
  if (after === undefined)
    return before === undefined
      ? undefined
      : { type: "unit_remove", unit_id: id, reason: "not_available" };
  const hash = consumerUnitHash(after);
  return before !== undefined && consumerUnitHash(before) === hash
    ? undefined
    : {
        type: "unit_upsert",
        content_hash: hash,
        post_content_hashes: after.posts.map(contentHash),
        unit: after,
      };
}

function privacyEffects(
  database: Database.Database,
  target: ResolvedConsumerContext,
  base?: ResolvedConsumerContext,
  privacy?: ResolvedConsumerContext,
): ConsumerPrivacyEffects | undefined {
  if (base === undefined || privacy === undefined) return undefined;
  return new ConsumerPrivacyEffects(database, [base], [target, base], privacy);
}
