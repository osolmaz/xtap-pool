export type BoundedProgress = (completed: number, total: number) => Promise<void>;

export async function mapBatchesInOrder<Input, Output>(options: {
  inputs: readonly Input[];
  concurrency: number;
  operation: (input: Input) => Promise<Output>;
  progress?: BoundedProgress;
}): Promise<Output[]> {
  const concurrency = requireConcurrency(options.concurrency);
  const results: Output[] = [];
  for (let offset = 0; offset < options.inputs.length; offset += concurrency) {
    const batch = options.inputs.slice(offset, offset + concurrency);
    const loaded = await Promise.all(batch.map(async (input) => options.operation(input)));
    results.push(...loaded);
    await options.progress?.(results.length, options.inputs.length);
  }
  if (options.inputs.length === 0) await options.progress?.(0, 0);
  return results;
}

export async function consumeBatchesInOrder<Input, Output>(options: {
  inputs: readonly Input[];
  concurrency: number;
  load: (input: Input) => Promise<Output>;
  consume: (output: Output, input: Input) => Promise<void>;
  progress?: BoundedProgress;
}): Promise<void> {
  const concurrency = requireConcurrency(options.concurrency);
  let completed = 0;
  for (let offset = 0; offset < options.inputs.length; offset += concurrency) {
    const batch = options.inputs.slice(offset, offset + concurrency);
    const loaded = await Promise.all(batch.map(async (input) => options.load(input)));
    for (const [index, output] of loaded.entries()) {
      const input = batch[index];
      if (input === undefined) throw new Error("bounded batch input is missing");
      await options.consume(output, input);
      completed += 1;
    }
    await options.progress?.(completed, options.inputs.length);
  }
  if (options.inputs.length === 0) await options.progress?.(0, 0);
}

function requireConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("concurrency must be a positive safe integer");
  }
  return value;
}
