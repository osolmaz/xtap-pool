import { HUB_URL } from "@huggingface/hub";

export type HubClient = {
  accessToken: string;
  hubUrl?: string;
  fetchFn?: typeof fetch;
};

export type HubRepo = { type: "bucket" | "dataset" | "space"; name: string };

type JsonObject = Record<string, unknown>;

export async function getSpaceVariables(
  client: HubClient,
  spaceRepo: string,
): Promise<ReadonlyMap<string, string>> {
  const payload = await hubRequestJson(client, `/api/spaces/${spaceRepo}/variables`, {
    method: "GET",
  });
  return parseSpaceVariables(payload);
}

export async function setSpaceVariable(
  client: HubClient,
  spaceRepo: string,
  key: string,
  value: string,
): Promise<void> {
  await hubRequest(client, `/api/spaces/${spaceRepo}/variables`, {
    method: "POST",
    body: JSON.stringify({ key, value }),
  });
}

export async function deleteSpaceVariable(
  client: HubClient,
  spaceRepo: string,
  key: string,
): Promise<void> {
  await hubRequest(client, `/api/spaces/${spaceRepo}/variables/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

export async function setSpaceSecret(
  client: HubClient,
  spaceRepo: string,
  key: string,
  value: string,
): Promise<void> {
  await hubRequest(client, `/api/spaces/${spaceRepo}/secrets`, {
    method: "POST",
    body: JSON.stringify({ key, value }),
  });
}

export async function getSpaceSecrets(
  client: HubClient,
  spaceRepo: string,
): Promise<ReadonlySet<string>> {
  const response = await hubRequest(client, `/api/spaces/${spaceRepo}/secrets`, {
    method: "GET",
  });
  const payload: unknown = await response.json();
  return parseSpaceSecrets(payload);
}

export async function getRepoPrivateState(client: HubClient, repo: HubRepo): Promise<boolean> {
  const payload = await hubRequestJson(client, `/api/${repo.type}s/${repo.name}`, {
    method: "GET",
  });
  if (typeof payload["private"] !== "boolean") {
    throw new Error(`Hub ${repo.type} ${repo.name} did not report visibility.`);
  }
  return payload["private"];
}

export async function pauseSpaceRuntime(client: HubClient, spaceRepo: string): Promise<void> {
  const runtime = await hubRequestJson(client, `/api/spaces/${spaceRepo}/pause`, {
    method: "POST",
  });
  assertSpaceStage(runtime, "PAUSED");
}

export async function restartSpaceRuntime(client: HubClient, spaceRepo: string): Promise<void> {
  await hubRequest(client, `/api/spaces/${spaceRepo}/restart`, { method: "POST" });
}

export async function waitForSpaceStage(
  client: HubClient,
  spaceRepo: string,
  expected: "PAUSED" | "RUNNING",
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  for (;;) {
    const runtime = await hubRequestJson(client, `/api/spaces/${spaceRepo}/runtime`, {
      method: "GET",
    });
    if (runtime["stage"] === expected) return;
    if (Date.now() >= deadline) {
      throw new Error(`Space ${spaceRepo} did not reach ${expected} before the deadline.`);
    }
    await delay(pollIntervalMs);
  }
}

export function parseSpaceVariables(payload: unknown): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(asRecord(payload))) {
    const variable = asRecord(value);
    if (typeof value === "string") result.set(key, value);
    else if (typeof variable["value"] === "string") result.set(key, variable["value"]);
  }
  return result;
}

export function parseSpaceSecrets(payload: unknown): ReadonlySet<string> {
  const result = new Set<string>();
  for (const item of arrayPayload(payload)) {
    const secret = asRecord(item);
    if (typeof secret["key"] === "string") result.add(secret["key"]);
  }
  const root = asRecord(payload);
  if (!("secrets" in root)) {
    for (const key of Object.keys(root)) result.add(key);
  }
  return result;
}

function arrayPayload(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  const secrets = root["secrets"];
  if (Array.isArray(secrets)) return secrets;
  return [];
}

async function hubRequest(client: HubClient, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${client.accessToken}`);
  headers.set("content-type", "application/json");
  const response = await (client.fetchFn ?? fetch)(`${client.hubUrl ?? HUB_URL}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    throw new Error(`Hub request failed (${String(response.status)}): ${await response.text()}`);
  }
  return response;
}

async function hubRequestJson(
  client: HubClient,
  path: string,
  init: RequestInit,
): Promise<JsonObject> {
  const response = await hubRequest(client, path, init);
  const payload: unknown = await response.json();
  return asRecord(payload);
}

function assertSpaceStage(runtime: JsonObject, expected: string): void {
  if (runtime["stage"] !== expected) {
    throw new Error(`Space runtime did not report ${expected}.`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asRecord(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
