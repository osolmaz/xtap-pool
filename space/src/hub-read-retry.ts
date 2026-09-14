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
  if (isCancelledRead(error)) return false;
  if (!(error instanceof HubApiError)) return true;
  return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
}

function isCancelledRead(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return "code" in error && error.code === "deadline_exceeded";
}

function defaultHubReadRetryWait(failedAttempt: number): Promise<void> {
  const delayMs = 250 * 2 ** (failedAttempt - 1);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
