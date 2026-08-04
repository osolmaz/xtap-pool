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

export type StorageTokenReport =
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

export async function verifyStorageWriteToken(params: {
  token: string;
  datasetRepo: string;
  indexBucket: string;
  fetchFn?: typeof fetch;
}): Promise<StorageTokenReport> {
  const response = await (params.fetchFn ?? fetch)("https://huggingface.co/api/whoami-v2", {
    headers: { authorization: `Bearer ${params.token}` },
  });
  if (!response.ok) {
    return { ok: false, errors: [`Hugging Face rejected the token (${String(response.status)}).`] };
  }
  const payload: unknown = await response.json();
  const targets: readonly StorageTarget[] = [
    { kind: "dataset", name: params.datasetRepo },
    { kind: "bucket", name: params.indexBucket },
  ];
  const permissions = evaluateStorageWriteToken(payload, targets);
  if (!permissions.ok) return permissions;
  const accessErrors = await storageReadErrors(params);
  return accessErrors.length === 0 ? permissions : { ok: false, errors: accessErrors };
}

async function storageReadErrors(params: {
  token: string;
  datasetRepo: string;
  indexBucket: string;
  fetchFn?: typeof fetch;
}): Promise<readonly string[]> {
  const fetchFn = params.fetchFn ?? fetch;
  const probes = [
    { name: params.datasetRepo, url: datasetProbeUrl(params.datasetRepo), kind: "dataset" },
    { name: params.indexBucket, url: bucketProbeUrl(params.indexBucket), kind: "Bucket" },
  ];
  const errors: string[] = [];
  for (const probe of probes) {
    const access = await fetchFn(probe.url, {
      headers: { authorization: `Bearer ${params.token}` },
    });
    if (access.status === 401 || access.status === 403) {
      errors.push(
        `Token permissions claim access to ${probe.name}, but Hugging Face rejected a direct private-${probe.kind} read (${String(access.status)}).`,
      );
    } else if (!access.ok && access.status !== 404) {
      errors.push(`Could not verify a direct read from ${probe.name} (${String(access.status)}).`);
    }
  }
  return errors;
}

function datasetProbeUrl(datasetRepo: string): string {
  return `https://huggingface.co/datasets/${datasetRepo}/resolve/main/config/pool.json`;
}

function bucketProbeUrl(indexBucket: string): string {
  return `https://huggingface.co/api/buckets/${indexBucket}`;
}

export function evaluateStorageWriteToken(
  payload: unknown,
  targets: readonly StorageTarget[],
): StorageTokenReport {
  const root = asRecord(payload);
  const accessToken = asRecord(asRecord(root["auth"])["accessToken"]);
  const fineGrained = asRecord(accessToken["fineGrained"]);
  const role = text(accessToken["role"]);
  const errors =
    role === FINE_GRAINED_ROLE
      ? []
      : [`Token role is '${role || "unknown"}', expected fine-grained.`];
  errors.push(...globalPermissionErrors(fineGrained));
  const permissionsByTarget = scopedPermissionErrors(fineGrained, targets, errors);
  for (const target of targets) {
    const key = targetKey(target);
    const permissions = permissionsByTarget.get(key) ?? new Set<string>();
    if (!permissions.has(READ_PERMISSION)) {
      errors.push(`Token must include ${READ_PERMISSION} on ${target.name}.`);
    }
    if (!WRITE_PERMISSIONS.some((permission) => permissions.has(permission))) {
      errors.push(`Token must include ${WRITE_PERMISSIONS.join(" or ")} on ${target.name}.`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    username: text(root["name"]),
    tokenName: text(accessToken["displayName"]),
    permissions: [...permissionsByTarget.entries()]
      .flatMap(([target, permissions]) =>
        [...permissions].map((permission) => `${target}:${permission}`),
      )
      .sort(),
  };
}

function globalPermissionErrors(fineGrained: JsonObject): string[] {
  return strings(fineGrained["global"]).map(
    (permission) => `Unexpected global permission: ${permission}.`,
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
        `Unexpected permission outside configured storage: ${permission} on ${entityLabel(entity)}.`,
      );
    } else if (!TARGET_PERMISSIONS.has(permission)) {
      errors.push(`Unexpected permission on storage token: ${permission}.`);
    } else {
      permissionsByTarget.get(targetKey(target))?.add(permission);
    }
  }
}

function matchesTarget(entity: JsonObject, target: StorageTarget): boolean {
  const type = text(entity["type"]).replace(/s$/, "");
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
  const prefix = kind === "dataset" ? /^datasets\// : /^buckets\//;
  return value.replace(prefix, "");
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
