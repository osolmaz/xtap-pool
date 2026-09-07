import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { consumerError, ConsumerHttpError } from "./consumer-errors.js";
import { consumerTimeout } from "./consumer-deadline.js";
import { workerResultSchema } from "./consumer-worker-task.js";
import type { ConsumerWorkerTask, ConsumerWorkerResult } from "./consumer-worker-task.js";

const failureSchema = z.object({
  ok: z.literal(false),
  status: z.union([
    z.literal(400),
    z.literal(409),
    z.literal(410),
    z.literal(413),
    z.literal(502),
    z.literal(503),
  ]),
  code: z.string(),
  message: z.string(),
  recovery: z.unknown().optional(),
});
type Slot = { child: ChildProcess; busy: boolean };
/** Fixed process pool. SIGKILL interrupts native SQLite too; Worker.terminate and
 * a main-thread Promise race cannot provide this guarantee. No database copies. */
export class ConsumerWorkers {
  private readonly slots = new Set<Slot>();
  private closed = false;
  constructor(
    private readonly maximum = 2,
    private readonly script = workerScript(),
  ) {
    z.number().int().min(1).max(2).parse(maximum);
  }
  async run(task: ConsumerWorkerTask, signal: AbortSignal): Promise<ConsumerWorkerResult> {
    if (signal.aborted) throw consumerTimeout();
    if (this.closed)
      throw new ConsumerHttpError(503, "worker_unavailable", "Consumer workers are closed.");
    const slot = this.reserve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        slot.child.removeListener("message", message);
        slot.child.removeListener("exit", exit);
        slot.child.removeListener("error", fail);
      };
      const fail = () => {
        cleanup();
        this.kill(slot);
        reject(
          new ConsumerHttpError(
            503,
            "worker_unavailable",
            "The consumer worker stopped. Retry the same cursor.",
          ),
        );
      };
      const exit = () => {
        fail();
      };
      const abort = () => {
        cleanup();
        this.kill(slot);
        reject(consumerTimeout());
      };
      const message = (raw: unknown) => {
        cleanup();
        slot.busy = false;
        try {
          const failed = failureSchema.safeParse(raw);
          if (failed.success)
            throw new ConsumerHttpError(
              failed.data.status,
              failed.data.code,
              failed.data.message,
              failed.data.recovery,
            );
          resolve(z.object({ ok: z.literal(true), result: workerResultSchema }).parse(raw).result);
        } catch (error) {
          reject(consumerError(error));
        }
      };
      slot.child.once("message", message);
      slot.child.once("exit", exit);
      slot.child.once("error", fail);
      signal.addEventListener("abort", abort, { once: true });
      slot.child.send(task, (error) => {
        if (error !== null) fail();
      });
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.slots].map(
        (slot) =>
          new Promise<void>((resolve) => {
            slot.child.once("exit", () => {
              resolve();
            });
            this.kill(slot);
          }),
      ),
    );
  }
  private reserve(): Slot {
    const idle = [...this.slots].find((slot) => !slot.busy);
    if (idle !== undefined) {
      idle.busy = true;
      return idle;
    }
    if (this.slots.size >= this.maximum)
      throw new ConsumerHttpError(
        429,
        "consumer_busy",
        "Consumer read capacity is full. Retry the same cursor.",
      );
    const child = fork(this.script, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {},
      execArgv: [],
    });
    const slot = { child, busy: true };
    this.slots.add(slot);
    child.once("exit", () => this.slots.delete(slot));
    return slot;
  }
  private kill(slot: Slot): void {
    slot.busy = true;
    slot.child.kill("SIGKILL");
  }
}
function workerScript(): URL {
  const compiled = new URL("./consumer-worker-main.js", import.meta.url);
  return existsSync(compiled)
    ? compiled
    : new URL("../dist/src/consumer-worker-main.js", import.meta.url);
}
