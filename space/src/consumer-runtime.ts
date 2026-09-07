import { stat } from "node:fs/promises";
import { canonicalJson } from "@xtap-pool/shared";
import type {
  ConsumerContextStore,
  ConsumerSelection,
  ResolvedConsumerContext,
} from "./consumer-context.js";
import { consumerHistoryUntil, consumerMetadataHash } from "./consumer-context.js";
import type { ConsumerCursor, ConsumerCursorCodec } from "./consumer-cursor.js";
import { ConsumerHttpError } from "./consumer-errors.js";
import { abortable, withConsumerDeadline } from "./consumer-deadline.js";
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
      return await this.options.locked(async () => {
        signal.throwIfAborted();
        authorize();
        const current = this.options.current();
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
    if (route === "history") return this.historySequence(query, signal);
    const token = query.get(route === "bootstrap" ? "cursor" : "after");
    if (token === null) {
      if (route === "changes")
        throw new ConsumerHttpError(400, "cursor_required", "Changes requires after.");
      const target = await this.pin(current, initialSelection(query), signal);
      return { target, cursor: this.start(target, null, "bootstrap") };
    }
    const cursor = this.options.codec.decode(token);
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
      const next = await this.pin(current, target.context.selection, signal);
      return { target: next, base: target, cursor: this.start(next, target.id, "content") };
    }
    if (cursor.base === null || cursor.position.kind === "history") throw invalidRoute();
    const base = await abortable(this.options.contexts.read(cursor.base), signal);
    return { target, base, cursor };
  }

  private async historySequence(query: URLSearchParams, signal: AbortSignal): Promise<Sequence> {
    const token = query.get("cursor");
    if (token !== null) {
      const cursor = this.options.codec.decode(token);
      if (cursor.position.kind !== "history") throw invalidRoute();
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
    const consumed = this.options.codec.decode(at);
    if (consumed.position.kind !== "idle") throw invalidRoute();
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
    const coverage = await this.options.workers.run(
      await this.task(
        { target: draft, cursor: this.start(draft, null, "bootstrap") },
        current,
        1,
        "coverage",
      ),
      signal,
    );
    if (coverage.kind !== "coverage") throw new Error("invalid coverage worker result");
    signal.throwIfAborted();
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
    const { target, base, cursor } = sequence;
    const metadata = needsMetadata(cursor, target, base);
    // Even a metadata-only page must run the current privacy and source checks.
    const task = await this.task(sequence, current, metadata ? 1 : limit, "page");
    const result = await this.options.workers.run(
      { ...task, operation: metadata ? "privacy" : "page" },
      signal,
    );
    if (metadata)
      return this.changes(sequence, { ...cursor, metadata_sent: true }, [
        {
          type: "metadata",
          taxonomy: target.context.taxonomy,
          approved: target.context.registry.approved,
        },
      ]);
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
    if (cursor.position.kind !== "history") throw invalidRoute();
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
