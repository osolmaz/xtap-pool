import { afterEach, expect, it, vi } from "vitest";
import {
  CONSUMER_DEADLINE_MS,
  CONSUMER_LONG_READ_DEADLINE_MS,
  consumerStage,
  withConsumerDeadline,
} from "../src/consumer-deadline.js";

afterEach(() => vi.useRealTimers());

it("keeps a bounded production deadline for long source reads", () => {
  expect(CONSUMER_DEADLINE_MS).toBe(60_000);
  expect(CONSUMER_LONG_READ_DEADLINE_MS).toBe(5 * 60_000);
});

function pending(): Promise<never> {
  return new Promise(() => undefined);
}

it.each(["calculating source coverage" as const, "reading source changes" as const])(
  "reports the stage where %s exhausted its long-read deadline",
  async (stage) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const read = withConsumerDeadline(
      (active) => {
        signal = active;
        consumerStage(stage);
        return pending();
      },
      new AbortController().signal,
      { milliseconds: 20, longReadMilliseconds: 50 },
    );
    const checked = expect(read).rejects.toMatchObject({
      code: "deadline_exceeded",
      message: `The consumer read deadline expired while ${stage}. Retry the same cursor.`,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    await checked;
  },
);

it("keeps ordinary source pages on the short deadline", async () => {
  vi.useFakeTimers();
  const read = withConsumerDeadline(
    () => {
      consumerStage("reading source page");
      return pending();
    },
    new AbortController().signal,
    { milliseconds: 20, longReadMilliseconds: 50 },
  );
  const checked = expect(read).rejects.toThrow("while reading source page");
  await vi.advanceTimersByTimeAsync(20);
  await checked;
});

it("keeps stage names separate for concurrent requests", async () => {
  vi.useFakeTimers();
  const reads = ["loading source metadata", "saving source metadata"].map((stage) =>
    withConsumerDeadline(
      () => {
        consumerStage(stage === "loading source metadata" ? stage : "saving source metadata");
        return pending();
      },
      new AbortController().signal,
      { milliseconds: 20, longReadMilliseconds: 50 },
    ),
  );
  const checked = Promise.all([
    expect(reads[0]).rejects.toThrow("while loading source metadata"),
    expect(reads[1]).rejects.toThrow("while saving source metadata"),
  ]);
  await vi.advanceTimersByTimeAsync(20);
  await checked;
});

it("does not expose an external request's abort reason", async () => {
  const request = new AbortController();
  const read = withConsumerDeadline(pending, request.signal);
  const checked = expect(read).rejects.toMatchObject({
    code: "deadline_exceeded",
    message: "The consumer read deadline expired. Retry the same cursor.",
  });
  request.abort(new Error("private external detail"));
  await checked;
});
