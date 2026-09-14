import { Buffer } from "node:buffer";

import {
  checkpointClaimPrefix,
  type CheckpointAdapter,
  type CheckpointBoundary,
  type CheckpointManifest,
  type CheckpointObjectStore,
  type CheckpointPayload,
  type JsonValue,
} from "@osolmaz/hf-job-control";
import { downloadFile, HubApiError, listFiles, uploadFile } from "@huggingface/hub";

import { mapBatchesInOrder } from "./bounded-concurrency.js";
import {
  enrichmentCheckpointMetadataSchema,
  serializeEnrichmentMetadata,
  validateEnrichmentState,
} from "./enrich-state.js";
import type { EnrichmentCheckpointState } from "./enrich-state.js";
import { canonicalPlanBytes } from "./enrich-run-plan.js";

const METADATA_PATH = "state.json";
const BITMAP_PATH = "queue-completed.bin";
const CHECKPOINT_READ_ATTEMPTS = 3;

type EnrichmentCheckpointStoreOptions = {
  bucket: string;
  accessToken: string;
  fetcher?: typeof fetch;
  waitBeforeReadRetry?: (failedAttempt: number) => Promise<void>;
};

export type EnrichmentRestoreEvidence = Readonly<Record<string, JsonValue>> & {
  sequence: number;
  queue_done: number;
  registry_next_ordinal: number;
};

export function createEnrichmentCheckpointStore(
  options: EnrichmentCheckpointStoreOptions,
): CheckpointObjectStore {
  const reader = createCheckpointReader(options);
  const repo = { type: "bucket", name: options.bucket } as const;
  const upload = async (path: string, bytes: Uint8Array): Promise<void> => {
    await uploadFile({
      repo,
      accessToken: options.accessToken,
      file: { path, content: new Blob([Buffer.from(bytes)]) },
      commitTitle: `Publish ${path}`,
    });
  };
  return {
    ...reader,
    async writeImmutable(path, bytes): Promise<void> {
      const existing = await reader.read(path);
      if (existing !== null) {
        if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
          throw new Error(`immutable checkpoint object differs: ${path}`);
        }
        return;
      }
      await upload(path, bytes);
      const stored = await reader.read(path);
      if (stored === null || !Buffer.from(stored).equals(Buffer.from(bytes))) {
        throw new Error(`checkpoint object read-back mismatch: ${path}`);
      }
    },
    async writePointerHint(path, bytes): Promise<void> {
      await upload(path, bytes);
    },
  };
}

export function createReadOnlyEnrichmentCheckpointStore(
  options: EnrichmentCheckpointStoreOptions,
): CheckpointObjectStore {
  return {
    ...createCheckpointReader(options),
    writeImmutable(): Promise<void> {
      return Promise.reject(new Error("checkpoint store is read-only"));
    },
    writePointerHint(): Promise<void> {
      return Promise.resolve();
    },
  };
}

export function withCheckpointClaimPrefetch(
  store: CheckpointObjectStore,
  options: {
    runId: string;
    prefix: string;
    concurrency: number;
    progress?: (completed: number, total: number) => Promise<void>;
  },
): CheckpointObjectStore {
  const claimsPrefix = checkpointClaimPrefix(options.prefix, options.runId);
  const cache = new Map<string, Uint8Array>();
  return {
    bucketId: store.bucketId,
    async read(path): Promise<Uint8Array | null> {
      const cached = cache.get(path);
      return cached === undefined ? store.read(path) : Uint8Array.from(cached);
    },
    async list(prefix): Promise<readonly string[]> {
      const keys = await store.list(prefix);
      if (prefix !== claimsPrefix) return keys;
      await mapBatchesInOrder({
        inputs: keys,
        concurrency: options.concurrency,
        operation: async (key) => {
          if (cache.has(key)) return;
          const value = await store.read(key);
          if (value === null) throw new Error(`checkpoint claim disappeared: ${key}`);
          cache.set(key, Uint8Array.from(value));
        },
        ...(options.progress === undefined ? {} : { progress: options.progress }),
      });
      return keys;
    },
    async writeImmutable(path, bytes): Promise<void> {
      await store.writeImmutable(path, bytes);
      if (path.startsWith(claimsPrefix)) cache.set(path, Uint8Array.from(bytes));
    },
    writePointerHint(path, bytes): Promise<void> {
      return store.writePointerHint(path, bytes);
    },
  };
}

function createCheckpointReader(
  options: EnrichmentCheckpointStoreOptions,
): Pick<CheckpointObjectStore, "bucketId" | "read" | "list"> {
  const repo = { type: "bucket", name: options.bucket } as const;
  const transport = options.fetcher === undefined ? {} : { fetch: options.fetcher };
  const waitBeforeRetry = options.waitBeforeReadRetry ?? defaultCheckpointReadRetryWait;
  return {
    bucketId: options.bucket,
    read(path): Promise<Uint8Array | null> {
      return retryCheckpointRead(async () => {
        try {
          const blob = await downloadFile({
            repo,
            ...transport,
            accessToken: options.accessToken,
            path,
            xet: false,
          });
          return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
        } catch (error) {
          if (error instanceof HubApiError && error.statusCode === 404) return null;
          throw error;
        }
      }, waitBeforeRetry);
    },
    list(prefix): Promise<readonly string[]> {
      return retryCheckpointRead(async () => {
        const paths: string[] = [];
        try {
          for await (const entry of listFiles({
            repo,
            ...transport,
            accessToken: options.accessToken,
            recursive: true,
            path: prefix,
            expand: false,
          })) {
            if (entry.type === "file") paths.push(entry.path);
          }
        } catch (error) {
          if (error instanceof HubApiError && error.statusCode === 404) return [];
          throw error;
        }
        return paths.sort();
      }, waitBeforeRetry);
    },
  };
}

async function retryCheckpointRead<T>(
  operation: () => Promise<T>,
  waitBeforeRetry: (failedAttempt: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 1; attempt <= CHECKPOINT_READ_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === CHECKPOINT_READ_ATTEMPTS || !isRetryableCheckpointReadError(error)) {
        throw error;
      }
      await waitBeforeRetry(attempt);
    }
  }
  throw new Error("checkpoint read exhausted its retry bound");
}

function isRetryableCheckpointReadError(error: unknown): boolean {
  if (!(error instanceof HubApiError)) return true;
  return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
}

function defaultCheckpointReadRetryWait(failedAttempt: number): Promise<void> {
  const delayMs = 250 * 2 ** (failedAttempt - 1);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class EnrichmentCheckpointAdapter implements CheckpointAdapter<EnrichmentRestoreEvidence> {
  readonly spec = {
    name: "xtap-enrichment",
    version: 1,
    resume_mode: "boundary" as const,
  };
  #state: EnrichmentCheckpointState;

  constructor(state: EnrichmentCheckpointState) {
    this.#state = validateEnrichmentState(state);
  }

  get state(): EnrichmentCheckpointState {
    return validateEnrichmentState(this.#state);
  }

  replace(state: EnrichmentCheckpointState): void {
    this.#state = validateEnrichmentState(state);
  }

  save(boundary: CheckpointBoundary): Promise<readonly CheckpointPayload[]> {
    if (boundary.sequence !== this.#state.sequence) {
      throw new Error("checkpoint boundary does not match enrichment state sequence");
    }
    return Promise.resolve([
      {
        path: METADATA_PATH,
        bytes: canonicalPlanBytes(serializeEnrichmentMetadata(this.#state)),
      },
      {
        path: BITMAP_PATH,
        bytes: Uint8Array.from(this.#state.completed_bitmap),
      },
    ]);
  }

  restore(
    manifest: CheckpointManifest,
    payloads: ReadonlyMap<string, Uint8Array>,
  ): Promise<EnrichmentRestoreEvidence> {
    const metadataBytes = payloads.get(METADATA_PATH);
    const bitmap = payloads.get(BITMAP_PATH);
    if (metadataBytes === undefined || bitmap === undefined || payloads.size !== 2) {
      throw new Error("enrichment checkpoint payload set is invalid");
    }
    const parsed: unknown = JSON.parse(Buffer.from(metadataBytes).toString("utf8"));
    const metadata = enrichmentCheckpointMetadataSchema.parse(parsed);
    if (
      metadata.run_id !== manifest.run_id ||
      metadata.plan_sha256 !== manifest.plan_sha256 ||
      metadata.sequence !== manifest.boundary.sequence
    ) {
      throw new Error("enrichment checkpoint identity mismatch");
    }
    this.#state = validateEnrichmentState({
      ...metadata,
      completed_bitmap: bitmap,
    });
    return Promise.resolve({
      sequence: this.#state.sequence,
      queue_done: this.#state.queue.done,
      registry_next_ordinal: this.#state.registry.next_ordinal,
    });
  }
}
