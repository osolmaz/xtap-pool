import { Buffer } from "node:buffer";

import {
  ObjectProgressStore,
  ProgressReporter,
  TransientProgressError,
} from "@osolmaz/hf-job-control";
import type { ProgressObjectStore, ProgressStatus, ProgressTrack } from "@osolmaz/hf-job-control";
import { downloadFile, HubApiError, listFiles, uploadFile } from "@huggingface/hub";
import type { QueueDepth } from "@xtap-pool/shared";

const TRACKS = [
  "taxonomy-load",
  "index-restore",
  "source-replay",
  "working-copy",
  "checkpoint-claims",
  "output-claims",
  "checkpoint-replay",
  "enrichment-queue",
  "enrichment-successful",
  "enrichment-blocked",
  "registry-scan",
  "receipt-publication",
  "database-build",
  "database-upload",
  "database-verify",
  "manifest-publication",
] as const;

type TrackKey = (typeof TRACKS)[number];

type TrackUpdate = {
  planId?: string;
  status?: ProgressStatus;
  completed?: number;
  total?: number;
  unit?: string;
  sourceUpdatedAt?: string;
};

export class XTapJobProgress {
  readonly #reporter: ProgressReporter;
  readonly #basePlanId: string;
  readonly #attemptPlanId: string;
  #sourcePlanId: string;

  private constructor(reporter: ProgressReporter, basePlanId: string, attemptPlanId: string) {
    this.#reporter = reporter;
    this.#basePlanId = basePlanId;
    this.#attemptPlanId = attemptPlanId;
    this.#sourcePlanId = basePlanId;
  }

  static async create(options: {
    bucket: string;
    accessToken: string;
    sourceRevision: string;
    contractHash: string;
    env: Readonly<Record<string, string | undefined>>;
    objectStore?: ProgressObjectStore;
  }): Promise<XTapJobProgress> {
    const attemptId = options.env["JOB_ID"] ?? `local-${process.pid.toString()}`;
    const runId = options.env["XTAP_PROGRESS_RUN_ID"] ?? "xtap-enrichment-v1";
    const objectStore =
      options.objectStore ?? createProgressObjectStore(options.bucket, options.accessToken);
    const reporter = await ProgressReporter.create({
      runId,
      attemptId,
      ...(options.env["JOB_ID"] === undefined ? {} : { jobId: options.env["JOB_ID"] }),
      input: {
        revision: options.sourceRevision,
        contract_sha256: options.contractHash,
      },
      store: new ObjectProgressStore(objectStore),
    });
    const basePlanId = `contract-${options.contractHash.slice(0, 16)}`;
    const existing = new Set(reporter.tracks.map((track) => track.key));
    const missing = TRACKS.filter((key) => !existing.has(key)).map((key) =>
      initialTrack(key, basePlanId),
    );
    if (missing.length > 0) reporter.plan(missing);
    reporter.setState("running");
    const progress = new XTapJobProgress(reporter, basePlanId, `attempt-${attemptId}`);
    await progress.update(
      "taxonomy-load",
      {
        planId: `taxonomy-${progress.#attemptPlanId.slice(-48)}`,
        status: "completed",
        completed: 1,
        total: 1,
        unit: "steps",
      },
      true,
    );
    return progress;
  }

  async restoreDatabase(completed: number, total: number): Promise<void> {
    await this.update(
      "index-restore",
      {
        planId: `index-restore-${total.toString()}-${this.#attemptPlanId.slice(-48)}`,
        status: completed === total ? "completed" : "running",
        completed,
        total,
        unit: "bytes",
      },
      completed === total,
    );
  }

  async sourceReplay(options: {
    revision: string;
    completed: number;
    total: number;
  }): Promise<void> {
    const planId = `source-${options.revision.slice(0, 24)}`;
    this.#sourcePlanId = planId;
    const current = this.#reporter.tracks.find((track) => track.key === "source-replay");
    if (current?.plan_id === planId && current.status === "completed") return;
    await this.update(
      "source-replay",
      {
        planId,
        status: options.completed === options.total ? "waiting" : "running",
        completed: options.completed,
        total: options.total,
        unit: "segments",
      },
      false,
    );
  }

  async workingCopy(completed: boolean): Promise<void> {
    await this.update(
      "working-copy",
      {
        planId: `working-copy-${this.#attemptPlanId.slice(-48)}`,
        status: completed ? "completed" : "running",
        completed: completed ? 1 : 0,
        total: 1,
        unit: "copies",
      },
      completed,
    );
  }

  async checkpointClaims(completed: number, total: number): Promise<void> {
    await this.update(
      "checkpoint-claims",
      {
        planId: `checkpoint-claims-${this.#attemptPlanId.slice(-48)}`,
        status: completed === total ? "completed" : "running",
        completed,
        total,
        unit: "claims",
      },
      completed === total,
    );
  }

  async outputClaims(completed: number, total: number): Promise<void> {
    await this.update(
      "output-claims",
      {
        planId: `output-claims-${this.#attemptPlanId.slice(-48)}`,
        status: completed === total ? "completed" : "running",
        completed,
        total,
        unit: "claims",
      },
      completed === total,
    );
  }

  async checkpointReplay(completed: number, total: number): Promise<void> {
    await this.update(
      "checkpoint-replay",
      {
        planId: `checkpoint-replay-${this.#attemptPlanId.slice(-48)}`,
        status: completed === total ? "completed" : "running",
        completed,
        total,
        unit: "segments",
      },
      completed === total,
    );
  }

  async queue(depth: QueueDepth): Promise<void> {
    const previousStatus = this.#reporter.tracks.find(
      (track) => track.key === "enrichment-queue",
    )?.status;
    const total = depth.pending + depth.running + depth.retrying + depth.blocked + depth.done;
    const active = depth.pending + depth.running + depth.retrying;
    const queueComplete = active === 0 && depth.blocked === 0;
    const queueStatus = queueComplete ? "completed" : active === 0 ? "waiting" : "running";
    await this.update("enrichment-queue", {
      planId: `queue-${total.toString()}-${this.#sourcePlanId.slice(-24)}`,
      status: queueStatus,
      completed: depth.done,
      total,
      unit: "records",
    });
    const queuePlanId = `queue-${total.toString()}-${this.#sourcePlanId.slice(-24)}`;
    await this.update("enrichment-successful", {
      planId: queuePlanId,
      status: queueStatus,
      completed: depth.done,
      unit: "records",
    });
    await this.update("enrichment-blocked", {
      planId: `blocked-${depth.blocked.toString()}-${this.#sourcePlanId.slice(-24)}`,
      status: depth.blocked === 0 ? "completed" : "waiting",
      completed: depth.blocked,
      unit: "records",
    });
    await this.#reporter.flush({
      force: previousStatus !== queueStatus || queueComplete,
    });
  }

  async registryScan(scanned: number, total: number): Promise<void> {
    await this.update("registry-scan", {
      planId: `registry-${total.toString()}-${this.#sourcePlanId.slice(-24)}`,
      status: scanned === total ? "completed" : "running",
      completed: scanned,
      total,
      unit: "candidates",
    });
  }

  async receiptPublished(): Promise<void> {
    await this.update(
      "receipt-publication",
      {
        planId: `receipt-${this.#attemptPlanId.slice(-48)}`,
        status: "completed",
        completed: 1,
        total: 1,
        unit: "receipts",
      },
      true,
    );
  }

  async databaseBuild(completed: boolean): Promise<void> {
    await this.#binaryStep("database-build", completed, "databases");
  }

  async databaseUpload(completed: number, total: number): Promise<void> {
    await this.#byteStep("database-upload", completed, total);
  }

  async databaseVerify(completed: number, total: number): Promise<void> {
    await this.#byteStep("database-verify", completed, total);
  }

  async manifestPublished(): Promise<void> {
    const replay = this.#reporter.tracks.find((track) => track.key === "source-replay");
    if (replay !== undefined && replay.status !== "completed") {
      await this.update("source-replay", { status: "completed" }, true);
    }
    await this.update(
      "manifest-publication",
      {
        planId: `manifest-${this.#attemptPlanId.slice(-48)}`,
        status: "completed",
        completed: 1,
        total: 1,
        unit: "manifests",
      },
      true,
    );
  }

  async complete(): Promise<void> {
    this.#reporter.setState("waiting");
    await this.#reporter.flush({ force: true });
  }

  async blocked(): Promise<void> {
    this.#reporter.setState("blocked");
    await this.#reporter.flush({ force: true });
  }

  async #byteStep(key: TrackKey, completed: number, total: number): Promise<void> {
    await this.update(
      key,
      {
        planId: `${key}-${total.toString()}-${this.#attemptPlanId.slice(-48)}`,
        status: completed === total ? "completed" : "running",
        completed,
        total,
        unit: "bytes",
      },
      completed === total,
    );
  }

  async #binaryStep(key: TrackKey, completed: boolean, unit: string): Promise<void> {
    await this.update(
      key,
      {
        planId: `${key}-${this.#attemptPlanId.slice(-48)}`,
        status: completed ? "completed" : "running",
        completed: completed ? 1 : 0,
        total: 1,
        unit,
      },
      completed,
    );
  }

  // eslint-disable-next-line complexity -- One validated merge keeps every optional track field atomic.
  private async update(key: TrackKey, update: TrackUpdate, force = false): Promise<void> {
    const current = this.#reporter.tracks.find((track) => track.key === key);
    if (current === undefined) throw new Error(`missing progress track: ${key}`);
    const measuredPlanId =
      update.planId ??
      (current.completed === undefined && update.completed !== undefined
        ? `${key}-${this.#basePlanId.slice(-16)}`
        : undefined);
    const nextPlanId = measuredPlanId ?? current.plan_id;
    if (
      current.status === "completed" &&
      nextPlanId === current.plan_id &&
      update.status !== undefined &&
      update.status !== "completed"
    ) {
      return;
    }
    const next: ProgressTrack = {
      ...current,
      ...(measuredPlanId === undefined ? {} : { plan_id: measuredPlanId }),
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.completed === undefined ? {} : { completed: update.completed }),
      ...(update.total === undefined ? {} : { total: update.total }),
      ...(update.unit === undefined ? {} : { unit: update.unit }),
      ...(update.sourceUpdatedAt === undefined
        ? {}
        : { source_updated_at: update.sourceUpdatedAt }),
    };
    this.#reporter.update(next);
    await this.#reporter.flush({ force });
  }
}

function initialTrack(key: TrackKey, planId: string): ProgressTrack {
  return {
    key,
    plan_id: planId,
    label: labelFor(key),
    status: "pending",
  };
}

function labelFor(key: TrackKey): string {
  return key
    .split("-")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export function isMissingProgressPath(error: unknown): boolean {
  return error instanceof HubApiError && error.statusCode === 404;
}

export function createProgressObjectStore(
  bucket: string,
  accessToken: string,
): ProgressObjectStore {
  const repo = { type: "bucket", name: bucket } as const;
  return {
    bucketId: bucket,
    async read(path): Promise<Uint8Array | null> {
      try {
        const blob = await downloadFile({ repo, accessToken, path, xet: false });
        return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
      } catch (error) {
        throw new TransientProgressError(`progress read failed: ${path}`, { cause: error });
      }
    },
    async list(prefix): Promise<readonly string[]> {
      try {
        const paths: string[] = [];
        for await (const entry of listFiles({
          repo,
          accessToken,
          recursive: true,
          path: prefix,
          expand: false,
        })) {
          if (entry.type === "file") paths.push(entry.path);
        }
        return paths.sort();
      } catch (error) {
        if (isMissingProgressPath(error)) return [];
        throw new TransientProgressError(`progress list failed: ${prefix}`, { cause: error });
      }
    },
    async write(path, content): Promise<void> {
      try {
        await uploadFile({
          repo,
          accessToken,
          file: { path, content: new Blob([Buffer.from(content)]) },
          commitTitle: `Publish ${path}`,
        });
      } catch (error) {
        throw new TransientProgressError(`progress write failed: ${path}`, { cause: error });
      }
    },
  };
}
