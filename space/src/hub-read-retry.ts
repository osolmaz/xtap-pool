import { HubApiError } from "@huggingface/hub";

const HUB_READ_ATTEMPTS = 3;

export async function retryTransientHubRead<T>(
  operation: () => Promise<T>,
  waitBeforeRetry: (failedAttempt: number) => Promise<void> = defaultHubReadRetryWait,
): Promise<T> {
  for (let attempt = 1; attempt <= HUB_READ_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === HUB_READ_ATTEMPTS || !isRetryableHubReadError(error)) {
        throw error;
      }
      await waitBeforeRetry(attempt);
    }
  }
  throw new Error("Hub read exhausted its retry bound");
}

function isRetryableHubReadError(error: unknown): boolean {
  if (error instanceof HubApiError) {
    return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
  }
  return isTransientNetworkError(error);
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (hasTransientNetworkCode(current)) return true;
    current = errorCause(current);
  }
  return false;
}

function hasTransientNetworkCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    TRANSIENT_NETWORK_CODES.has(error.code)
  );
}

function errorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) return undefined;
  return error.cause;
}

const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETRESET",
  "ENETUNREACH",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function defaultHubReadRetryWait(failedAttempt: number): Promise<void> {
  const delayMs = 250 * 2 ** (failedAttempt - 1);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
