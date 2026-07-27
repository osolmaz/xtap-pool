type JsonObject = Record<string, unknown>;

const FINE_GRAINED_ROLE = "fineGrained";
const INFERENCE_PROVIDERS_PERMISSION = "inference.serverless.write";
const INFERENCE_ENDPOINTS_PERMISSION = "inference.endpoints.infer.write";
const ALLOWED_INFERENCE_PERMISSIONS = new Set([
  INFERENCE_PROVIDERS_PERMISSION,
  INFERENCE_ENDPOINTS_PERMISSION,
]);

export type InferenceCredentialReadiness =
  | { credential: "ok" }
  | { credential: "not_required" }
  | { credential: "missing"; error: string }
  | { credential: "invalid"; error: string }
  | { credential: "unknown"; error: string };

export async function checkInferenceCredential(params: {
  enabled: boolean;
  token: string | undefined;
  fetchFn?: typeof fetch;
}): Promise<InferenceCredentialReadiness> {
  if (!params.enabled) return { credential: "not_required" };
  if (params.token === undefined) {
    return {
      credential: "missing",
      error: "INFERENCE_TOKEN is required when enrichment is enabled.",
    };
  }
  try {
    const response = await (params.fetchFn ?? fetch)("https://huggingface.co/api/whoami-v2", {
      headers: { authorization: `Bearer ${params.token}` },
    });
    if (!response.ok) {
      return tokenStatusError(response.status);
    }
    const errors = inferenceTokenErrors(await response.json());
    return errors.length === 0
      ? { credential: "ok" }
      : { credential: "invalid", error: errors.join(" ") };
  } catch (error) {
    return { credential: "unknown", error: errorMessage(error) };
  }
}

export function inferenceCredentialOk(status: InferenceCredentialReadiness): boolean {
  return status.credential === "ok" || status.credential === "not_required";
}

function inferenceTokenErrors(payload: unknown): string[] {
  const root = asRecord(payload);
  const accessToken = asRecord(asRecord(root["auth"])["accessToken"]);
  const fineGrained = asRecord(accessToken["fineGrained"]);
  const role = text(accessToken["role"]);
  const errors =
    role === FINE_GRAINED_ROLE
      ? []
      : [`INFERENCE_TOKEN role is '${role || "unknown"}', expected fine-grained.`];
  const globalHasInference = evaluateGlobalInferencePermissions(fineGrained, errors);
  const scoped = evaluateScopedInferencePermissions(fineGrained, errors);
  if (!globalHasInference && !scoped.hasInference) {
    errors.push(`INFERENCE_TOKEN must include ${INFERENCE_PROVIDERS_PERMISSION}.`);
  }
  return errors;
}

function evaluateGlobalInferencePermissions(fineGrained: JsonObject, errors: string[]): boolean {
  let hasInference = false;
  for (const permission of strings(fineGrained["global"])) {
    if (ALLOWED_INFERENCE_PERMISSIONS.has(permission)) {
      if (permission === INFERENCE_PROVIDERS_PERMISSION) hasInference = true;
    } else {
      errors.push(`Unexpected global permission on INFERENCE_TOKEN: ${permission}.`);
    }
  }
  return hasInference;
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
      permissions.length > 0 &&
      permissions.every((permission) => ALLOWED_INFERENCE_PERMISSIONS.has(permission))
    ) {
      if (permissions.includes(INFERENCE_PROVIDERS_PERMISSION)) hasInference = true;
    } else {
      errors.push(`Unexpected scoped permission on INFERENCE_TOKEN: ${scopeLabel(scoped)}.`);
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
  return `${permissions.join(", ") || "unknown"} on ${kind}:${name}`;
}

function tokenStatusError(status: number): InferenceCredentialReadiness {
  const error = `Hugging Face rejected INFERENCE_TOKEN (${String(status)}).`;
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
