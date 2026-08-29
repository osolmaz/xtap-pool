import { z } from "zod";

/** Path embedded in every deployed Space image and checked by Hugging Face Jobs. */
export const DEPLOYMENT_MANIFEST_PATH = ".xtap-deployment.json";

const GIT_REVISION = /^[0-9a-f]{40}$/u;
const PLAN_WORKER_REVISION = /^[0-9a-f]{40,64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const enrichmentRevisionHandoffSchema = z
  .object({
    active_generation: z.number().int().positive(),
    activation_sha256: z.string().regex(SHA256),
    run_id: z.string().regex(SAFE_ID),
    plan_sha256: z.string().regex(SHA256),
    plan_worker_revision: z.string().regex(PLAN_WORKER_REVISION),
    target_worker_revision: z.string().regex(GIT_REVISION),
    contract_sha256: z.string().regex(SHA256),
    source_snapshot_revision: z.string().regex(SHA256),
    checkpoint_pointer_sha256: z.string().regex(SHA256),
    checkpoint_sequence: z.number().int().positive(),
    checkpoint_key: z.string().min(1),
    checkpoint_sha256: z.string().regex(SHA256),
    checkpoint_bytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((handoff, context) => {
    if (handoff.plan_worker_revision === handoff.target_worker_revision) {
      context.addIssue({
        code: "custom",
        path: ["target_worker_revision"],
        message: "revision handoff target must differ from the planned worker revision",
      });
    }
  });

export type EnrichmentRevisionHandoff = z.infer<typeof enrichmentRevisionHandoffSchema>;

export const deploymentManifestSchema = z
  .object({
    source_revision: z.string().regex(GIT_REVISION),
    enrichment_revision_handoff: enrichmentRevisionHandoffSchema.nullable(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const target = manifest.enrichment_revision_handoff?.target_worker_revision;
    if (target !== undefined && target !== manifest.source_revision) {
      context.addIssue({
        code: "custom",
        path: ["enrichment_revision_handoff", "target_worker_revision"],
        message: "revision handoff target must equal the deployment source revision",
      });
    }
  });

export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;

export function serializeDeploymentManifest(value: unknown): string {
  const manifest = deploymentManifestSchema.parse(value);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
