export type DatasetState = { state: "ready" } | { state: "invalid" | "unknown"; error: string };

/** Classify non-authentication failures while rebuilding dataset-backed caches. */
export function datasetStateFromRebuildError(error: unknown): DatasetState {
  const status = errorStatus(error);
  const state =
    error instanceof TypeError ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500)
      ? "unknown"
      : "invalid";
  return { state, error: errorMessage(error) };
}

export function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
