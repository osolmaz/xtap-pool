import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { BucketLog, createRawBucketClient } from "./bucket-log.js";
import { uploadOutbox } from "./outbox-upload.js";
import type { OutboxUploadResult } from "./outbox-upload.js";

const schema = z.object({
  RAW_BUCKET: z.string().min(1),
  XTAP_POOL_OUTBOX_DIR: z.string().min(1).optional(),
  HF_TOKEN: z.string().min(1).optional(),
  HF_HOME: z.string().min(1).optional(),
});

export type PushOutboxDeps = {
  fetchFn?: typeof fetch;
  readToken?: (path: string) => string;
};

export function defaultOutboxDir(): string {
  return join(homedir(), ".xtap", "pool-outbox");
}

/**
 * Upload the local pool outbox to the raw Bucket with the locally configured
 * Hugging Face token. The contributor is the token's verified username.
 */
export async function runPushOutbox(
  env: Record<string, string | undefined>,
  deps: PushOutboxDeps = {},
): Promise<OutboxUploadResult> {
  const config = schema.parse(env);
  const token = config.HF_TOKEN ?? localToken(config.HF_HOME, deps.readToken);
  const contributor = await verifiedUsername(token, deps.fetchFn ?? fetch);
  const outboxDir = config.XTAP_POOL_OUTBOX_DIR ?? defaultOutboxDir();
  const log = new BucketLog(
    config.RAW_BUCKET,
    createRawBucketClient(
      config.RAW_BUCKET,
      token,
      deps.fetchFn === undefined ? {} : { fetcher: deps.fetchFn },
    ),
    join(outboxDir, ".bucket-cache"),
  );
  return uploadOutbox({ outboxDir, log, contributor });
}

function localToken(hfHome: string | undefined, readToken = defaultReadToken): string {
  const path = join(hfHome ?? join(homedir(), ".cache", "huggingface"), "token");
  const token = readToken(path).trim();
  if (token === "") throw new Error(`no Hugging Face token in HF_TOKEN or ${path}`);
  return token;
}

function defaultReadToken(path: string): string {
  return readFileSync(path, "utf8");
}

export async function verifiedUsername(token: string, fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn("https://huggingface.co/api/whoami-v2", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Hugging Face rejected the token (${String(response.status)})`);
  }
  const body = z.object({ name: z.string().min(1) }).safeParse(await response.json());
  if (!body.success) throw new Error("Hugging Face whoami response has no username");
  return body.data.name;
}

export function summarizePush(result: OutboxUploadResult): string {
  const uploaded = result.files.reduce((sum, file) => sum + file.uploaded, 0);
  const rejected = result.files.reduce((sum, file) => sum + file.rejected, 0);
  const parts = [
    `${String(result.files.length)} files`,
    `${String(uploaded)} observations uploaded`,
    `${String(rejected)} rejected`,
  ];
  if (result.ignored.length > 0) parts.push(`${String(result.ignored.length)} other files ignored`);
  return parts.join(", ");
}
