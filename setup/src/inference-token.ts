type JsonObject = Record<string, unknown>;

const FINE_GRAINED_ROLE = "fineGrained";
const INFERENCE_PROVIDERS_PERMISSION = "inference.serverless.write";

export type InferenceTokenReport =
  | { ok: true; username: string; tokenName: string; permissions: readonly string[] }
  | { ok: false; errors: readonly string[] };

/**
 * Verify that a candidate inference token has the dedicated Inference Providers
 * capability. A dataset-scoped token is still a valid Hugging Face token, but
 * accepting it here would recreate the HF_TOKEN/INFERENCE_TOKEN role confusion
 * that doctor is meant to prevent.
 */
export async function verifyInferenceToken(params: {
  token: string;
  fetchFn?: typeof fetch;
}): Promise<InferenceTokenReport> {
  const response = await (params.fetchFn ?? fetch)("https://huggingface.co/api/whoami-v2", {
    headers: { authorization: `Bearer ${params.token}` },
  });
  if (!response.ok) {
    return { ok: false, errors: [`Hugging Face rejected the token (${String(response.status)}).`] };
  }
  return evaluateInferenceToken(await response.json());
}

export function evaluateInferenceToken(payload: unknown): InferenceTokenReport {
  const root = asRecord(payload);
  const accessToken = asRecord(asRecord(root["auth"])["accessToken"]);
  const fineGrained = asRecord(accessToken["fineGrained"]);
  const role = text(accessToken["role"]);
  const globalPermissions = strings(fineGrained["global"]);
  const errors =
    role === FINE_GRAINED_ROLE
      ? []
      : [`Token role is '${role || "unknown"}', expected fine-grained.`];
  const scoped = evaluateScopedInferencePermissions(fineGrained, errors);
  if (!globalPermissions.includes(INFERENCE_PROVIDERS_PERMISSION) && !scoped.hasInference) {
    errors.push(`Token must include ${INFERENCE_PROVIDERS_PERMISSION}.`);
  }
  for (const permission of globalPermissions) {
    if (permission !== INFERENCE_PROVIDERS_PERMISSION) {
      errors.push(`Unexpected global permission on inference token: ${permission}.`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    username: text(root["name"]),
    tokenName: text(accessToken["displayName"]),
    permissions: [INFERENCE_PROVIDERS_PERMISSION],
  };
}

function evaluateScopedInferencePermissions(
  fineGrained: JsonObject,
  errors: string[],
): { hasInference: boolean } {
  let hasInference = false;
  for (const scope of array(fineGrained["scoped"])) {
    const scoped = asRecord(scope);
    const permissions = strings(scoped["permissions"]);
    if (
      isUserScope(asRecord(scoped["entity"])) &&
      permissions.length === 1 &&
      permissions[0] === INFERENCE_PROVIDERS_PERMISSION
    ) {
      hasInference = true;
    } else {
      errors.push(`Unexpected scoped permission on inference token: ${scopeLabel(scoped)}.`);
    }
  }
  return { hasInference };
}

function isUserScope(entity: JsonObject): boolean {
  const type = text(entity["type"]);
  return type === "user" || type === "users";
}

function scopeLabel(scope: JsonObject): string {
  const entity = asRecord(scope["entity"]);
  const kind = text(entity["type"]) || "unknown";
  const name = text(entity["name"]) || text(entity["id"]) || "unknown";
  const permissions = strings(scope["permissions"]);
  return `${permissions.join(",") || "unknown"} on ${kind}:${name}`;
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
