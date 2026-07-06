import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commit, createRepo, listFiles, repoExists } from "@huggingface/hub";

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

type DeleteOperation = { operation: "delete"; path: string };
type ConfigureSpaceOptions = { initializeGeneratedSecrets?: boolean };

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

export async function updateExistingPool(
  root: string,
  client: HubClient,
  config: SetupConfig,
): Promise<void> {
  await assertRepoVisibility(client, { type: "dataset", name: config.datasetRepo }, "private");
  await assertRepoVisibility(client, { type: "space", name: config.spaceRepo }, "public");
  await uploadSpace(root, client, config.spaceRepo);
  await configureSpace(client, config, { initializeGeneratedSecrets: false });
}

export async function configureSpace(
  client: HubClient,
  config: SetupConfig,
  options: ConfigureSpaceOptions = {},
): Promise<void> {
  const initializeGeneratedSecrets = options.initializeGeneratedSecrets ?? true;
  const variables = await getSpaceVariables(client, config.spaceRepo);
  await setSpaceVariable(client, config.spaceRepo, "DATASET_REPO", config.datasetRepo);
  await setSpaceVariable(
    client,
    config.spaceRepo,
    "ALLOWED_USERS",
    usersValue(config.allowedUsers),
  );
  await setSpaceVariable(client, config.spaceRepo, "POOL_ADMINS", usersValue(config.poolAdmins));
  if (initializeGeneratedSecrets && !variables.has("SECRETS_INITIALIZED")) {
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
    ...hubOptions(client),
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
    ...hubOptions(client),
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
    const files = await collectUploadFiles(stageDir);
    const staleDeletes = await collectStaleSpaceDeletes(
      client,
      spaceRepo,
      files.map((file) => file.path),
    );
    await commit({
      repo: { type: "space", name: spaceRepo },
      accessToken: client.accessToken,
      title: `deploy: ${await shortHead(root)}`,
      operations: [
        ...files.map((file) => ({
          operation: "addOrUpdate" as const,
          path: file.path,
          content: file.content,
        })),
        ...staleDeletes,
      ],
      ...hubOptions(client),
    });
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

export async function collectStaleSpaceDeletes(
  client: HubClient,
  spaceRepo: string,
  stagedPaths: readonly string[],
): Promise<readonly DeleteOperation[]> {
  const desired = new Set(stagedPaths);
  const deletes: DeleteOperation[] = [];
  for await (const entry of listFiles({
    repo: { type: "space", name: spaceRepo },
    accessToken: client.accessToken,
    recursive: true,
    ...hubOptions(client),
  })) {
    if (entry.type === "file" && entry.path !== ".gitattributes" && !desired.has(entry.path)) {
      deletes.push({ operation: "delete", path: entry.path });
    }
  }
  return deletes;
}

async function shortHead(root: string): Promise<string> {
  const result = await captureCommand("git", ["-C", root, "rev-parse", "--short", "HEAD"]);
  return result.stdout.trim();
}

function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

function hubOptions(client: HubClient): { fetch?: typeof fetch; hubUrl?: string } {
  return {
    ...(client.fetchFn === undefined ? {} : { fetch: client.fetchFn }),
    ...(client.hubUrl === undefined ? {} : { hubUrl: client.hubUrl }),
  };
}
