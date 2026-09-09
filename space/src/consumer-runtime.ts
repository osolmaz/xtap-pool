import { stat } from "node:fs/promises";
import { canonicalJson } from "@xtap-pool/shared";
import type {
  ConsumerContextStore,
  ConsumerSelection,
  ResolvedConsumerContext,
} from "./consumer-context.js";
import { consumerHistoryUntil, consumerMetadataHash } from "./consumer-context.js";
import type { ConsumerCursor, ConsumerCursorCodec, RemovalPosition } from "./consumer-cursor.js";
import { ConsumerHttpError, consumerErrorResponse } from "./consumer-errors.js";
import { abortable, consumerStage, withConsumerDeadline } from "./consumer-deadline.js";
import { HARD_PAGE_BYTES, OversizedConsumerSource } from "./consumer-page.js";
import type { ConsumerWorkers } from "./consumer-workers.js";
import type { ConsumerWorkerTask } from "./consumer-worker-task.js";
import {
  bindSelection,
  consumerQuery,
  historyRequest,
  initialSelection,
  pageLimit,
} from "./consumer-query.js";
import type { ConsumerRoute } from "./consumer-query.js";
import {
  consumerChangesEnvelopeSchema,
  consumerHistoryEnvelopeSchema,
  consumerReconciliationEnvelopeSchema,
} from "./consumer-http-contract.js";

type PinInput = Parameters<ConsumerContextStore["pin"]>[0];
export type ConsumerCurrent = Pick<PinInput, "snapshot" | "boundary" | "taxonomy"> & {
  databasePath: string;
};
export type ConsumerRuntimeOptions = {
  contexts: ConsumerContextStore;
  codec: ConsumerCursorCodec;
  workers: ConsumerWorkers;
  current: () => ConsumerCurrent;
  locked: <T>(operation: () => Promise<T>) => Promise<T>;
  now?: () => Date;
  deadlineMs?: number;
};
type Sequence = {
  target: ResolvedConsumerContext;
  base?: ResolvedConsumerContext;
  privacy?: ResolvedConsumerContext;
  reconciliation?: ResolvedConsumerContext;
  cursor: ConsumerCursor;
};

export class ConsumerRuntime {
  private active = 0;
  private readonly now: () => Date;
  constructor(private readonly options: ConsumerRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async read(route: ConsumerRoute, request: Request, authorize: () => void): Promise<Response> {
    authorize();
    const query = consumerQuery(new URL(request.url), route);
    const limit = pageLimit(query);
    if (this.active >= 2)
      throw new ConsumerHttpError(
        429,
        "consumer_busy",
        "Consumer read capacity is full. Retry the same cursor.",
      );
    this.active++;
    return withConsumerDeadline(
      (signal) => this.lockedRead(route, query, limit, signal, authorize),
      request.signal,
      this.options.deadlineMs,
    );
  }

  private async lockedRead(
    route: ConsumerRoute,
    query: URLSearchParams,
    limit: number,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<Response> {
    try {
      consumerStage("waiting for the index");
      return await this.options.locked(async () => {
        signal.throwIfAborted();
        authorize();
        const current = this.options.current();
        consumerStage("loading source metadata");
        const sequence = await this.sequence(route, query, current, signal);
        signal.throwIfAborted();
        const response = await this.page(sequence, current, limit, signal);
        signal.throwIfAborted();
        authorize();
        return response;
      });
    } finally {
      this.active--;
    }
  }

  private async sequence(
    route: ConsumerRoute,
    query: URLSearchParams,
    current: ConsumerCurrent,
    signal: AbortSignal,
  ): Promise<Sequence> {
    const sequence =
      route === "reconcile"
        ? await this.reconciliationSequence(query, signal)
        : await this.normalSequence(route, query, current, signal);
    const receipt = query.get("reconciled");
    if (receipt !== null) await this.attachReceipt(sequence, receipt, route, query, signal);
    if (sequence.cursor.privacy !== undefined)
      sequence.privacy = await this.related(sequence.cursor.privacy, sequence.target, signal);
    return sequence;
  }

  private async related(
    id: string,
    target: ResolvedConsumerContext,
    signal: AbortSignal,
  ): Promise<ResolvedConsumerContext> {
    const context = await abortable(this.options.contexts.read(id), signal);
    if (canonicalJson(context.context.selection) !== canonicalJson(target.context.selection))
      throw invalidRoute();
    return context;
  }

  private async reconciliationSequence(
    query: URLSearchParams,
    signal: AbortSignal,
  ): Promise<Sequence> {
    const cursor = this.options.codec.decode(query.get("cursor") ?? "");
    if (cursor.reconciliation === undefined) throw invalidRoute();
    const target = await abortable(this.options.contexts.read(cursor.target), signal);
    bindSelection(query, target.context.selection);
    const reconciliation = await this.related(cursor.reconciliation.target, target, signal);
    const sequence: Sequence = { target, cursor, reconciliation };
    if (cursor.base !== null) sequence.base = await this.related(cursor.base, target, signal);
    return sequence;
  }

  private async attachReceipt(
    sequence: Sequence,
    token: string,
    route: ConsumerRoute,
    query: URLSearchParams,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertReceiptRoute(route, query);
    const receipt = this.options.codec.decode(token);
    if (receipt.reconciliation !== undefined || receipt.privacy === undefined) throw invalidRoute();
    await this.related(receipt.target, sequence.target, signal);
    const checkpoint = await this.related(receipt.privacy, sequence.target, signal);
    if (sequence.cursor.privacy !== undefined) {
      const previous = await this.related(sequence.cursor.privacy, sequence.target, signal);
      if (containsSource(previous, checkpoint)) return;
      if (!containsSource(checkpoint, previous)) throw invalidRoute();
    }
    sequence.cursor.privacy = checkpoint.id;
  }

  private assertReceiptRoute(route: ConsumerRoute, query: URLSearchParams): void {
    if (route === "history" && !query.has("cursor")) return;
    if (
      route === "changes" &&
      this.options.codec.decode(query.get("after") ?? "").position.kind === "idle"
    )
      return;
    throw invalidRoute();
  }

  private async normalSequence(
    route: ConsumerRoute,
    query: URLSearchParams,
    current: ConsumerCurrent,
    signal: AbortSignal,
  ): Promise<Sequence> {
    if (route === "history") return this.historySequence(query, signal);
    const token = query.get(route === "bootstrap" ? "cursor" : "after");
    if (token === null) {
      if (route === "changes")
        throw new ConsumerHttpError(400, "cursor_required", "Changes requires after.");
      const target = await this.pin(current, initialSelection(query), signal);
      return { target, cursor: this.start(target, null, "bootstrap") };
    }
    const cursor = this.options.codec.decode(token);
    if (cursor.reconciliation !== undefined) throw invalidRoute();
    const target = await abortable(this.options.contexts.read(cursor.target), signal);
    bindSelection(query, target.context.selection);
    return this.continueSequence(route, { target, cursor }, current, signal);
  }

  private async continueSequence(
    route: ConsumerRoute,
    sequence: Sequence,
    current: ConsumerCurrent,
    signal: AbortSignal,
  ): Promise<Sequence> {
    const { target, cursor } = sequence;
    if (route === "bootstrap") {
      if (cursor.position.kind !== "bootstrap") throw invalidRoute();
      return { target, cursor };
    }
    if (cursor.position.kind === "idle") {
      const next = await this.pin(current, target.context.selection, signal, target);
      const started = this.start(next, target.id, "content");
      if (cursor.privacy !== undefined) started.privacy = cursor.privacy;
      return { target: next, base: target, cursor: started };
    }
    if (cursor.base === null || cursor.position.kind === "history") throw invalidRoute();
    const base = await abortable(this.options.contexts.read(cursor.base), signal);
    return { target, base, cursor };
  }

  private async historySequence(query: URLSearchParams, signal: AbortSignal): Promise<Sequence> {
    const token = query.get("cursor");
    if (token !== null) {
      const cursor = this.options.codec.decode(token);
      if (cursor.position.kind !== "history" || cursor.reconciliation !== undefined)
        throw invalidRoute();
      const target = await abortable(this.options.contexts.read(cursor.target), signal);
      bindSelection(query, target.context.selection);
      this.bindHistory(query, cursor);
      return { target, cursor };
    }
    const at = query.get("at");
    if (at === null)
      throw new ConsumerHttpError(
        400,
        "source_cursor_required",
        "History requires a fully consumed at cursor.",
      );
    const consumed = this.consumed(at);
    const target = await abortable(this.options.contexts.read(consumed.target), signal);
    bindSelection(query, target.context.selection);
    const range = historyRequest(query);
    if (
      Date.parse(range.since) < Date.parse(target.context.history_since) ||
      Date.parse(range.until) > Date.parse(consumerHistoryUntil(target.context))
    )
      throw new ConsumerHttpError(
        410,
        "history_outside_window",
        "History is outside the retained source window.",
        {
          action: "explicit_history_recovery",
          history_since: target.context.history_since,
          history_until: consumerHistoryUntil(target.context),
        },
      );
    return {
      target,
      cursor: {
        ...consumed,
        started_at: this.now().toISOString(),
        position: { kind: "history", ...range },
      },
    };
  }

  private consumed(token: string): ConsumerCursor {
    const cursor = this.options.codec.decode(token);
    if (cursor.position.kind !== "idle" || cursor.reconciliation !== undefined)
      throw invalidRoute();
    return cursor;
  }

  private bindHistory(query: URLSearchParams, cursor: ConsumerCursor): void {
    const position = cursor.position;
    if (position.kind !== "history") throw invalidRoute();
    const merged = new URLSearchParams({
      post_ids: position.post_ids.join(","),
      since: position.since,
      until: position.until,
    });
    for (const key of ["post_ids", "since", "until"])
      if (query.has(key)) merged.set(key, query.get(key) ?? "");
    if (
      canonicalJson(historyRequest(merged)) !==
      canonicalJson({ post_ids: position.post_ids, since: position.since, until: position.until })
    )
      throw invalidRoute();
    this.bindHistorySource(query.get("at"), cursor);
  }

  private bindHistorySource(at: string | null, cursor: ConsumerCursor): void {
    if (at === null) return;
    const source = this.options.codec.decode(at);
    if (source.position.kind !== "idle" || source.target !== cursor.target) throw invalidRoute();
  }

  private start(
    target: ResolvedConsumerContext,
    base: string | null,
    kind: "bootstrap" | "content",
  ): ConsumerCursor {
    return {
      schema_version: 1,
      target: target.id,
      base,
      started_at: this.now().toISOString(),
      position: { kind },
    };
  }

  private async pin(
    current: ConsumerCurrent,
    selection: ConsumerSelection,
    signal: AbortSignal,
    base?: ResolvedConsumerContext,
  ): Promise<ResolvedConsumerContext> {
    const created = this.now().toISOString();
    const draft: ResolvedConsumerContext = {
      id: current.boundary.source,
      snapshot: current.snapshot,
      context: {
        schema_version: 1,
        created_at: created,
        ...current.boundary,
        snapshot: { base: current.boundary.source, additions: [] },
        selection,
        taxonomy: current.taxonomy,
        complete_through: null,
        observations_through: null,
        history_since: created,
      },
    };
    consumerStage("calculating source coverage");
    const coverage = await this.options.workers.run(
      await this.task(
        {
          target: draft,
          cursor: this.start(draft, null, "bootstrap"),
          ...(base === undefined ? {} : { base }),
        },
        current,
        1,
        "coverage",
      ),
      signal,
    );
    if (coverage.kind !== "coverage") throw new Error("invalid coverage worker result");
    signal.throwIfAborted();
    consumerStage("saving source metadata");
    return abortable(
      this.options.contexts.pin({
        ...current,
        selection,
        completeThrough: coverage.completeThrough,
        observationsThrough: coverage.observationsThrough,
      }),
      signal,
    );
  }

  private async task(
    sequence: Sequence,
    current: ConsumerCurrent,
    limit: number,
    operation: ConsumerWorkerTask["operation"],
  ): Promise<ConsumerWorkerTask> {
    const file = await stat(current.databasePath);
    return {
      ...sequence,
      path: current.databasePath,
      identity: `${String(file.dev)}:${String(file.ino)}`,
      source: current.boundary.source,
      contract: current.boundary.contract,
      limit,
      operation,
    };
  }

  private async page(
    sequence: Sequence,
    current: ConsumerCurrent,
    limit: number,
    signal: AbortSignal,
  ): Promise<Response> {
    consumerStage("reading source changes");
    if (sequence.reconciliation !== undefined)
      return this.reconcile(sequence, current, limit, signal);
    try {
      return await this.normalPage(sequence, current, limit, signal);
    } catch (error) {
      if (!(error instanceof ConsumerHttpError) || error.code !== "privacy_changed") throw error;
      const checkpoint = await this.pin(
        current,
        sequence.target.context.selection,
        signal,
        sequence.target,
      );
      return consumerErrorResponse(
        new ConsumerHttpError(409, "privacy_changed", error.message, {
          action: "reconcile",
          path: "/api/reconcile",
          cursor: this.options.codec.encode({
            ...sequence.cursor,
            reconciliation: { target: checkpoint.id },
          }),
        }),
      );
    }
  }

  private async reconcile(
    sequence: Sequence,
    current: ConsumerCurrent,
    limit: number,
    signal: AbortSignal,
  ): Promise<Response> {
    const checkpoint = sequence.reconciliation;
    if (checkpoint === undefined) throw invalidRoute();
    const result = await this.options.workers.run(
      await this.task(sequence, current, limit, "reconcile"),
      signal,
    );
    if (result.kind !== "reconcile") throw new Error("invalid reconciliation result");
    const next = await this.reconciliationCursor(sequence, result.page.next, current, signal);
    const pending = next.reconciliation !== undefined;
    return serializedConsumerResponse(
      consumerReconciliationEnvelopeSchema.parse({
        schema_version: 1,
        source: checkpoint.context.source,
        removals: result.page.removals,
        has_more: pending,
        next_cursor: pending ? this.options.codec.encode(next) : null,
        resume_cursor: pending ? null : this.options.codec.encode(next),
        resume_path: pending ? null : resumePath(next),
      }),
    );
  }

  private async reconciliationCursor(
    sequence: Sequence,
    after: RemovalPosition | undefined,
    current: ConsumerCurrent,
    signal: AbortSignal,
  ): Promise<ConsumerCursor> {
    const checkpoint = sequence.reconciliation;
    if (checkpoint === undefined) throw invalidRoute();
    if (after !== undefined)
      return { ...sequence.cursor, reconciliation: { target: checkpoint.id, after } };
    const cursor = { ...sequence.cursor, privacy: checkpoint.id };
    delete cursor.reconciliation;
    if (checkpoint.context.source !== current.boundary.source) {
      const next = await this.pin(current, sequence.target.context.selection, signal, checkpoint);
      cursor.reconciliation = { target: next.id };
    }
    return cursor;
  }

  private async normalPage(
    sequence: Sequence,
    current: ConsumerCurrent,
    limit: number,
    signal: AbortSignal,
  ): Promise<Response> {
    const { target, base, cursor } = sequence;
    const metadata = needsMetadata(cursor, target, base);
    // Pinning a changed source and reading its bodies need separate bounded reads.
    // Reuse the existing first-page marker even when metadata itself is unchanged.
    const boundary = needsBoundaryPage(cursor, target, base);
    // Boundary-only pages still enforce current privacy and source checks.
    const task = await this.task(sequence, current, boundary ? 1 : limit, "page");
    const result = await this.options.workers.run(
      { ...task, operation: boundary ? "privacy" : "page" },
      signal,
    );
    if (boundary)
      return this.changes(
        sequence,
        { ...cursor, metadata_sent: true },
        metadata
          ? [
              {
                type: "metadata",
                taxonomy: target.context.taxonomy,
                approved: target.context.registry.approved,
              },
            ]
          : [],
      );
    if (result.kind === "changes")
      return this.changes(sequence, result.step.cursor, result.step.changes);
    if (result.kind !== "history" || cursor.position.kind !== "history")
      throw new Error("invalid page worker result");
    return this.historyPage(sequence, result.page);
  }

  private historyPage(
    sequence: Sequence,
    page: Extract<
      import("./consumer-worker-task.js").ConsumerWorkerResult,
      { kind: "history" }
    >["page"],
  ): Response {
    const { target, cursor } = sequence;
    if (cursor.position.kind !== "history" || cursor.reconciliation !== undefined)
      throw invalidRoute();
    return serializedConsumerResponse(
      consumerHistoryEnvelopeSchema.parse({
        schema_version: 1,
        source: target.context.source,
        history_since: cursor.position.since,
        history_until: cursor.position.until,
        observations: page.observations,
        coverage: page.coverage,
        has_more: page.next !== undefined,
        next_cursor:
          page.next === undefined
            ? null
            : this.options.codec.encode({
                ...cursor,
                position: { ...cursor.position, after: page.next },
              }),
      }),
    );
  }

  private changes(
    sequence: Sequence,
    cursor: ConsumerCursor,
    changes: import("./consumer-page.js").ConsumerChange[],
  ): Response {
    const context = sequence.target.context;
    return serializedConsumerResponse(
      consumerChangesEnvelopeSchema.parse({
        schema_version: 1,
        source: context.source,
        complete_through: context.complete_through,
        observations_through: context.observations_through,
        history_since: context.history_since,
        history_until: consumerHistoryUntil(context),
        cursor: this.options.codec.encode(cursor),
        has_more: cursor.position.kind !== "idle",
        changes,
      }),
    );
  }
}
export function serializedConsumerResponse(body: unknown): Response {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > HARD_PAGE_BYTES) throw new OversizedConsumerSource();
  return new Response(serialized, {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function invalidRoute(): ConsumerHttpError {
  return new ConsumerHttpError(
    400,
    "cursor_conflict",
    "The cursor or query does not match this operation.",
  );
}

function needsBoundaryPage(
  cursor: ConsumerCursor,
  target: ResolvedConsumerContext,
  base?: ResolvedConsumerContext,
): boolean {
  return (
    needsMetadata(cursor, target, base) ||
    (cursor.position.kind !== "history" &&
      cursor.metadata_sent !== true &&
      base !== undefined &&
      base.context.source !== target.context.source)
  );
}

function needsMetadata(
  cursor: ConsumerCursor,
  target: ResolvedConsumerContext,
  base?: ResolvedConsumerContext,
): boolean {
  if (cursor.position.kind === "history" || cursor.metadata_sent === true) return false;
  return (
    base === undefined ||
    consumerMetadataHash(base.context) !== consumerMetadataHash(target.context)
  );
}

function containsSource(
  container: ResolvedConsumerContext,
  contained: ResolvedConsumerContext,
): boolean {
  const keys = new Set(container.snapshot.files.map((file) => file.key));
  return contained.snapshot.files.every((file) => keys.has(file.key));
}
function resumePath(cursor: ConsumerCursor): string {
  if (cursor.position.kind === "bootstrap") return "/api/units";
  return cursor.position.kind === "history" ? "/api/observations" : "/api/changes";
}
