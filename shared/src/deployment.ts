import { z } from "zod";

/** Path embedded in every deployed Space image and checked by Hugging Face Jobs. */
export const DEPLOYMENT_MANIFEST_PATH = ".xtap-deployment.json";

export const deploymentManifestSchema = z
  .object({
    source_revision: z.string().regex(/^[0-9a-f]{40}$/u),
  })
  .strict();

export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
