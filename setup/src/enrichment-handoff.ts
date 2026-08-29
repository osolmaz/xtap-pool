import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deploymentManifestSchema,
  enrichmentRevisionHandoffSchema,
  type DeploymentManifest,
  type EnrichmentRevisionHandoff,
} from "@xtap-pool/shared";

import type { SetupConfig } from "./config.js";
import { assertEnrichmentWritersQuiescent } from "./enrichment-job.js";
import type { HubClient } from "./hub-api.js";
import { captureCommand } from "./process.js";

export type EnrichmentHandoffPreparation = {
  readHead: () => Promise<string>;
  assertClean: () => Promise<void>;
  assertWritersQuiescent: () => Promise<string>;
  prepareHandoff: (targetRevision: string) => Promise<EnrichmentRevisionHandoff | null>;
};

export function createEnrichmentDeploymentManifestPreparer(
  preparation: EnrichmentHandoffPreparation,
): () => Promise<DeploymentManifest> {
  return async () => {
    await preparation.assertClean();
    const targetRevision = await preparation.readHead();
    const beforeWriters = await preparation.assertWritersQuiescent();
    const handoff = await preparation.prepareHandoff(targetRevision);
    const afterWriters = await preparation.assertWritersQuiescent();
    await preparation.assertClean();
    const revalidatedTarget = await preparation.readHead();
    if (revalidatedTarget !== targetRevision) {
      throw new Error("Git revision changed during enrichment handoff preparation");
    }
    if (afterWriters !== beforeWriters) {
      throw new Error("canonical enrichment schedule changed during handoff preparation");
    }
    return deploymentManifestSchema.parse({
      source_revision: targetRevision,
      enrichment_revision_handoff: handoff,
    });
  };
}

export function productionEnrichmentHandoffPreparation(options: {
  root: string;
  client: HubClient;
  config: SetupConfig;
  variables: ReadonlyMap<string, string>;
  storageToken: string;
}): EnrichmentHandoffPreparation {
  return {
    readHead: async () => {
      const result = await captureCommand("git", ["rev-parse", "HEAD"], {
        cwd: options.root,
      });
      return result.stdout.trim();
    },
    assertClean: async () => {
      const result = await captureCommand("git", ["status", "--porcelain=v1"], {
        cwd: options.root,
      });
      if (result.stdout.trim().length > 0) {
        throw new Error("enrichment handoff deployment requires a clean Git worktree");
      }
    },
    assertWritersQuiescent: () =>
      assertEnrichmentWritersQuiescent({
        client: options.client,
        spaceRepo: options.config.spaceRepo,
        rawBucket: options.config.rawBucket,
        variables: options.variables,
      }),
    prepareHandoff: (targetRevision) =>
      runReadOnlyHandoffPreparation({
        root: options.root,
        indexBucket: options.config.indexBucket,
        storageToken: options.storageToken,
        targetRevision,
      }),
  };
}

async function runReadOnlyHandoffPreparation(options: {
  root: string;
  indexBucket: string;
  storageToken: string;
  targetRevision: string;
}): Promise<EnrichmentRevisionHandoff | null> {
  const dataDir = await mkdtemp(join(tmpdir(), "xtap-pool-enrichment-handoff-"));
  try {
    const result = await captureCommand(
      "npm",
      ["run", "--silent", "enrich:prepare-handoff", "--workspace", "space"],
      {
        cwd: options.root,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          INDEX_BUCKET: options.indexBucket,
          HF_TOKEN: options.storageToken,
          XTAP_TARGET_SOURCE_REVISION: options.targetRevision,
          INFERENCE_TOKEN: undefined,
        },
      },
    );
    const candidate: unknown = JSON.parse(result.stdout);
    return candidate === null ? null : enrichmentRevisionHandoffSchema.parse(candidate);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
