import { z } from "zod";
import { bucketSnapshotSchema, canonicalBytes, sha256 } from "./bucket-log.js";
import type { BucketLog, BucketSnapshot, BucketSnapshotFile } from "./bucket-log.js";

const MAX_ADDITIONS = 1024;
const MAX_DESCRIPTOR_BYTES = 1_048_576;
export const consumerSourceSchema = z
  .object({
    base: z.string().regex(/^[a-f0-9]{64}$/u),
    additions: z.array(bucketSnapshotSchema.shape.files.element).max(MAX_ADDITIONS),
  })
  .strict();
export type ConsumerSource = z.infer<typeof consumerSourceSchema>;
type Base = { revision: string; snapshot: BucketSnapshot };
export class ConsumerSourceNotReady extends Error {
  constructor() {
    super("The current source metadata is not prepared yet.");
  }
}

/** Compact exact source membership. Bases use the existing immutable raw snapshot store.
 * There is no new mutable head: every context names its base and all additional files.
 * Only pass snapshots from the verified index advance, never from an HTTP request. */
export class ConsumerSourceStore {
  private base: Base | undefined;
  private readonly loaded = new Map<string, BucketSnapshot>();
  constructor(private readonly log: Pick<BucketLog, "loadSnapshot" | "storeSnapshot">) {}

  /** Run during index startup/refresh, outside the consumer HTTP deadline. */
  async prepare(input: BucketSnapshot): Promise<void> {
    const snapshot = bucketSnapshotSchema.parse(input);
    if (this.descriptor(snapshot) !== undefined) return;
    const saved = await this.log.storeSnapshot(snapshot);
    if (saved.revision !== sha256(canonicalBytes(snapshot)))
      throw new Error("consumer source base changed during storage");
    this.base = saved;
    this.remember(saved.revision, saved.snapshot);
  }

  describe(input: BucketSnapshot): { revision: string; source: ConsumerSource } {
    const snapshot = bucketSnapshotSchema.parse(input);
    const source = this.descriptor(snapshot);
    if (source === undefined) throw new ConsumerSourceNotReady();
    return { revision: sha256(canonicalBytes(snapshot)), source };
  }

  private descriptor(snapshot: BucketSnapshot): ConsumerSource | undefined {
    if (this.base === undefined) return undefined;
    const source = {
      base: this.base.revision,
      additions: difference(this.base.snapshot, snapshot),
    };
    return source.additions.length > MAX_ADDITIONS ||
      canonicalBytes(source).byteLength > MAX_DESCRIPTOR_BYTES
      ? undefined
      : source;
  }

  async resolve(revision: string, input: ConsumerSource): Promise<BucketSnapshot> {
    const source = consumerSourceSchema.parse(input);
    if (canonicalBytes(source).byteLength > MAX_DESCRIPTOR_BYTES)
      throw new Error("consumer source descriptor exceeds its byte bound");
    const base = this.loaded.get(source.base) ?? (await this.log.loadSnapshot(source.base));
    if (sha256(canonicalBytes(base)) !== source.base)
      throw new Error("consumer source base checksum mismatch");
    this.remember(source.base, base);
    const snapshot = bucketSnapshotSchema.parse({
      ...base,
      files: [...base.files, ...source.additions].sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
      ),
    });
    if (sha256(canonicalBytes(snapshot)) !== revision)
      throw new Error("consumer source membership checksum mismatch");
    return snapshot;
  }

  private remember(revision: string, snapshot: BucketSnapshot): void {
    this.loaded.delete(revision);
    this.loaded.set(revision, snapshot);
    if (this.loaded.size > 2) {
      const oldest = this.loaded.keys().next().value;
      if (oldest !== undefined) this.loaded.delete(oldest);
    }
  }
}

function difference(base: BucketSnapshot, target: BucketSnapshot): BucketSnapshotFile[] {
  if (base.bucket !== target.bucket) throw new Error("consumer raw Bucket changed");
  const files = new Map(target.files.map((file) => [file.key, file]));
  for (const file of base.files) {
    const current = files.get(file.key);
    if (
      current === undefined ||
      !Buffer.from(canonicalBytes(current)).equals(Buffer.from(canonicalBytes(file)))
    )
      throw new Error("consumer source removed or changed an immutable file");
    files.delete(file.key);
  }
  return [...files.values()];
}
