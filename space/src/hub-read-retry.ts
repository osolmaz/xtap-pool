import { HubApiError, InvalidApiResponseFormatError } from "@huggingface/hub";

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
  if (isCancelledRead(error)) return false;
  if (error instanceof HubApiError) {
    return (
      error.statusCode === 408 ||
      error.statusCode === 429 ||
      error.statusCode === 499 ||
      error.statusCode >= 500
    );
  }
  if (error instanceof InvalidApiResponseFormatError) return true;
  return isTransientNetworkError(error);
}

function isCancelledRead(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (
      (current instanceof Error &&
        (current.name === "AbortError" || current.name === "TimeoutError")) ||
      errorCode(current) === "deadline_exceeded"
    ) {
      return true;
    }
    current = errorCause(current);
  }
  return false;
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
  const code = errorCode(error);
  return code !== undefined && TRANSIENT_NETWORK_CODES.has(code);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
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
