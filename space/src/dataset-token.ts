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

type StorageTarget = { kind: "bucket" | "dataset"; name: string };

export type DatasetCredentialReadiness =
  | { credential: "ok" }
  | { credential: "invalid"; error: string }
  | { credential: "unknown"; error: string };

/** Verify the Space HF_TOKEN can read and write the configured dataset and index Bucket only. */
export async function checkDatasetCredential(params: {
  token: string;
  datasetRepo: string;
  indexBucket: string;
  fetchFn?: typeof fetch;
}): Promise<DatasetCredentialReadiness> {
  try {
    const response = await (params.fetchFn ?? fetch)("https://huggingface.co/api/whoami-v2", {
      headers: { authorization: `Bearer ${params.token}` },
    });
    if (!response.ok) return tokenStatusError("HF_TOKEN", response.status);
    const targets: readonly StorageTarget[] = [
      { kind: "dataset", name: params.datasetRepo },
      { kind: "bucket", name: params.indexBucket },
    ];
    const errors = storageTokenErrors(await response.json(), targets);
    if (errors.length > 0) return { credential: "invalid", error: errors.join(" ") };
    return await checkStorageReads(params);
  } catch (error) {
    return { credential: "unknown", error: errorMessage(error) };
  }
}

export function datasetCredentialOk(status: DatasetCredentialReadiness): boolean {
  return status.credential === "ok";
}

async function checkStorageReads(params: {
  token: string;
  datasetRepo: string;
  indexBucket: string;
  fetchFn?: typeof fetch;
}): Promise<DatasetCredentialReadiness> {
  const fetchFn = params.fetchFn ?? fetch;
  const probes = [
    {
      url: `https://huggingface.co/datasets/${params.datasetRepo}/resolve/main/config/pool.json`,
      label: "private-dataset download",
    },
    {
      url: `https://huggingface.co/api/buckets/${params.indexBucket}`,
      label: "private-Bucket read",
    },
  ];
  for (const probe of probes) {
    const response = await fetchFn(probe.url, {
      headers: { authorization: `Bearer ${params.token}` },
    });
    if (response.ok || response.status === 404) continue;
    const error = `Hugging Face rejected a direct ${probe.label} using HF_TOKEN (${String(response.status)}).`;
    return response.status === 401 || response.status === 403
      ? { credential: "invalid", error }
      : { credential: "unknown", error };
  }
  return { credential: "ok" };
}

function storageTokenErrors(payload: unknown, targets: readonly StorageTarget[]): string[] {
  const root = asRecord(payload);
  const accessToken = asRecord(asRecord(root["auth"])["accessToken"]);
  const fineGrained = asRecord(accessToken["fineGrained"]);
  const role = text(accessToken["role"]);
  const errors =
    role === FINE_GRAINED_ROLE
      ? []
      : [`HF_TOKEN role is '${role || "unknown"}', expected fine-grained.`];
  errors.push(...globalPermissionErrors(fineGrained));
  const permissionsByTarget = scopedPermissionErrors(fineGrained, targets, errors);
  for (const target of targets) {
    const permissions = permissionsByTarget.get(targetKey(target)) ?? new Set<string>();
    if (!permissions.has(READ_PERMISSION)) {
      errors.push(`HF_TOKEN must include ${READ_PERMISSION} on ${target.name}.`);
    }
    if (!WRITE_PERMISSIONS.some((permission) => permissions.has(permission))) {
      errors.push(`HF_TOKEN must include ${WRITE_PERMISSIONS.join(" or ")} on ${target.name}.`);
    }
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
  targets: readonly StorageTarget[],
  errors: string[],
): Map<string, Set<string>> {
  const permissionsByTarget = new Map(
    targets.map((target) => [targetKey(target), new Set<string>()]),
  );
  for (const scope of array(fineGrained["scoped"])) {
    collectScopePermissions(asRecord(scope), targets, permissionsByTarget, errors);
  }
  return permissionsByTarget;
}

function collectScopePermissions(
  scope: JsonObject,
  targets: readonly StorageTarget[],
  permissionsByTarget: Map<string, Set<string>>,
  errors: string[],
): void {
  const entity = asRecord(scope["entity"]);
  const target = targets.find((candidate) => matchesTarget(entity, candidate));
  for (const permission of strings(scope["permissions"])) {
    if (target === undefined) {
      errors.push(
        `Unexpected permission outside configured storage on HF_TOKEN: ${permission} on ${entityLabel(entity)}.`,
      );
    } else if (!TARGET_PERMISSIONS.has(permission)) {
      errors.push(`Unexpected permission on HF_TOKEN: ${permission}.`);
    } else {
      permissionsByTarget.get(targetKey(target))?.add(permission);
    }
  }
}

function matchesTarget(entity: JsonObject, target: StorageTarget): boolean {
  const type = text(entity["type"]).replace(/s$/u, "");
  return (
    type === target.kind &&
    entityCandidates(entity).some(
      (candidate) => normalizeName(candidate, target.kind) === target.name,
    )
  );
}

function targetKey(target: StorageTarget): string {
  return `${target.kind}:${target.name}`;
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

function normalizeName(value: string, kind: StorageTarget["kind"]): string {
  return value.replace(kind === "dataset" ? /^datasets\//u : /^buckets\//u, "");
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
