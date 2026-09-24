import { AsyncLocalStorage } from "node:async_hooks";
import { ConsumerHttpError } from "./consumer-errors.js";

export const CONSUMER_DEADLINE_MS = 60_000;
/** A changed source can require an exact full-selection coverage calculation or
 * large change pages. The long stages renew the request's deadline. A coverage
 * calculation over a large selection passes five minutes and an abandoned read
 * kills its worker before it can pin the context, so the bound is generous.
 * SQLite remains in the same killable child process and every other read keeps
 * the short bound. */
export const CONSUMER_LONG_READ_DEADLINE_MS = 15 * 60_000;
type Stage =
  | "waiting for the index"
  | "loading source metadata"
  | "calculating source coverage"
  | "saving source metadata"
  | "reading source changes"
  | "reading source page";
/** A read acquires the index mutex before it can load source metadata, so the
 * queue wait needs the long bound too. A single read can wait for the index and
 * then compute coverage, so each long stage renews the bound instead of
 * consuming one shared budget from the first stage. */
const LONG_READ_STAGES = new Set<Stage>([
  "waiting for the index",
  "calculating source coverage",
  "reading source changes",
]);
type DeadlineContext = {
  signal: AbortSignal;
  stage?: Stage;
  extendDeadline: () => void;
};
const signals = new AsyncLocalStorage<DeadlineContext>();
export function consumerStage(stage: Stage): void {
  const context = signals.getStore();
  if (context === undefined) return;
  context.stage = stage;
  if (LONG_READ_STAGES.has(stage)) context.extendDeadline();
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
    longReadMilliseconds?: number;
  } = {},
): Promise<T> {
  const milliseconds = limits.milliseconds ?? CONSUMER_DEADLINE_MS;
  const longReadMilliseconds = limits.longReadMilliseconds ?? CONSUMER_LONG_READ_DEADLINE_MS;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, requestSignal]);
  let timer: ReturnType<typeof setTimeout>;
  const context: DeadlineContext = {
    signal,
    extendDeadline: () => {
      clearTimeout(timer);
      timer = deadlineTimer(controller, context, longReadMilliseconds);
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
