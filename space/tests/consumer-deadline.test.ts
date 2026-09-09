import { afterEach, expect, it, vi } from "vitest";
import { consumerStage, withConsumerDeadline } from "../src/consumer-deadline.js";

afterEach(() => vi.useRealTimers());

function pending(): Promise<never> {
  return new Promise(() => undefined);
}

it("reports the stage where a read exhausted its unchanged deadline", async () => {
  vi.useFakeTimers();
  const read = withConsumerDeadline(
    () => {
      consumerStage("calculating source coverage");
      return pending();
    },
    new AbortController().signal,
    20,
  );
  const checked = expect(read).rejects.toMatchObject({
    code: "deadline_exceeded",
    message:
      "The consumer read deadline expired while calculating source coverage. Retry the same cursor.",
  });
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
      20,
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
