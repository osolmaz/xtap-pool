import { ZodError } from "zod";
import { ConsumerSourceNotReady } from "./consumer-source.js";
import {
  ConsumerContractChanged,
  ExpiredConsumerCursor,
  InvalidConsumerCursor,
} from "./consumer-cursor.js";
import { ConsumerBootstrapRequired } from "./consumer-index-state.js";
import { OversizedConsumerSource } from "./consumer-page.js";
import { HistoricalReadLimitError } from "./historical-unit-reader.js";

export class ConsumerHttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409 | 410 | 413 | 429 | 502 | 503,
    readonly code: string,
    message: string,
    readonly recovery?: unknown,
  ) {
    super(message);
  }
}
export function consumerError(error: unknown): ConsumerHttpError {
  if (error instanceof ConsumerHttpError) return error;
  if (error instanceof InvalidConsumerCursor || error instanceof ZodError)
    return new ConsumerHttpError(400, "invalid_request", "Invalid consumer query or cursor.");
  if (error instanceof ConsumerContractChanged)
    return new ConsumerHttpError(409, "contract_changed", error.message, {
      action: "explicit_bootstrap",
    });
  if (error instanceof ExpiredConsumerCursor)
    return new ConsumerHttpError(410, "cursor_expired", error.message, {
      action: "explicit_bootstrap",
    });
  if (isSourceStateError(error)) return sourceStateError(error);
  if (isSourceLimit(error))
    return new ConsumerHttpError(
      413,
      "source_item_too_large",
      "A complete source item exceeds the read bound.",
    );
  return new ConsumerHttpError(
    502,
    "source_unavailable",
    "The verified source could not be read. Retry the same cursor.",
  );
}
export function consumerErrorResponse(error: unknown): Response {
  const failure = consumerError(error);
  return Response.json(
    {
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.recovery === undefined ? {} : { recovery: failure.recovery }),
      },
    },
    {
      status: failure.status,
      headers: {
        "Cache-Control": "no-store",
        ...(failure.status === 429 || failure.status === 503 ? { "Retry-After": "5" } : {}),
      },
    },
  );
}

function isSourceStateError(
  error: unknown,
): error is ConsumerSourceNotReady | ConsumerBootstrapRequired {
  return error instanceof ConsumerSourceNotReady || error instanceof ConsumerBootstrapRequired;
}
function sourceStateError(
  error: ConsumerSourceNotReady | ConsumerBootstrapRequired,
): ConsumerHttpError {
  const code =
    error instanceof ConsumerSourceNotReady ? "source_not_ready" : "projection_unavailable";
  return new ConsumerHttpError(503, code, error.message);
}

function isSourceLimit(error: unknown): boolean {
  return error instanceof OversizedConsumerSource || error instanceof HistoricalReadLimitError;
}
