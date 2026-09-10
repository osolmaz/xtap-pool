import { AsyncLocalStorage } from "node:async_hooks";
import { ConsumerHttpError } from "./consumer-errors.js";

export const CONSUMER_DEADLINE_MS = 60_000;
/** A changed source can require an exact full-selection coverage calculation.
 * Only that stage extends the request's absolute deadline. SQLite remains in
 * the same killable child process and every other read keeps the short bound. */
export const CONSUMER_COVERAGE_DEADLINE_MS = 5 * 60_000;
type Stage =
  | "waiting for the index"
  | "loading source metadata"
  | "calculating source coverage"
  | "saving source metadata"
  | "reading source changes";
type DeadlineContext = {
  signal: AbortSignal;
  stage?: Stage;
  extendForCoverage: () => void;
};
const signals = new AsyncLocalStorage<DeadlineContext>();
export function consumerStage(stage: Stage): void {
  const context = signals.getStore();
  if (context === undefined) return;
  context.stage = stage;
  if (stage === "calculating source coverage") context.extendForCoverage();
}
export function consumerTimeout(stage?: Stage): ConsumerHttpError {
  return new ConsumerHttpError(
    503,
    "deadline_exceeded",
    `The consumer read deadline expired${stage === undefined ? "" : ` while ${stage}`}. Retry the same cursor.`,
  );
}
/** Async IO cancellation only. SQLite runs in a killable child process. */
export async function withConsumerDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  requestSignal: AbortSignal,
  limits: {
    milliseconds?: number;
    coverageMilliseconds?: number;
  } = {},
): Promise<T> {
  const milliseconds = limits.milliseconds ?? CONSUMER_DEADLINE_MS;
  const coverageMilliseconds = limits.coverageMilliseconds ?? CONSUMER_COVERAGE_DEADLINE_MS;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, requestSignal]);
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  let coverageExtended = false;
  const context: DeadlineContext = {
    signal,
    extendForCoverage: () => {
      if (coverageExtended) return;
      coverageExtended = true;
      clearTimeout(timer);
      timer = deadlineTimer(controller, context, coverageMilliseconds - (Date.now() - started));
    },
  };
  timer = deadlineTimer(controller, context, milliseconds);
  try {
    return await signals.run(context, () => abortable(operation(signal), signal));
  } finally {
    clearTimeout(timer);
  }
}
function deadlineTimer(
  controller: AbortController,
  context: Pick<DeadlineContext, "stage">,
  milliseconds: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(
    () => {
      controller.abort(consumerTimeout(context.stage));
    },
    Math.max(0, milliseconds),
  );
}
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(
        signal.reason instanceof ConsumerHttpError && signal.reason.code === "deadline_exceeded"
          ? signal.reason
          : consumerTimeout(),
      );
    };
    if (signal.aborted) {
      void operation.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
/** Passed to the existing Bucket adapters. All SDK fetches, including retries and
 * blob body reads, share the endpoint's absolute deadline. No retry gets a new clock. */
export const consumerFetch: typeof fetch = (input, init) => {
  const signal = signals.getStore()?.signal;
  if (signal === undefined) return fetch(input, init);
  signal.throwIfAborted();
  const original = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return fetch(input, {
    ...init,
    signal: original == null ? signal : AbortSignal.any([signal, original]),
  });
};
