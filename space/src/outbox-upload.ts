import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PooledTweet } from "@xtap-pool/shared";

import { deterministicUuid, sha256, tweetAppends } from "./bucket-log.js";
import type { BucketLog, BucketSegment } from "./bucket-log.js";
import { prepareIngest } from "./ingest.js";

/** `<seal-time-ms>-<uuid>.jsonl`, written by the extension's local handoff. */
export const OUTBOX_FILE_PATTERN =
  /^(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export const REJECTED_DIR = "rejected";

export type SegmentWriter = Pick<BucketLog, "putSegment">;

export type OutboxRejection = { line: number; reason: string; record: string };

export type OutboxFileResult = {
  name: string;
  uploaded: number;
  rejected: number;
  segment: string | undefined;
};

export type OutboxUploadResult = {
  files: OutboxFileResult[];
  ignored: string[];
};

/**
 * Upload every sealed outbox file as one raw tweet segment.
 *
 * The segment identity comes from the file name: the transaction ID is derived
 * from it and `created_at` and `pooled_at` are its seal time. A retry of the same
 * file therefore produces the same bytes and the same content-addressed key, so
 * repeated or concurrent runs never store a second copy. A file is deleted only
 * after its segment was read back and verified.
 */
export async function uploadOutbox(params: {
  outboxDir: string;
  log: SegmentWriter;
  contributor: string;
  now?: () => Date;
}): Promise<OutboxUploadResult> {
  const now = params.now ?? ((): Date => new Date());
  const entries = await readdir(params.outboxDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const files: OutboxFileResult[] = [];
  const ignored: string[] = [];
  for (const name of names) {
    const sealedAt = outboxSealTime(name);
    if (sealedAt === undefined) {
      ignored.push(name);
      continue;
    }
    files.push(await uploadOutboxFile(params, name, sealedAt, now()));
  }
  return { files, ignored };
}

async function uploadOutboxFile(
  params: { outboxDir: string; log: SegmentWriter; contributor: string },
  name: string,
  sealedAt: Date,
  now: Date,
): Promise<OutboxFileResult> {
  const path = join(params.outboxDir, name);
  const lines = (await readFile(path, "utf8")).split("\n");
  const candidates: unknown[] = [];
  const candidateLines: number[] = [];
  const rejections: OutboxRejection[] = [];
  lines.forEach((record, index) => {
    if (record.trim() === "") return;
    try {
      candidates.push(JSON.parse(record));
      candidateLines.push(index);
    } catch {
      rejections.push({ line: index + 1, reason: "malformed JSON", record });
    }
  });
  const prepared = prepareIngest(candidates, params.contributor, sealedAt, now);
  for (const { index, reason } of prepared.rejected) {
    const line = candidateLines[index] ?? 0;
    rejections.push({ line: line + 1, reason, record: lines[line] ?? "" });
  }
  const segment =
    prepared.stamped.length === 0
      ? undefined
      : await params.log.putSegment(outboxSegment(name, sealedAt, prepared.stamped));
  if (rejections.length > 0) {
    rejections.sort((left, right) => left.line - right.line);
    const rejectedDir = join(params.outboxDir, REJECTED_DIR);
    await mkdir(rejectedDir, { recursive: true });
    await writeFile(join(rejectedDir, `${name}.json`), `${JSON.stringify(rejections, null, 2)}\n`);
  }
  await rm(path, { force: true });
  return { name, uploaded: prepared.stamped.length, rejected: rejections.length, segment };
}

/** The seal time encoded in an outbox file name, or undefined for any other file. */
export function outboxSealTime(name: string): Date | undefined {
  const match = OUTBOX_FILE_PATTERN.exec(name);
  if (match?.[1] === undefined) return undefined;
  const sealedAt = new Date(Number(match[1]));
  return Number.isNaN(sealedAt.getTime()) ? undefined : sealedAt;
}

/** The deterministic raw segment for one outbox file. */
export function outboxSegment(
  name: string,
  sealedAt: Date,
  tweets: readonly PooledTweet[],
): BucketSegment {
  return {
    schema_version: 1,
    transaction_id: deterministicUuid(sha256(new TextEncoder().encode(name))),
    created_at: sealedAt.toISOString(),
    operations: tweetAppends(tweets).map(({ path, lines }) => ({
      path,
      mode: "append" as const,
      lines,
    })),
  };
}
