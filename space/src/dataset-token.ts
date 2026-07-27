type JsonObject = Record<string, unknown>;

const FINE_GRAINED_ROLE = "fineGrained";
const TARGET_PERMISSIONS = new Set([
  "repo.access.read",
  "repo.content.read",
  "repo.content.write",
  "repo.write",
]);
const READ_PERMISSION = "repo.content.read";
const WRITE_PERMISSIONS = ["repo.content.write", "repo.write"] as const;

export type DatasetCredentialReadiness =
  | { credential: "ok" }
  | { credential: "invalid"; error: string }
  | { credential: "unknown"; error: string };

/** Verify the Space HF_TOKEN can read and write only the configured dataset repo. */
export async function checkDatasetCredential(params: {
  token: string;
  datasetRepo: string;
  fetchFn?: typeof fetch;
}): Promise<DatasetCredentialReadiness> {
  try {
    const response = await (params.fetchFn ?? fetch)("https://huggingface.co/api/whoami-v2", {
      headers: { authorization: `Bearer ${params.token}` },
    });
    if (!response.ok) {
      return tokenStatusError("HF_TOKEN", response.status);
    }
    const errors = datasetTokenErrors(await response.json(), params.datasetRepo);
    if (errors.length > 0) return { credential: "invalid", error: errors.join(" ") };
    return await checkDatasetDownload(params);
  } catch (error) {
    return { credential: "unknown", error: errorMessage(error) };
  }
}

export function datasetCredentialOk(status: DatasetCredentialReadiness): boolean {
  return status.credential === "ok";
}

async function checkDatasetDownload(params: {
  token: string;
  datasetRepo: string;
  fetchFn?: typeof fetch;
}): Promise<DatasetCredentialReadiness> {
  const response = await (params.fetchFn ?? fetch)(datasetProbeUrl(params.datasetRepo), {
    headers: { authorization: `Bearer ${params.token}` },
  });
  if (response.ok || response.status === 404) return { credential: "ok" };
  const error = `Hugging Face rejected a direct private-dataset download using HF_TOKEN (${String(response.status)}).`;
  return response.status === 401 || response.status === 403
    ? { credential: "invalid", error }
    : { credential: "unknown", error };
}

function datasetProbeUrl(datasetRepo: string): string {
  return `https://huggingface.co/datasets/${datasetRepo}/resolve/main/config/pool.json`;
}

function datasetTokenErrors(payload: unknown, datasetRepo: string): string[] {
  const root = asRecord(payload);
  const accessToken = asRecord(asRecord(root["auth"])["accessToken"]);
  const fineGrained = asRecord(accessToken["fineGrained"]);
  const role = text(accessToken["role"]);
  const errors =
    role === FINE_GRAINED_ROLE
      ? []
      : [`HF_TOKEN role is '${role || "unknown"}', expected fine-grained.`];
  errors.push(...globalPermissionErrors(fineGrained));
  const targetPermissions = scopedPermissionErrors(fineGrained, datasetRepo, errors);
  if (!targetPermissions.has(READ_PERMISSION)) {
    errors.push(`HF_TOKEN must include ${READ_PERMISSION} on ${datasetRepo}.`);
  }
  if (!WRITE_PERMISSIONS.some((permission) => targetPermissions.has(permission))) {
    errors.push(`HF_TOKEN must include ${WRITE_PERMISSIONS.join(" or ")} on ${datasetRepo}.`);
  }
  return errors;
}

function globalPermissionErrors(fineGrained: JsonObject): string[] {
  return strings(fineGrained["global"]).map(
    (permission) => `Unexpected global permission on HF_TOKEN: ${permission}.`,
  );
}

function scopedPermissionErrors(
  fineGrained: JsonObject,
  datasetRepo: string,
  errors: string[],
): Set<string> {
  const targetPermissions = new Set<string>();
  for (const scope of array(fineGrained["scoped"])) {
    collectScopePermissions(asRecord(scope), datasetRepo, targetPermissions, errors);
  }
  return targetPermissions;
}

function collectScopePermissions(
  scope: JsonObject,
  datasetRepo: string,
  targetPermissions: Set<string>,
  errors: string[],
): void {
  const entity = asRecord(scope["entity"]);
  for (const permission of strings(scope["permissions"])) {
    if (matchesDataset(entity, datasetRepo)) {
      recordTargetPermission(permission, targetPermissions, errors);
    } else {
      errors.push(
        `Unexpected permission outside ${datasetRepo} on HF_TOKEN: ${permission} on ${entityLabel(entity)}.`,
      );
    }
  }
}

function recordTargetPermission(
  permission: string,
  targetPermissions: Set<string>,
  errors: string[],
): void {
  if (TARGET_PERMISSIONS.has(permission)) targetPermissions.add(permission);
  else errors.push(`Unexpected permission on HF_TOKEN: ${permission}.`);
}

function matchesDataset(entity: JsonObject, datasetRepo: string): boolean {
  return (
    isDatasetEntity(entity) &&
    entityCandidates(entity).some((candidate) => normalizeRepo(candidate) === datasetRepo)
  );
}

function isDatasetEntity(entity: JsonObject): boolean {
  const type = text(entity["type"]);
  return type === "dataset" || type === "datasets";
}

function entityCandidates(entity: JsonObject): readonly string[] {
  const name = text(entity["name"]);
  const namespace = text(entity["namespace"]);
  return [text(entity["id"]), name, namespace && name ? `${namespace}/${name}` : ""].filter(
    (candidate) => candidate.length > 0,
  );
}

function entityLabel(entity: JsonObject): string {
  const kind = text(entity["type"]) || "unknown";
  const name = text(entity["name"]) || text(entity["id"]) || "unknown";
  return `${kind}:${name}`;
}

function normalizeRepo(value: string): string {
  return value.replace(/^datasets\//, "");
}

function tokenStatusError(tokenName: "HF_TOKEN", status: number): DatasetCredentialReadiness {
  const error = `Hugging Face rejected ${tokenName} (${String(status)}).`;
  if (status === 401 || status === 403) return { credential: "invalid", error };
  return { credential: "unknown", error };
}

function asRecord(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): readonly string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
