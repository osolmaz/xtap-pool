import { readFile } from "node:fs/promises";

import {
  DEPLOYMENT_MANIFEST_PATH,
  deploymentManifestSchema,
  type DeploymentManifest,
} from "@xtap-pool/shared";

export async function verifyEnrichmentJobRevision(
  env: Readonly<Record<string, string | undefined>>,
  readText: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<DeploymentManifest> {
  const expected = env["XTAP_SOURCE_REVISION"];
  if (expected === undefined || expected.length === 0) {
    throw new Error("XTAP_SOURCE_REVISION is required for Hugging Face Job execution.");
  }
  const candidate: unknown = JSON.parse(await readText(DEPLOYMENT_MANIFEST_PATH));
  const manifest = deploymentManifestSchema.parse(candidate);
  if (manifest.source_revision !== expected) {
    throw new Error(
      `Job source revision mismatch: expected ${expected}, image contains ${manifest.source_revision}.`,
    );
  }
  return manifest;
}
