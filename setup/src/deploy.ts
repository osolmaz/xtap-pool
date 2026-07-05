import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRepo, repoExists, uploadFiles } from "@huggingface/hub";

import type { SetupConfig } from "./config.js";
import { usersValue } from "./config.js";
import type { HubClient, HubRepo } from "./hub-api.js";
import {
  getRepoPrivateState,
  getSpaceVariables,
  setSpaceSecret,
  setSpaceVariable,
} from "./hub-api.js";
import { captureCommand } from "./process.js";
import { collectUploadFiles, createSpaceStage } from "./stage.js";

export async function deployPool(
  root: string,
  client: HubClient,
  config: SetupConfig,
): Promise<void> {
  await ensureRepo(client, { type: "dataset", name: config.datasetRepo }, "private");
  await ensureRepo(client, { type: "space", name: config.spaceRepo }, "public");
  await uploadSpace(root, client, config.spaceRepo);
  await configureSpace(client, config);
}

export async function configureSpace(client: HubClient, config: SetupConfig): Promise<void> {
  const variables = await getSpaceVariables(client, config.spaceRepo);
  await setSpaceVariable(client, config.spaceRepo, "DATASET_REPO", config.datasetRepo);
  await setSpaceVariable(
    client,
    config.spaceRepo,
    "ALLOWED_USERS",
    usersValue(config.allowedUsers),
  );
  if (!variables.has("SECRETS_INITIALIZED")) {
    await setSpaceSecret(client, config.spaceRepo, "POOL_SIGNING_SECRET", randomSecret());
    await setSpaceSecret(client, config.spaceRepo, "SESSION_SECRET", randomSecret());
    await setSpaceVariable(client, config.spaceRepo, "SECRETS_INITIALIZED", "1");
  }
}

async function ensureRepo(
  client: HubClient,
  repo: HubRepo,
  visibility: "private" | "public",
): Promise<void> {
  const exists = await repoExists({
    repo,
    accessToken: client.accessToken,
    ...fetchOption(client),
  });
  if (exists) {
    await assertRepoVisibility(client, repo, visibility);
    return;
  }
  await createRepo({
    repo,
    accessToken: client.accessToken,
    visibility,
    ...(repo.type === "space" ? { sdk: "docker" as const } : {}),
    ...fetchOption(client),
  });
}

async function assertRepoVisibility(
  client: HubClient,
  repo: HubRepo,
  visibility: "private" | "public",
): Promise<void> {
  const actualPrivate = await getRepoPrivateState(client, repo);
  const expectedPrivate = visibility === "private";
  if (actualPrivate === expectedPrivate) return;
  throw new Error(
    `${repo.type} ${repo.name} already exists as ${actualPrivate ? "private" : "public"}; expected ${visibility}.`,
  );
}

async function uploadSpace(root: string, client: HubClient, spaceRepo: string): Promise<void> {
  const stageDir = await mkdtemp(join(tmpdir(), "xtap-pool-space-"));
  try {
    await createSpaceStage(root, stageDir);
    await uploadFiles({
      repo: { type: "space", name: spaceRepo },
      accessToken: client.accessToken,
      files: [...(await collectUploadFiles(stageDir))],
      commitTitle: `deploy: ${await shortHead(root)}`,
      ...fetchOption(client),
    });
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

async function shortHead(root: string): Promise<string> {
  const result = await captureCommand("git", ["-C", root, "rev-parse", "--short", "HEAD"]);
  return result.stdout.trim();
}

function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

function fetchOption(client: HubClient): { fetch?: typeof fetch } {
  return client.fetchFn === undefined ? {} : { fetch: client.fetchFn };
}
