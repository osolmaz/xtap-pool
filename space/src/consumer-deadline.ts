import { AsyncLocalStorage } from "node:async_hooks";
import { ConsumerHttpError } from "./consumer-errors.js";

export const CONSUMER_DEADLINE_MS = 30_000;
const signals = new AsyncLocalStorage<AbortSignal>();
export function consumerTimeout(): ConsumerHttpError {
  return new ConsumerHttpError(
    503,
    "deadline_exceeded",
    "The consumer read deadline expired. Retry the same cursor.",
  );
}
/** Async IO cancellation only. SQLite runs in a killable child process. */
export async function withConsumerDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  requestSignal: AbortSignal,
  milliseconds = CONSUMER_DEADLINE_MS,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, requestSignal]);
  const timer = setTimeout(() => {
    controller.abort(consumerTimeout());
  }, milliseconds);
  try {
    return await signals.run(signal, () => abortable(operation(signal), signal));
  } finally {
    clearTimeout(timer);
  }
}
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(consumerTimeout());
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
  const signal = signals.getStore();
  if (signal === undefined) return fetch(input, init);
  signal.throwIfAborted();
  const original = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return fetch(input, {
    ...init,
    signal: original == null ? signal : AbortSignal.any([signal, original]),
  });
};
