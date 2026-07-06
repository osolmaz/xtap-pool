type JsonObject = Record<string, unknown>;

const FINE_GRAINED_ROLE = "fineGrained";
const TARGET_PERMISSIONS = new Set(["repo.content.read", "repo.content.write"]);
const REQUIRED_PERMISSIONS = ["repo.content.read", "repo.content.write"] as const;

export type DatasetTokenReport =
  | {
      ok: true;
      username: string;
      tokenName: string;
      permissions: readonly string[];
    }
  | {
      ok: false;
      errors: readonly string[];
    };

export async function verifyDatasetWriteToken(params: {
  token: string;
  datasetRepo: string;
  fetchFn?: typeof fetch;
}): Promise<DatasetTokenReport> {
  const response = await (params.fetchFn ?? fetch)("https://huggingface.co/api/whoami-v2", {
    headers: { authorization: `Bearer ${params.token}` },
  });
  if (!response.ok)
    return { ok: false, errors: [`Hugging Face rejected the token (${String(response.status)}).`] };
  const payload: unknown = await response.json();
  return evaluateDatasetWriteToken(payload, params.datasetRepo);
}

export function evaluateDatasetWriteToken(
  payload: unknown,
  datasetRepo: string,
): DatasetTokenReport {
  const root = asRecord(payload);
  const accessToken = asRecord(asRecord(root["auth"])["accessToken"]);
  const fineGrained = asRecord(accessToken["fineGrained"]);
  const role = text(accessToken["role"]);
  const errors =
    role === FINE_GRAINED_ROLE
      ? []
      : [`Token role is '${role || "unknown"}', expected fine-grained.`];
  errors.push(...globalPermissionErrors(fineGrained));
  const targetPermissions = scopedPermissionErrors(fineGrained, datasetRepo, errors);
  for (const permission of REQUIRED_PERMISSIONS) {
    if (!targetPermissions.has(permission)) {
      errors.push(`Token must include ${permission} on ${datasetRepo}.`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    username: text(root["name"]),
    tokenName: text(accessToken["displayName"]),
    permissions: [...targetPermissions].sort(),
  };
}

function globalPermissionErrors(fineGrained: JsonObject): string[] {
  return strings(fineGrained["global"]).map(
    (permission) => `Unexpected global permission: ${permission}.`,
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
        `Unexpected permission outside ${datasetRepo}: ${permission} on ${entityLabel(entity)}.`,
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
  else errors.push(`Unexpected permission on dataset token: ${permission}.`);
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
