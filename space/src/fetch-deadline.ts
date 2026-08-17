export class DeadlineExceededError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`request deadline exceeded after ${String(timeoutMs)} ms`);
    this.name = "DeadlineExceededError";
  }
}

export class ResponseBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response body exceeded ${String(maxBytes)} bytes`);
    this.name = "ResponseBodyTooLargeError";
  }
}

/** Run the complete request lifecycle under one deadline. */
export async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineExceededError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof DeadlineExceededError)) {
      throw new DeadlineExceededError(timeoutMs);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function responseChunk(result: unknown): Uint8Array | undefined {
  if (
    typeof result !== "object" ||
    result === null ||
    !("done" in result) ||
    typeof result.done !== "boolean"
  ) {
    throw new TypeError("response body returned an invalid read result");
  }
  if (result.done) return undefined;
  if (!("value" in result) || !(result.value instanceof Uint8Array)) {
    throw new TypeError("response body returned a non-byte chunk");
  }
  return result.value;
}

/** Read one response body without allowing unbounded buffering. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const chunk = responseChunk(await reader.read());
      if (chunk === undefined) break;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
